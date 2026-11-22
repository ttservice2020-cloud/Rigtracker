create table public.fleet_equipment (
  id uuid primary key default gen_random_uuid(),
  fleet_id text not null references public.fleets(id) on delete cascade,
  unit_number text not null check (unit_number=btrim(unit_number) and char_length(unit_number) between 1 and 40),
  equipment_type text not null check (equipment_type in ('truck','trailer')),
  vin text not null check (vin ~ '^[A-Z0-9-]{1,32}$'),
  make text check (char_length(make)<=80),
  model text check (char_length(model)<=80),
  model_year smallint check (model_year between 1900 and 2199),
  plate text check (char_length(plate)<=32),
  next_pm date,
  inspection_date date,
  out_of_service boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);

create unique index fleet_equipment_unit_key on public.fleet_equipment (fleet_id,equipment_type,upper(unit_number));
create unique index fleet_equipment_vin_key on public.fleet_equipment (fleet_id,vin);
create index fleet_equipment_list on public.fleet_equipment (fleet_id,unit_number,id);

alter table public.fleet_equipment enable row level security;
revoke all on public.fleet_equipment from public, anon, authenticated;
grant select on public.fleet_equipment to authenticated;
grant insert (id,fleet_id,unit_number,equipment_type,vin,make,model,model_year,plate,next_pm,inspection_date) on public.fleet_equipment to authenticated;
grant update (unit_number,equipment_type,vin,make,model,model_year,plate,next_pm,inspection_date) on public.fleet_equipment to authenticated;

create policy fleet_equipment_read on public.fleet_equipment for select to authenticated
  using (fleet_internal.office_has_permission(fleet_id,'assets') or fleet_internal.office_has_permission(fleet_id,'dispatch'));
create policy fleet_equipment_add on public.fleet_equipment for insert to authenticated
  with check (fleet_internal.office_has_permission(fleet_id,'assets') or fleet_internal.office_has_permission(fleet_id,'dispatch'));
create policy fleet_equipment_edit on public.fleet_equipment for update to authenticated
  using (fleet_internal.office_has_permission(fleet_id,'assets') or fleet_internal.office_has_permission(fleet_id,'dispatch'))
  with check (fleet_internal.office_has_permission(fleet_id,'assets') or fleet_internal.office_has_permission(fleet_id,'dispatch'));

create table fleet_internal.fleet_trailer_unit_aliases (
  equipment_id uuid not null references public.fleet_equipment(id) on delete cascade,
  fleet_id text not null,
  unit_number text not null,
  retired_at timestamptz not null,
  active_after timestamptz,
  primary key (equipment_id, retired_at)
);
create index fleet_trailer_alias_history on fleet_internal.fleet_trailer_unit_aliases (fleet_id,unit_number,retired_at desc);
revoke all on fleet_internal.fleet_trailer_unit_aliases from public, anon, authenticated;

create function fleet_internal.revise_equipment()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  if old.equipment_type='trailer' and (upper(new.unit_number)<>upper(old.unit_number) or new.equipment_type<>old.equipment_type) then
    insert into fleet_internal.fleet_trailer_unit_aliases(equipment_id,fleet_id,unit_number,retired_at,active_after)
    values(old.id,old.fleet_id,upper(old.unit_number),new.updated_at,(
      select max(a.retired_at) from fleet_internal.fleet_trailer_unit_aliases a
      where a.fleet_id=old.fleet_id and a.unit_number=upper(old.unit_number)
    ));
  end if;
  if new.unit_number is distinct from old.unit_number and new.equipment_type=old.equipment_type then
    if old.equipment_type='truck' then
      update public.fleet_dispatch_drivers d set assigned_truck_number=new.unit_number
      where d.fleet_id=old.fleet_id and d.link_active and upper(d.assigned_truck_number)=upper(old.unit_number);
    elsif old.equipment_type='trailer' then
      update public.fleet_dispatch_drivers d set assigned_trailer_number=new.unit_number
      where d.fleet_id=old.fleet_id and d.link_active and upper(d.assigned_trailer_number)=upper(old.unit_number);
    end if;
  end if;

  return new;
end;
$$;
revoke all on function fleet_internal.revise_equipment() from public, anon, authenticated;

