create function fleet_internal.track_driver_reported_trailer()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  driver uuid := fleet_internal.workflow_driver(auth.uid(),new.fleet_id);
  report jsonb;
  next_trailer text;
begin
  if driver is null or (driver is distinct from new.driver_id and driver is distinct from new.second_driver_id) then
    return new;
  end if;
  if new.progress->'yardPickedUpAt' is distinct from old.progress->'yardPickedUpAt' then
    select h.trailer into next_trailer from fleet_internal.driver_yard_handoffs h
    where h.load_id=new.id and h.offered_driver=driver and h.picked_up_at is not null;
  else
    select new.progress #> array['stops',stop.stop_key,'driverReport']
    into report
    from fleet_internal.driver_assigned_stops(new,driver) stop
    where new.progress #> array['stops',stop.stop_key,'driverReport'] is not null
      and (new.progress #> array['stops',stop.stop_key,'driverReport'])
        is distinct from (old.progress #> array['stops',stop.stop_key,'driverReport'])
    order by stop.sequence_no desc limit 1;
    next_trailer := case
      when report->>'bobtail'='true' then 'Bobtail'
      when nullif(report->>'pickedTrailer','') is not null then report->>'pickedTrailer'
      when nullif(report->>'trailer','') is not null then report->>'trailer'
      when nullif(report->>'droppedTrailer','') is not null then 'Bobtail'
    end;
  end if;
  if next_trailer is not null then
    update public.fleet_dispatch_drivers d set assigned_trailer_number=next_trailer
    where d.fleet_id=new.fleet_id and d.id=driver and d.link_active
      and d.assigned_trailer_number is distinct from next_trailer;
  end if;
  return new;
end;
$$;
revoke all on function fleet_internal.track_driver_reported_trailer() from public, anon, authenticated;

create trigger track_driver_reported_trailer
after update of progress on public.fleet_dispatch_loads for each row
when (old.progress->'stops' is distinct from new.progress->'stops'
  or old.progress->'yardPickedUpAt' is distinct from new.progress->'yardPickedUpAt')
execute function fleet_internal.track_driver_reported_trailer();

create or replace function fleet_internal.driver_incoming_trailer(
  load public.fleet_dispatch_loads, assigned uuid, target_stop text
)
returns text language sql stable set search_path = ''
as $$
  select case when (load).progress ? 'dispatchTrailerOverride' then (load).progress ->> 'dispatchTrailerOverride'
    else coalesce(
    (select
      case when (report.value ->> 'bobtail')='true' then ''
        when numbers.picked is not null then numbers.picked
        when numbers.dropped is not null and
          (numbers.trailer is null or upper(numbers.trailer)=upper(numbers.dropped)) then ''
        else numbers.trailer
      end
      from fleet_internal.driver_assigned_stops(load,assigned) stop
      cross join lateral (select (load).progress #> array['stops',stop.stop_key,'driverReport'] as value) report
      cross join lateral (select nullif(btrim(report.value ->> 'trailer'),'') as trailer,
        nullif(btrim(report.value ->> 'pickedTrailer'),'') as picked,
        nullif(btrim(report.value ->> 'droppedTrailer'),'') as dropped) numbers
      where stop.sequence_no < (select s.sequence_no from fleet_internal.workflow_stops((load).details) s
          where s.stop_key=target_stop limit 1)
        and (load).progress #>> array['stops',stop.stop_key,'completedAt'] is not null
        and ((report.value ->> 'bobtail')='true' or coalesce(numbers.trailer,numbers.picked,numbers.dropped) is not null)
      order by stop.sequence_no desc limit 1),
    (select yard.trailer from fleet_internal.driver_yard_handoffs yard where yard.load_id=(load).id
      and yard.offered_driver=assigned and yard.confirmed_at is not null),
    (select case when lower(d.assigned_trailer_number)='bobtail' then '' else d.assigned_trailer_number end
      from public.fleet_dispatch_drivers d where d.fleet_id=(load).fleet_id and d.id=assigned and d.link_active
        and ((load).details->>'trailerFromDriver'='yes' or assigned is distinct from (load).driver_id)),
    case when assigned=(load).driver_id then nullif(btrim((load).details ->> 'trailerNumber'),'') end,
    (select case when lower(d.assigned_trailer_number)='bobtail' then '' else d.assigned_trailer_number end
      from public.fleet_dispatch_drivers d where d.fleet_id=(load).fleet_id and d.id=assigned and d.link_active)
  ) end;
$$;

create table fleet_internal.driver_load_odometer (
  load_id uuid not null references public.fleet_dispatch_loads(id) on delete cascade,
  fleet_id text not null,
  driver_id uuid not null,
  truck_number text not null check (char_length(btrim(truck_number)) between 1 and 40),
  start_odometer bigint not null check (start_odometer between 0 and 99999999),
  end_odometer bigint check (end_odometer between start_odometer and 99999999),
  started_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (load_id,driver_id),
  foreign key (fleet_id,driver_id) references public.fleet_dispatch_drivers(fleet_id,id) on delete cascade
);
create index driver_load_odometer_timeline on fleet_internal.driver_load_odometer (fleet_id,driver_id,started_at,load_id);
revoke all on fleet_internal.driver_load_odometer from public, anon, authenticated;

create function fleet_internal.driver_mileage_rows(target_fleet text, target_driver uuid)
returns table(load_id uuid, pro text, truck_number text, start_odometer bigint, end_odometer bigint, loaded bigint,
  empty bigint, started_at timestamptz, updated_at timestamptz)
language sql stable set search_path = ''
as $$
  with readings as materialized (
    select m.*
    from fleet_internal.driver_load_odometer m
    where m.fleet_id=target_fleet and m.driver_id=target_driver
  ), timeline as (
    select m.load_id,m.truck_number,m.end_odometer,m.started_at from readings m
    union all
    select l.id,null,null,activity.started_at
    from public.fleet_dispatch_loads l
    cross join lateral (
      select min(coalesce(l.progress #>> array['stops',s.stop_key,'arrivalAt'],
        l.progress #>> array['stops',s.stop_key,'completedAt'])::timestamptz) as first_stop
      from fleet_internal.driver_assigned_stops(l,target_driver) s
    ) stops
    cross join lateral (select coalesce(stops.first_stop,
      case when l.status='completed' then coalesce((l.progress->>'completedAt')::timestamptz,l.updated_at) end) as started_at) activity
    where l.fleet_id=target_fleet and target_driver in (l.driver_id,l.second_driver_id)
      and l.status in ('current','completed')
      and l.progress #>> array['driverResponses',target_driver::text,'decision'] is distinct from 'rejected'
      and activity.started_at>=(select min(m.started_at) from readings m)
      and not exists(select 1 from readings m where m.load_id=l.id)
  ), ordered as (
    select t.load_id,lag(t.truck_number) over ordered_loads as previous_truck,
      lag(t.end_odometer) over ordered_loads as previous_end
    from timeline t window ordered_loads as (order by t.started_at,t.load_id)
  )
  select m.load_id,l.pro_number::text,m.truck_number,m.start_odometer,m.end_odometer,m.end_odometer-m.start_odometer,
    case when m.truck_number=o.previous_truck and m.start_odometer>=o.previous_end then m.start_odometer-o.previous_end end,
    m.started_at,m.updated_at
  from readings m join public.fleet_dispatch_loads l on l.id=m.load_id join ordered o on o.load_id=m.load_id;
$$;
revoke all on function fleet_internal.driver_mileage_rows(text,uuid) from public, anon, authenticated;

create function fleet_internal.driver_operational_mileage(action text, target_load uuid, readings jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load_row public.fleet_dispatch_loads%rowtype;
  driver uuid;
  entry fleet_internal.driver_load_odometer%rowtype;
  truck text := nullif(upper(btrim(readings->>'truck_number')),'');
  entry_start text := nullif(btrim(readings->>'start_odometer'),'');
  entry_end text := nullif(btrim(readings->>'end_odometer'),'');
  finish_allowed boolean;
  first_arrival timestamptz;
  suggested_truck text;
begin
  if actor is null or action is null or action not in ('read','save') then
    raise exception 'Sign in as the assigned driver.' using errcode='42501';
  end if;
  if action='save' then
    perform pg_advisory_xact_lock(hashtextextended('rigtracker:driver-load:'||actor::text,0));
    select * into load_row from public.fleet_dispatch_loads l where l.id=target_load for update;
  else
    select * into load_row from public.fleet_dispatch_loads l where l.id=target_load;
  end if;
  driver := fleet_internal.workflow_driver(actor,load_row.fleet_id);
  if driver is null or (driver is distinct from load_row.driver_id and driver is distinct from load_row.second_driver_id)
    or load_row.status not in ('current','completed')
    or load_row.progress #>> array['driverResponses',driver::text,'decision'] is distinct from 'accepted' then
    raise exception 'Accept the assignment to access its mileage.' using errcode='42501';
  end if;

  select m.* into entry from fleet_internal.driver_load_odometer m
  where m.load_id=target_load and m.driver_id=driver;
  select load_row.status='completed' or
      (count(*)>0 and bool_and(load_row.progress #>> array['stops',s.stop_key,'completedAt'] is not null)),
    min((load_row.progress #>> array['stops',s.stop_key,'arrivalAt'])::timestamptz)
  into finish_allowed,first_arrival
  from fleet_internal.driver_assigned_stops(load_row,driver) s;

  if action='save' then
    if not finish_allowed and exists(select 1 from fleet_internal.driver_load_queue(actor) q
        where q.load_id=target_load and q.queue_position>1) then
      raise exception 'Finish your current load before logging mileage for this load.' using errcode='55000';
    end if;
    if truck is null or char_length(truck)>40 or entry_start is null or entry_start !~ '^[0-9]{1,8}$'
      or (entry_end is not null and entry_end !~ '^[0-9]{1,8}$') then
      raise exception 'Enter a truck number and valid whole-mile odometer readings.' using errcode='22023';
    end if;
    if entry_end is not null and (not finish_allowed or entry_end::bigint<entry_start::bigint) then
      raise exception 'Enter an ending reading at or above the start after finishing your stops.' using errcode='22023';
    end if;
    if entry.start_odometer is not null and entry.end_odometer is not null and entry_end is null then
      raise exception 'Enter the ending odometer reading.' using errcode='22023';
    end if;
    if entry.updated_at is distinct from (readings->>'updated_at')::timestamptz then
      raise exception 'The mileage was updated in another session. Reopen Load Info and try again.' using errcode='40001';
    end if;
    insert into fleet_internal.driver_load_odometer
      (load_id,fleet_id,driver_id,truck_number,start_odometer,end_odometer,started_at)
    values (target_load,load_row.fleet_id,driver,truck,entry_start::bigint,entry_end::bigint,
      coalesce(first_arrival,clock_timestamp()))
    on conflict (load_id,driver_id) do update set truck_number=excluded.truck_number,start_odometer=excluded.start_odometer,
      end_odometer=excluded.end_odometer,updated_at=clock_timestamp();
  end if;

  select coalesce(case when load_row.driver_id=driver then nullif(btrim(load_row.details->>'truckNumber'),'') end,
    d.assigned_truck_number) into suggested_truck
  from public.fleet_dispatch_drivers d where d.fleet_id=load_row.fleet_id and d.id=driver;

  return jsonb_build_object('truck',suggested_truck,'can_finish',finish_allowed,
    'reading',(select to_jsonb(m) from fleet_internal.driver_mileage_rows(load_row.fleet_id,driver) m where m.load_id=target_load));
end;
$$;

create function public.driver_operational_mileage(action text, target_load uuid, readings jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.driver_operational_mileage(action,target_load,readings);
$$;
revoke all on function fleet_internal.driver_operational_mileage(text,uuid,jsonb),
  public.driver_operational_mileage(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.driver_operational_mileage(text,uuid,jsonb),
  public.driver_operational_mileage(text,uuid,jsonb) to authenticated;

create function fleet_internal.fleet_driver_tracking(target_fleet text, target_driver uuid, section text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
begin
  if not fleet_internal.driver_profile_access(target_fleet,null) then
    raise exception 'Driver profile access is required.' using errcode='42501';
  end if;
  if section='pay_scale' and (fleet_internal.office_has_permission(target_fleet,'dispatch')
      or fleet_internal.driver_profile_access(target_fleet,'driver_pay_settlements')
      or fleet_internal.office_has_permission(target_fleet,'payroll')) then
    return (select jsonb_build_object('method',d.pay_method,'split_percent',d.split_percent,
        'mile_rate',d.mile_rate,'empty_mile_rate',d.empty_mile_rate)
      from public.fleet_dispatch_drivers d where d.fleet_id=target_fleet and d.id=target_driver);
  end if;
  if section='mileage' and (fleet_internal.office_has_permission(target_fleet,'dispatch')
      or fleet_internal.driver_profile_access(target_fleet,'driver_history')) then
    return (
      with readings as materialized (select * from fleet_internal.driver_mileage_rows(target_fleet,target_driver)),
      totals as (select sum(r.loaded) as loaded,sum(r.empty) as empty from readings r)
      select jsonb_build_object('loaded',totals.loaded,'empty',totals.empty,
        'percent',case when totals.loaded>=0 and totals.empty>=0 and totals.loaded+totals.empty>0
          then round(100*totals.loaded/(totals.loaded+totals.empty),1) end,
        'recent',coalesce((select jsonb_agg(to_jsonb(m) order by m.started_at desc,m.load_id desc)
          from (select * from readings order by started_at desc,load_id desc limit 50) m),'[]'))
      from totals
    );
  end if;
  raise exception 'You do not have access to this driver profile tab.' using errcode='42501';
end;
$$;

create function public.fleet_driver_tracking(target_fleet text, target_driver uuid, section text)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select fleet_internal.fleet_driver_tracking(target_fleet,target_driver,section);
$$;
revoke all on function fleet_internal.fleet_driver_tracking(text,uuid,text),
  public.fleet_driver_tracking(text,uuid,text) from public, anon, authenticated;
grant execute on function fleet_internal.fleet_driver_tracking(text,uuid,text),
  public.fleet_driver_tracking(text,uuid,text) to authenticated;