create trigger revise_equipment before update on public.fleet_equipment
for each row execute function fleet_internal.revise_equipment();

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('fleet-equipment-documents','fleet-equipment-documents',false,10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']);

create function fleet_internal.equipment_document_access(object_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select cardinality(string_to_array(object_name,'/'))=3 and split_part(object_name,'/',3)<>''
    and exists (
      select 1 from public.fleet_equipment e
      where e.fleet_id=split_part(object_name,'/',1)
        and e.id=case when split_part(object_name,'/',2) ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          then split_part(object_name,'/',2)::uuid end
        and (fleet_internal.office_has_permission(e.fleet_id,'assets') or fleet_internal.office_has_permission(e.fleet_id,'dispatch'))
    );
$$;
revoke all on function fleet_internal.equipment_document_access(text) from public, anon, authenticated;
grant execute on function fleet_internal.equipment_document_access(text) to authenticated;

create policy equipment_documents_read on storage.objects for select to authenticated
  using (bucket_id='fleet-equipment-documents' and fleet_internal.equipment_document_access(name));
create policy equipment_documents_upload on storage.objects for insert to authenticated
  with check (bucket_id='fleet-equipment-documents' and fleet_internal.equipment_document_access(name));

create function fleet_internal.expected_load_truck(load_row public.fleet_dispatch_loads, driver uuid)
returns text language sql stable set search_path = ''
as $$
  select coalesce(
    case when driver=(load_row).driver_id and (load_row).details->>'truckFromDriver' is distinct from 'yes'
      then nullif(btrim((load_row).details->>'truckNumber'),'') end,
    d.assigned_truck_number,
    case when driver=(load_row).driver_id then nullif(btrim((load_row).details->>'truckNumber'),'') end)
  from public.fleet_dispatch_drivers d where d.id=driver and d.fleet_id=(load_row).fleet_id;
$$;
revoke all on function fleet_internal.expected_load_truck(public.fleet_dispatch_loads,uuid) from public, anon, authenticated;

create or replace function fleet_internal.driver_operational_mileage(action text, target_load uuid, readings jsonb)
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

  suggested_truck := case when finish_allowed then coalesce(entry.truck_number,
    case when load_row.driver_id=driver then nullif(btrim(load_row.details->>'truckNumber'),'') end)
    else fleet_internal.expected_load_truck(load_row,driver) end;

  if action='save' then
    if not finish_allowed and exists(select 1 from fleet_internal.driver_load_queue(actor) q
        where q.load_id=target_load and q.queue_position>1) then
      raise exception 'Finish your current load before logging mileage for this load.' using errcode='55000';
    end if;
    if truck is null or char_length(truck)>40 or entry_start is null or entry_start !~ '^[0-9]{1,8}$'
      or (entry_end is not null and entry_end !~ '^[0-9]{1,8}$') then
      raise exception 'Enter a truck number and valid whole-mile odometer readings.' using errcode='22023';
    end if;
    if suggested_truck is not null and truck<>upper(suggested_truck) then
      raise exception 'Truck mismatch. Dispatch assigned truck %.',suggested_truck using errcode='22023';
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

  return jsonb_build_object('truck',suggested_truck,'can_finish',finish_allowed,
    'reading',(select to_jsonb(m) from fleet_internal.driver_mileage_rows(load_row.fleet_id,driver) m where m.load_id=target_load));
end;
$$;

create or replace function fleet_internal.track_driver_reported_trailer()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  driver uuid := fleet_internal.workflow_driver(auth.uid(),new.fleet_id);
  report jsonb;
  next_trailer text;
  report_stop text;
  arrival_trailer text;
begin
  if driver is null or (driver is distinct from new.driver_id and driver is distinct from new.second_driver_id) then
    return new;
  end if;
  if new.progress->'yardPickedUpAt' is distinct from old.progress->'yardPickedUpAt' then
    select h.trailer into next_trailer from fleet_internal.driver_yard_handoffs h
    where h.load_id=new.id and h.offered_driver=driver and h.picked_up_at is not null;
  else
    select new.progress #> array['stops',stop.stop_key,'driverReport'],stop.stop_key
    into report,report_stop
    from fleet_internal.driver_assigned_stops(new,driver) stop
    where new.progress #> array['stops',stop.stop_key,'driverReport'] is not null
      and (new.progress #> array['stops',stop.stop_key,'driverReport'])
        is distinct from (old.progress #> array['stops',stop.stop_key,'driverReport'])
    order by stop.sequence_no desc limit 1;
    if nullif(report->>'droppedTrailer','') is not null then
      arrival_trailer := case
        when old.details->>'trailerDrop'='yes' and old.details->>'trailerDropStopId'=report_stop
          then nullif(btrim(old.details->>'trailerDropNumber'),'') end;
      arrival_trailer := coalesce(arrival_trailer,case when old.progress ? 'dispatchTrailerOverride'
        then old.progress->>'dispatchTrailerOverride'
        else old.progress #>> array['stops',report_stop,'arrivalTrailer'] end);
      if nullif(arrival_trailer,'') is not null and upper(arrival_trailer)<>upper(report->>'droppedTrailer') then
        raise exception 'The drop trailer must match your arrival trailer %.',arrival_trailer using errcode='22023';
      end if;
      if nullif(report->>'trailer','') is not null and nullif(report->>'pickedTrailer','') is null then
        raise exception 'Enter the trailer pickup number if you are leaving with a different trailer.' using errcode='22023';
      end if;
    end if;
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

create table public.fleet_equipment_maintenance (
  id uuid primary key default gen_random_uuid(),
  equipment_id uuid not null references public.fleet_equipment(id) on delete cascade,
  kind text not null check (kind in ('out_of_service','maintenance')),
  note text not null check (char_length(btrim(note)) between 1 and 2000),
  created_at timestamptz not null default clock_timestamp(),
  cleared_at timestamptz,
  resolution text check (char_length(resolution)<=2000)
);
create index fleet_equipment_maintenance_history on public.fleet_equipment_maintenance (equipment_id,created_at desc);
create unique index fleet_equipment_one_open_issue on public.fleet_equipment_maintenance (equipment_id)
  where kind='out_of_service' and cleared_at is null;

alter table public.fleet_equipment_maintenance enable row level security;
revoke all on public.fleet_equipment_maintenance from public, anon, authenticated;
grant select on public.fleet_equipment_maintenance to authenticated;
create policy fleet_equipment_maintenance_read on public.fleet_equipment_maintenance for select to authenticated
  using (exists (select 1 from public.fleet_equipment e where e.id=equipment_id));

create function fleet_internal.manage_equipment_maintenance(action text, target_equipment uuid, note text, issue_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  unit public.fleet_equipment%rowtype;
  clean_note text := nullif(btrim(note),'');
begin
  select * into unit from public.fleet_equipment e where e.id=target_equipment for update;
  if not found or not fleet_internal.office_has_permission(unit.fleet_id,'assets') then
    raise exception 'Maintenance access is required.' using errcode='42501';
  end if;
  if char_length(clean_note)>2000 then
    raise exception 'Enter up to 2,000 characters.' using errcode='22023';
  end if;
  if action='add_record' and clean_note is not null then
    insert into public.fleet_equipment_maintenance (equipment_id,kind,note)
    values (unit.id,'maintenance',clean_note);
  elsif action='clear_issue' then
    update public.fleet_equipment_maintenance m set cleared_at=clock_timestamp(), resolution=clean_note
    where m.id=issue_id and m.equipment_id=unit.id and m.kind='out_of_service' and m.cleared_at is null;
    if not found then
      raise exception 'This issue was already cleared. Reopen the equipment record.' using errcode='22023';
    end if;
    update public.fleet_equipment set out_of_service=false where id=unit.id;
  else
    raise exception 'Enter a maintenance note.' using errcode='22023';
  end if;
end;
$$;

create function public.manage_equipment_maintenance(action text, target_equipment uuid, note text, issue_id uuid default null)
returns void language sql security invoker set search_path = ''
as $$
  select fleet_internal.manage_equipment_maintenance(action,target_equipment,note,issue_id);
$$;
revoke all on function fleet_internal.manage_equipment_maintenance(text,uuid,text,uuid),
  public.manage_equipment_maintenance(text,uuid,text,uuid) from public, anon, authenticated;
grant execute on function fleet_internal.manage_equipment_maintenance(text,uuid,text,uuid),
  public.manage_equipment_maintenance(text,uuid,text,uuid) to authenticated;

create function fleet_internal.driver_equipment_issue(action text, target_load uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load_row public.fleet_dispatch_loads%rowtype;
  unit public.fleet_equipment%rowtype;
  driver uuid;
  selected_type text := payload->>'equipment_type';
  truck text;
  trailer text;
  clean_note text := nullif(btrim(payload->>'note'),'');
begin
  if actor is null or action is null or action not in ('read','report') then
    raise exception 'Sign in as the assigned driver.' using errcode='42501';
  end if;
  if action='report' then
    perform pg_advisory_xact_lock(hashtextextended('rigtracker:driver-load:'||actor::text,0));
    select * into load_row from public.fleet_dispatch_loads l where l.id=target_load for update;
  else
    select * into load_row from public.fleet_dispatch_loads l where l.id=target_load;
  end if;
  driver := fleet_internal.workflow_driver(actor,load_row.fleet_id);
  if driver is null or (driver is distinct from load_row.driver_id and driver is distinct from load_row.second_driver_id)
    or load_row.status is distinct from 'current'
    or load_row.progress #>> array['driverResponses',driver::text,'decision'] is distinct from 'accepted' then
    raise exception 'Open your current assigned load to report equipment.' using errcode='42501';
  end if;
  if not exists (select 1 from fleet_internal.driver_load_queue(actor) q where q.load_id=target_load and q.queue_position=1) then
    raise exception 'Open your current assigned load to report equipment.' using errcode='55000';
  end if;
  truck := fleet_internal.expected_load_truck(load_row,driver);
  select case when load_row.progress ? 'dispatchTrailerOverride' then load_row.progress->>'dispatchTrailerOverride'
    when stop.data ? 'arrivalTrailer' then stop.data->>'arrivalTrailer'
    else fleet_internal.driver_incoming_trailer(load_row,driver,s.stop_key) end
  into trailer
  from fleet_internal.driver_assigned_stops(load_row,driver) s
  cross join lateral (select load_row.progress #> array['stops',s.stop_key] as data) stop
  where stop.data->>'completedAt' is null order by s.sequence_no limit 1;

  if action='report' then
    if selected_type is null or selected_type not in ('truck','trailer') or clean_note is null or char_length(clean_note)>2000 then
      raise exception 'Choose a unit and describe the issue in up to 2,000 characters.' using errcode='22023';
    end if;
    select e.* into unit from public.fleet_equipment e
    where e.fleet_id=load_row.fleet_id and e.equipment_type=selected_type and
      upper(e.unit_number)=upper(case selected_type when 'truck' then truck else trailer end)
      and e.id::text=payload->>'equipment_id'
    for update;
    if not found then
      raise exception 'This unit is no longer assigned. Refresh the load or contact Dispatch.' using errcode='22023';
    end if;
    if unit.out_of_service then
      raise exception 'This unit is already out of service. Maintenance can see its open issue.' using errcode='22023';
    end if;
    insert into public.fleet_equipment_maintenance (equipment_id,kind,note)
    values (unit.id,'out_of_service',clean_note);
    update public.fleet_equipment set out_of_service=true where id=unit.id;
  end if;

  return coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'type',e.equipment_type,'unit',e.unit_number,
    'out_of_service',e.out_of_service) order by e.equipment_type desc)
    from public.fleet_equipment e
    where e.fleet_id=load_row.fleet_id and upper(e.unit_number)=
      upper(case e.equipment_type when 'truck' then truck else trailer end)),'[]');
end;
$$;

create function public.driver_equipment_issue(action text, target_load uuid, payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.driver_equipment_issue(action,target_load,payload);
$$;
revoke all on function fleet_internal.driver_equipment_issue(text,uuid,jsonb),
  public.driver_equipment_issue(text,uuid,jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.driver_equipment_issue(text,uuid,jsonb),
  public.driver_equipment_issue(text,uuid,jsonb) to authenticated;

create function fleet_internal.fleet_equipment_assignments(target_fleet text)
returns table (name text, assigned_truck_number text, assigned_trailer_number text)
language sql stable security definer set search_path = ''
as $$
  select d.name,d.assigned_truck_number,d.assigned_trailer_number
  from public.fleet_dispatch_drivers d
  where d.fleet_id=target_fleet and d.link_active
    and (d.assigned_truck_number is not null or d.assigned_trailer_number is not null)
    and (fleet_internal.office_has_permission(target_fleet,'assets') or fleet_internal.office_has_permission(target_fleet,'dispatch'));
$$;

create function public.fleet_equipment_assignments(target_fleet text)
returns table (name text, assigned_truck_number text, assigned_trailer_number text)
language sql stable security invoker set search_path = ''
as $$
  select * from fleet_internal.fleet_equipment_assignments(target_fleet);
$$;
revoke all on function fleet_internal.fleet_equipment_assignments(text), public.fleet_equipment_assignments(text) from public, anon, authenticated;
grant execute on function fleet_internal.fleet_equipment_assignments(text), public.fleet_equipment_assignments(text) to authenticated;

create function fleet_internal.fleet_trailer_activity(target_equipment uuid, before_time timestamptz, before_load uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  unit public.fleet_equipment%rowtype;
begin
  select * into unit from public.fleet_equipment e where e.id=target_equipment and e.equipment_type='trailer';
  if not found or not (fleet_internal.office_has_permission(unit.fleet_id,'dispatch')
    or fleet_internal.office_has_permission(unit.fleet_id,'assets')) then
    raise exception 'Trailer access is required.' using errcode='42501';
  end if;

  return (
    with unit_numbers as materialized (
      select a.unit_number,a.active_after,a.retired_at
      from fleet_internal.fleet_trailer_unit_aliases a where a.equipment_id=unit.id
      union all
      select upper(unit.unit_number),max(a.retired_at),null
      from fleet_internal.fleet_trailer_unit_aliases a where a.fleet_id=unit.fleet_id and a.unit_number=upper(unit.unit_number)
    ), fleet_loads as materialized (
      select l.id,l.pro_number,l.return_of,l.status,l.assigned_at,l.updated_at,l.created_at,l.details,l.progress
      from public.fleet_dispatch_loads l where l.fleet_id=unit.fleet_id and l.status in ('current','completed')
    ), stops as (
      select l.id,l.status,s.info,s.kind,s.sequence_no,
        max(s.sequence_no) over (partition by l.id) as last_stop,
        l.progress #> array['stops',s.stop_key] as report
      from fleet_loads l cross join lateral fleet_internal.workflow_stops(l.details) s
    ), observations as materialized (
      select s.id, e.event_at, e.event_state, e.priority,
        nullif(concat_ws(' · ',nullif(s.info->>'company',''),nullif(s.info->>'address',''),
          nullif(concat_ws(', ',nullif(s.info->>'city',''),
            nullif(concat_ws(' ',nullif(s.info->>'state',''),nullif(s.info->>'zip','')),'')),'')),'') as place
      from stops s
      cross join lateral (values
        (s.report->>'arrivalTrailer',(s.report->>'arrivalAt')::timestamptz,'At stop',1),
        (coalesce(nullif(s.report #>> '{driverReport,droppedTrailer}',''),
          case when s.report #>> '{driverReport,bobtail}'='true' then s.report->>'arrivalTrailer' end),
          (s.report->>'completedAt')::timestamptz,'Dropped',2),
        (coalesce(nullif(s.report #>> '{driverReport,pickedTrailer}',''),s.report #>> '{driverReport,trailer}'),
          (s.report->>'completedAt')::timestamptz,
          case when s.status='current' and s.sequence_no<s.last_stop then 'In transit' else 'Departed' end,3)
      ) e(number,event_at,event_state,priority)
      where e.event_at is not null and exists (
        select 1 from unit_numbers n where n.unit_number=upper(btrim(e.number))
          and (n.active_after is null or e.event_at>n.active_after)
          and (n.retired_at is null or e.event_at<=n.retired_at))
      union all
      select l.id,h.picked_up_at,case when l.status='current' then 'In transit' else 'Yard pickup' end,4,
        concat_ws(' · ',h.yard,nullif(l.details->>'relayAddress',''),nullif(concat_ws(', ',
          nullif(l.details->>'relayCity',''),nullif(concat_ws(' ',nullif(l.details->>'relayState',''),
            nullif(l.details->>'relayZip','')),'')),''))
      from fleet_loads l join fleet_internal.driver_yard_handoffs h on h.load_id=l.id
      where h.picked_up_at is not null and exists (
        select 1 from unit_numbers n where n.unit_number=upper(btrim(h.trailer))
          and (n.active_after is null or h.picked_up_at>n.active_after)
          and (n.retired_at is null or h.picked_up_at<=n.retired_at))
    ), planned as materialized (
      select l.* from fleet_loads l
      where not exists (
        select 1 from jsonb_each(case when jsonb_typeof(l.progress->'stops')='object' then l.progress->'stops' else '{}' end) q
        where q.value->>'arrivalTrailer' is not null or q.value ? 'driverReport')
      and exists (
        select 1 from unit_numbers n where n.unit_number=upper(btrim(l.details->>'trailerNumber'))
          and (n.active_after is null or coalesce(l.assigned_at,l.created_at)>n.active_after)
          and (n.retired_at is null or coalesce(l.assigned_at,l.created_at)<=n.retired_at))
    ), last_observed as (
      select o.* from observations o order by o.event_at desc,o.priority desc,o.id limit 1
    ), location as (
      select o.place from observations o where o.place is not null
      order by o.event_at desc,o.priority desc,o.id limit 1
    ), connected as (
      select l.id,l.pro_number,l.return_of,o.event_state,o.event_at
      from last_observed o join fleet_loads l on l.id=o.id
      where l.status='current' and o.event_state in ('At stop','In transit','Departed')
      union all
      select p.id,p.pro_number,p.return_of,'Assigned',coalesce(p.assigned_at,p.created_at)
      from planned p where p.status='current' and not exists (
        select 1 from last_observed o where o.event_at>=coalesce(p.assigned_at,p.created_at))
    ), attached as (
      select c.* from connected c order by c.event_at desc,c.id limit 1
    ), next_pickup as (
      select l.id,l.pro_number as pro,l.return_of,string_agg(distinct d.name,', ' order by d.name) as drivers
      from fleet_loads l
      join public.fleet_dispatch_loads full_load on full_load.id=l.id
      join public.fleet_dispatch_drivers d on d.fleet_id=unit.fleet_id and d.id in (full_load.driver_id,full_load.second_driver_id)
      where l.status='current' and l.details->>'trailerPickup'='yes'
        and l.progress #>> array['driverResponses',d.id::text,'decision'] is distinct from 'rejected'
        and l.details->>'trailerPickupMode' is distinct from 'bobtail'
        and exists (
          select 1 from unit_numbers n where n.unit_number=upper(btrim(l.details->>'trailerPickupNumber'))
            and (n.active_after is null or coalesce(l.assigned_at,l.created_at)>n.active_after)
            and (n.retired_at is null or coalesce(l.assigned_at,l.created_at)<=n.retired_at))
        and exists (
          select 1 from fleet_internal.driver_assigned_stops(full_load,d.id) stop
          where stop.stop_key=l.details->>'trailerPickupStopId'
            and l.progress #>> array['stops',stop.stop_key,'completedAt'] is null)
      group by l.id,l.pro_number,l.return_of,l.assigned_at,l.created_at
      order by coalesce(l.assigned_at,l.created_at),l.id limit 1
    ), history as (
      select l.id,l.pro_number,l.return_of,l.updated_at
      from fleet_loads l
      where (exists(select 1 from observations o where o.id=l.id) or exists(select 1 from planned p where p.id=l.id))
        and not exists(select 1 from attached a where a.id=l.id)
        and (before_load is null or (l.updated_at,l.id)<(before_time,before_load))
      order by l.updated_at desc,l.id desc limit 26
    )
    select jsonb_build_object(
      'location',(select place from location),
      'status',coalesce((select event_state from attached),(select event_state from last_observed)),
      'current_load',(select jsonb_build_object('id',a.id,'pro',a.pro_number,'return_of',a.return_of) from attached a),
      'next_pickup',(select to_jsonb(p) from next_pickup p),
      'history',coalesce((select jsonb_agg(jsonb_build_object(
        'id',h.id,'pro',h.pro_number,'return_of',h.return_of,'updated_at',h.updated_at)
        order by h.updated_at desc,h.id desc) from history h),'[]')
    )
  );
end;
$$;

create function public.fleet_trailer_activity(target_equipment uuid, before_time timestamptz default null, before_load uuid default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select fleet_internal.fleet_trailer_activity(target_equipment,before_time,before_load);
$$;
revoke all on function fleet_internal.fleet_trailer_activity(uuid,timestamptz,uuid),
  public.fleet_trailer_activity(uuid,timestamptz,uuid) from public, anon, authenticated;
grant execute on function fleet_internal.fleet_trailer_activity(uuid,timestamptz,uuid),
  public.fleet_trailer_activity(uuid,timestamptz,uuid) to authenticated;
