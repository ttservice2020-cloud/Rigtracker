-- A relay can resume with its original driver without adding a second pay or assignment slot.
create function fleet_internal.relay_scheduled_driver(load public.fleet_dispatch_loads)
returns uuid language sql stable set search_path = ''
as $$
  select coalesce((load).second_driver_id,
    case when (load).progress #>> '{relay,resumeDriverId}'=(load).driver_id::text then (load).driver_id end);
$$;
revoke all on function fleet_internal.relay_scheduled_driver(public.fleet_dispatch_loads) from public, anon, authenticated;

create or replace function fleet_internal.relay_driver_active(load public.fleet_dispatch_loads, driver uuid)
returns boolean language sql stable set search_path = ''
as $$
  select case when (load).status is distinct from 'current'
      or (load).progress #>> '{relay,droppedAt}' is null then true
    else coalesce(fleet_internal.relay_scheduled_driver(load)=driver,false)
      and ((load).progress #>> '{relay,departedAt}' is not null
        or ((load).second_driver_id is not null and (load).progress->>'yardPickedUpAt' is not null)) end;
$$;

create or replace function fleet_internal.driver_assigned_stops(load public.fleet_dispatch_loads, assigned uuid)
returns table(stop_key text, kind text, sequence_no bigint, info jsonb)
language sql stable set search_path = ''
as $$
  select stop.stop_key, stop.kind, stop.sequence_no, stop.info
  from fleet_internal.workflow_stops((load).details) stop
  where ((load).driver_id=assigned and (coalesce(stop.info ->> 'driver1','true') <> 'false'
      or ((load).second_driver_id is null
        and (load).progress #>> '{relay,resumeDriverId}'=assigned::text
        and (load).progress #>> '{relay,departDriverId}'=assigned::text)))
    or ((load).second_driver_id=assigned and
      case when exists(select 1 from fleet_internal.driver_yard_handoffs yard
          where yard.load_id=(load).id and yard.confirmed_at is not null)
        then stop.kind='delivery'
        when (load).progress #>> '{relay,departedAt}' is not null and not exists (
          select 1 from fleet_internal.workflow_stops((load).details) assigned_stop
          where assigned_stop.info->>'driver2'='true')
          then stop.kind='delivery'
        else stop.info ->> 'driver2'='true' end);
$$;

create or replace function fleet_internal.assign_dispatch_relay_driver(
  target_load uuid, expected_updated_at timestamptz, editing_session uuid, next_driver uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load public.fleet_dispatch_loads%rowtype;
  driver_name text;
  resume boolean;
  new_progress jsonb;
begin
  select * into load from public.fleet_dispatch_loads
    where id=target_load and actor is not null and fleet_internal.office_has_permission(fleet_id,'dispatch')
    for update;
  if not found then raise exception 'Load unavailable in this fleet.' using errcode='42501'; end if;
  if not exists(select 1 from fleet_internal.dispatch_load_leases lease where lease.load_id=target_load
      and lease.holder=actor and lease.session_id=editing_session and lease.expires_at>clock_timestamp()) then
    raise exception 'Open this load for editing before assigning a driver.' using errcode='55P03';
  end if;
  if load.updated_at is distinct from expected_updated_at then
    raise exception 'This load changed. Try assigning the driver again.' using errcode='40001';
  end if;
  if load.status<>'current' or load.progress #>> '{relay,droppedAt}' is null
    or load.progress #>> '{relay,departedAt}' is not null or load.progress->>'yardPickedUpAt' is not null then
    raise exception 'Assign Driver 2 after the relay drop and before departure.' using errcode='22023';
  end if;
  resume := coalesce(next_driver=load.driver_id,false);
  select d.name into driver_name from public.fleet_dispatch_drivers d
    where d.fleet_id=load.fleet_id and d.id=next_driver and d.link_active;
  if not found or (resume and load.progress #>> '{relay,dropDriverId}' is distinct from next_driver::text) then
    raise exception 'Choose an eligible active driver in this fleet.' using errcode='22023';
  end if;
  if fleet_internal.relay_scheduled_driver(load)=next_driver then return to_jsonb(load); end if;
  new_progress := case when resume then jsonb_set(load.progress,'{relay,resumeDriverId}',to_jsonb(next_driver))
    else load.progress #- '{relay,resumeDriverId}' end;
  update public.fleet_dispatch_loads set second_driver_id=case when not resume then next_driver end,
    details=details || jsonb_build_object('secondDriverMode',case when resume then 'unknown' else 'assigned' end),
    progress=fleet_internal.append_load_note(new_progress,
      case when resume then 'Original driver scheduled to resume' else 'Relay driver assigned' end,
      driver_name,'Dispatch',clock_timestamp())
    where id=target_load returning * into load;
  return to_jsonb(load);
end;
$$;

create or replace function fleet_internal.dispatch_load_control(
  action text, target_id uuid, session_id uuid, report_id uuid, resolution text, note text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load public.fleet_dispatch_loads%rowtype;
  owned boolean;
  state_key text;
  report jsonb;
  new_progress jsonb;
  event_label text;
  relay_driver uuid;
  relay_driver_name text;
  relay_driver_truck text;
  driver_account uuid;
  note_text text := nullif(btrim(note),'');
  moment timestamptz := clock_timestamp();
begin
  if actor is null or session_id is null then raise exception 'Sign in to Dispatch.' using errcode='42501'; end if;
  select * into load from public.fleet_dispatch_loads where id=target_id for update;
  if not found or not fleet_internal.office_has_permission(load.fleet_id,'dispatch') then
    raise exception 'Load unavailable in this fleet.' using errcode='42501';
  end if;
  if action='release' then
    delete from fleet_internal.dispatch_load_leases lease
      where lease.load_id=target_id and lease.holder=actor and lease.session_id=dispatch_load_control.session_id;
    return '{}'::jsonb;
  end if;
  if action='acquire' then
    delete from fleet_internal.dispatch_load_leases lease
      where lease.load_id=target_id and lease.expires_at<=clock_timestamp();
    if exists(select 1 from fleet_internal.dispatch_load_leases lease
        where lease.load_id=target_id and lease.holder<>actor) then
      return jsonb_build_object('writable',false);
    end if;
    insert into fleet_internal.dispatch_load_leases(load_id,holder,session_id,expires_at)
      values(target_id,actor,dispatch_load_control.session_id,clock_timestamp()+interval '60 seconds')
      on conflict on constraint dispatch_load_leases_pkey do update set expires_at=excluded.expires_at;
    return jsonb_build_object('writable',found);
  end if;
  if action not in ('resolve_breakdown','add_note','report_traffic','clear_traffic','relay_drop','relay_depart') or action is null then
    raise exception 'Choose a supported load action.' using errcode='22023';
  end if;
  if char_length(note_text)>1000 then raise exception 'Enter a note up to 1,000 characters.' using errcode='22023'; end if;
  if action<>'add_note' and load.status<>'current' then raise exception 'Open an active load to update its status.' using errcode='22023'; end if;
  select exists(select 1 from fleet_internal.dispatch_load_leases lease where lease.load_id=target_id
    and lease.holder=actor and lease.session_id=dispatch_load_control.session_id and lease.expires_at>clock_timestamp()) into owned;
  if not owned then raise exception 'Open this load for editing before making changes.' using errcode='55P03'; end if;
  new_progress := load.progress;
  if action in ('relay_drop','relay_depart') then
    moment := clock_timestamp();
    if load.second_driver_id is null and coalesce(load.details->>'secondDriverMode','none') not in ('assigned','unknown')
      and btrim(concat_ws('',load.details->>'relayLocation',load.details->>'relayAddress',
        load.details->>'relayDate',load.details->>'relayDrop',load.details->>'relayPickup'))='' then
      raise exception 'Set up a load split before recording relay progress.' using errcode='22023';
    end if;
    report := coalesce(load.progress->'relay','{}'::jsonb);
    if report->>'departedAt' is not null or load.progress->>'yardPickedUpAt' is not null then
      raise exception 'This relay departure is already recorded.' using errcode='22023';
    end if;
    relay_driver := case when action='relay_drop' then load.driver_id
      else fleet_internal.relay_scheduled_driver(load) end;
    select d.name,nullif(btrim(d.assigned_truck_number),'') into relay_driver_name,relay_driver_truck
    from public.fleet_dispatch_drivers d where d.fleet_id=load.fleet_id and d.id=relay_driver;
    if action='relay_drop' then
      if report->>'droppedAt' is not null then
        raise exception 'The relay drop is already recorded.' using errcode='22023';
      end if;
      report := report || jsonb_build_object('droppedAt',moment,'dropDriverId',relay_driver,
        'dropDriver',relay_driver_name,'dropTruckNumber',fleet_internal.expected_load_truck(load,relay_driver));
      event_label := 'Relay drop recorded';
    else
      if report->>'droppedAt' is null then
        raise exception 'Record the relay drop before departing.' using errcode='22023';
      end if;
      if relay_driver is null then
        raise exception 'Assign Driver 2 before departing the relay.' using errcode='22023';
      end if;
      if load.second_driver_id is null then
        select link.profile_user_id into driver_account from public.rigtracker_fleet_links link
          where link.fleet_id=load.fleet_id and link.dispatch_driver_id=relay_driver and link.unlinked_at is null;
        if driver_account is not null then
          -- Driver actions take this lock before the load row. Avoid waiting while holding the row.
          if not pg_try_advisory_xact_lock(hashtextextended('rigtracker:driver-load:'||driver_account::text,0)) then
            raise exception 'The driver is updating a load. Try departing the relay again.' using errcode='55P03';
          end if;
          if exists(
            select 1 from fleet_internal.driver_load_queue(driver_account) queued
            join public.fleet_dispatch_loads other on other.id=queued.load_id
            join public.rigtracker_fleet_links link on link.fleet_id=other.fleet_id
              and link.profile_user_id=driver_account and link.unlinked_at is null
            where queued.queue_position=1 and other.id<>load.id and (
              (other.driver_id=link.dispatch_driver_id and other.progress->>'enRouteAt' is not null)
              or exists(select 1 from fleet_internal.driver_assigned_stops(other,link.dispatch_driver_id) stop
                where other.progress #>> array['stops',stop.stop_key,'arrivalAt'] is not null
                   or other.progress #>> array['stops',stop.stop_key,'completedAt'] is not null)
            )
          ) then
            raise exception 'Finish the driver’s current load before departing this relay.' using errcode='55000';
          end if;
        end if;
      end if;
      report := report || jsonb_build_object('departedAt',moment,'departDriverId',relay_driver,
        'departDriver',relay_driver_name,'departTruckNumber',relay_driver_truck,
        'dropTruckNumber',coalesce(report->>'dropTruckNumber',nullif(btrim(load.details->>'truckNumber'),'')));
      event_label := 'Relay departure recorded';
    end if;
    new_progress := jsonb_set(new_progress,'{relay}',report);
  elsif action='add_note' then
    if note_text is null then raise exception 'Enter a load note.' using errcode='22023'; end if;
    event_label := 'Dispatch note';
  else
    state_key := case when action='resolve_breakdown' then 'breakdown' else 'traffic' end;
    report := load.progress -> state_key;
    if action='report_traffic' then
      if report ->> 'active'='true' then raise exception 'This load already has an active traffic delay.' using errcode='22023'; end if;
      report := jsonb_build_object('id',gen_random_uuid(),'active',true,'reportedAt',moment);
      event_label := 'Traffic delay reported';
    else
      if report ->> 'active' is distinct from 'true' or report ->> 'id' is distinct from report_id::text then
        raise exception 'The report changed. Refresh this load.' using errcode='40001';
      end if;
      if action='resolve_breakdown' and coalesce(resolution,'') not in ('back_on_road','recovered') then
        raise exception 'Choose how the breakdown was resolved.' using errcode='22023';
      end if;
      report := report || jsonb_build_object('active',false,'resolvedAt',moment,
        'resolution',case when action='clear_traffic' then 'cleared' else resolution end);
      event_label := case when action='clear_traffic' then 'Traffic cleared'
        when resolution='recovered' then 'Load recovered' else 'Back on the road' end;
    end if;
    new_progress := jsonb_set(new_progress,array[state_key],report);
  end if;
  new_progress := fleet_internal.append_load_note(new_progress,event_label,note_text,'Dispatch',moment);
  update public.fleet_dispatch_loads set progress=new_progress where id=target_id returning * into load;
  return to_jsonb(load);
end;
$$;

create or replace function fleet_internal.expected_load_truck(load_row public.fleet_dispatch_loads, driver uuid)
returns text language sql stable set search_path = ''
as $$
  select case when (load_row).progress #>> '{relay,departDriverId}'=driver::text
      and ((load_row).progress->'relay') ? 'departTruckNumber'
    then (load_row).progress #>> '{relay,departTruckNumber}'
    else coalesce(
    case when driver=(load_row).driver_id and (load_row).details->>'truckFromDriver' is distinct from 'yes'
      then nullif(btrim((load_row).details->>'truckNumber'),'') end,
    d.assigned_truck_number,
    case when driver=(load_row).driver_id then nullif(btrim((load_row).details->>'truckNumber'),'') end)
  end
  from public.fleet_dispatch_drivers d where d.id=driver and d.fleet_id=(load_row).fleet_id;
$$;

CREATE OR REPLACE FUNCTION fleet_internal.driver_workflow(action text, load_id uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  l public.fleet_dispatch_loads%rowtype;
  handoff fleet_internal.driver_yard_handoffs%rowtype;
  assigned uuid;
  request_key uuid;
  next_pro bigint;
  first_stop jsonb;
  last_stop jsonb;
  pickup jsonb;
  receiver jsonb;
  row_progress jsonb;
  selected_stop text;
  planned_drop text;
  planned_pickup text;
  selected_kind text;
  event_info jsonb;
  documents jsonb;
  bobtail boolean := coalesce(payload ->> 'bobtail'='true',false);
  incoming_trailer text;
  departure_trailer text := left(btrim(coalesce(payload ->> 'trailer','')),40);
  picked_trailer text := nullif(upper(left(btrim(payload ->> 'picked_trailer'),40)),'');
  dropped_trailer text := nullif(upper(left(btrim(payload ->> 'dropped_trailer'),40)),'');
  effective_trailer text;
  selected_trailer_type text := nullif(payload->>'trailer_type','');
  pickup_trailer text;
  lumper_fee text;
  lumper_amount numeric;
  lumper_payer text;
  incident_report jsonb;
  state_key text;
  event_label text;
  event_body text;
  moment timestamptz := clock_timestamp();
begin
  if actor is null then raise exception 'Sign in as a driver.' using errcode='42501'; end if;
  if action='list' then
    return (with load_queue as materialized (select * from fleet_internal.driver_load_queue(actor))
      select jsonb_build_object(
      'loads',coalesce((
        select jsonb_agg(summary order by changed desc) from (
          select loads.updated_at as changed, jsonb_build_object(
            'id',loads.id,'fleet',loads.fleet_id,'pro',loads.pro_number,'return_of',loads.return_of,
            'review',loads.return_review,'status',loads.status,
            'decision',loads.progress #>> array['driverResponses',links.dispatch_driver_id::text,'decision'],
            'freight',freight.info,
            'queuePosition',queue.queue_position,
            'relayState',case when not fleet_internal.relay_driver_active(loads,links.dispatch_driver_id)
              then case when loads.driver_id=links.dispatch_driver_id then 'released' else 'waiting' end end,
            'incomingTrailer',case when queue.queue_position=1 then (
              select case when loads.progress ? 'dispatchTrailerOverride' then loads.progress ->> 'dispatchTrailerOverride'
                when load_stop.value ? 'arrivalTrailer' then load_stop.value ->> 'arrivalTrailer'
                else fleet_internal.driver_incoming_trailer(loads,links.dispatch_driver_id,s.stop_key) end
              from fleet_internal.driver_assigned_stops(loads,links.dispatch_driver_id) s
              cross join lateral (select loads.progress #> array['stops',s.stop_key] as value) load_stop
              where load_stop.value ->> 'completedAt' is null
              order by s.sequence_no limit 1
            ) end,
            'breakdown',loads.progress -> 'breakdown',
            'traffic',loads.progress -> 'traffic',
            'loadNotes',coalesce((select jsonb_agg(case when event.note ->> 'source'='Dispatch' then event.note - 'body' else event.note end
              order by event.file_order)
              from jsonb_array_elements(coalesce(loads.progress -> 'loadNotes','[]'::jsonb))
                with ordinality as event(note,file_order) where event.note ->> 'label'<>'Dispatch note'),'[]'::jsonb),
            'pay',case when loads.progress #>> array['driverResponses',links.dispatch_driver_id::text,'decision']='accepted'
              then fleet_internal.driver_offer_pay(loads.details,links.dispatch_driver_id,p.profile_type,d.pay_method)
            end,
            'offer',case when assignment.is_offer then jsonb_build_object(
              'freight',freight.info,
              'pay',fleet_internal.driver_offer_pay(loads.details,links.dispatch_driver_id,p.profile_type,d.pay_method))
            end,
            'yard_handoff',(select jsonb_build_object('yard',y.yard,'trailer',y.trailer,'picked_up_at',y.picked_up_at,
              'first_driver',loads.driver_id=links.dispatch_driver_id)
              from fleet_internal.driver_yard_handoffs y where y.load_id=loads.id),
            'stops',coalesce((select jsonb_agg(jsonb_build_object('key',s.stop_key,'kind',s.kind,'info',jsonb_strip_nulls(jsonb_build_object(
                   'stopId',s.info ->> 'stopId','company',s.info ->> 'company',
                   'address',s.info ->> 'address','city',s.info ->> 'city',
                   'state',s.info ->> 'state','zip',s.info ->> 'zip',
                   'date',s.info ->> 'date','zone',s.info ->> 'zone',
                   'from',s.info ->> 'from','to',s.info ->> 'to',
                   'contactName',s.info ->> 'contactName','phone',s.info ->> 'phone',
                   'email',s.info ->> 'email','notes',s.info ->> 'notes')),
                 'progress',loads.progress #> array['stops',s.stop_key]) order by s.sequence_no)
               from fleet_internal.driver_assigned_stops(loads,links.dispatch_driver_id) s), '[]'::jsonb)
          ) as summary
          from public.rigtracker_fleet_links links
          join public.rigtracker_profiles p on p.user_id=links.profile_user_id and not p.password_required
          join public.fleet_dispatch_drivers d on d.id=links.dispatch_driver_id and d.fleet_id=links.fleet_id
          join public.fleet_dispatch_loads loads on loads.fleet_id=links.fleet_id
            and links.dispatch_driver_id in (loads.driver_id,loads.second_driver_id)
          left join load_queue queue on queue.load_id=loads.id
          cross join lateral (select loads.status='current' and
            loads.progress #>> array['driverResponses',links.dispatch_driver_id::text,'decision'] is null as is_offer) assignment
          cross join lateral (select fleet_internal.driver_load_info(loads.details,
            loads.driver_id=links.dispatch_driver_id) || case
              when loads.progress #>> '{relay,departDriverId}'=links.dispatch_driver_id::text
                and (loads.progress->'relay') ? 'departTruckNumber'
              then jsonb_build_object('truckNumber',loads.progress #>> '{relay,departTruckNumber}')
              else '{}'::jsonb end as info) freight
          where links.profile_user_id=actor and links.unlinked_at is null
            and (loads.status in ('current','completed') or loads.return_review is not null)
          order by queue.queue_position nulls last, loads.updated_at desc limit 150
        ) selected
      ),'[]'::jsonb),
      'yard',coalesce((
        select jsonb_agg(jsonb_build_object('id',y.load_id,'trailer',y.trailer,'yard',y.yard,'picked_up_at',y.picked_up_at,
          'pro',loads.pro_number,'return_of',loads.return_of) order by y.yard,y.trailer)
        from fleet_internal.driver_yard_handoffs y join public.fleet_dispatch_loads loads on loads.id=y.load_id
        where y.confirmed_at is null and loads.status='current' and y.offered_driver=fleet_internal.workflow_driver(actor,y.fleet_id)
      ),'[]'::jsonb)));
  end if;

  -- Serialize work for this driver even when two phone sessions target different loads.
  perform pg_advisory_xact_lock(hashtextextended('rigtracker:driver-load:'||actor::text,0));
  select * into l from public.fleet_dispatch_loads where id=load_id for update;
  if not found then raise exception 'Load unavailable.' using errcode='42501'; end if;
  assigned := fleet_internal.workflow_driver(actor,l.fleet_id);
  if assigned is null then raise exception 'Link your account to this fleet first.' using errcode='42501'; end if;

  if action='yard_pickup' then
    select * into handoff from fleet_internal.driver_yard_handoffs y where y.load_id=l.id for update;
    if not found or l.status<>'current' or handoff.offered_driver is distinct from assigned
      or handoff.trailer is distinct from upper(btrim(payload ->> 'trailer')) then
      raise exception 'Enter the trailer number from your yard list.' using errcode='22023';
    end if;
    if exists(select 1 from fleet_internal.driver_load_queue(actor) queue
        where queue.queue_position=1 and queue.load_id<>l.id) then
      raise exception 'Finish your current load before picking up this queued trailer.' using errcode='55000';
    end if;
    if handoff.picked_up_at is null then
      update fleet_internal.driver_yard_handoffs set picked_up_at=moment where driver_yard_handoffs.load_id=l.id;
      perform fleet_internal.write_driver_progress(l.id,l.progress || jsonb_build_object('yardPickedUpAt',moment));
    end if;
    return jsonb_build_object('pro',l.pro_number);
  end if;

  if assigned is distinct from l.driver_id and assigned is distinct from l.second_driver_id then
    raise exception 'This load is assigned to another driver.' using errcode='42501';
  end if;
  row_progress := l.progress || jsonb_build_object('driverResponses',coalesce(l.progress -> 'driverResponses','{}'::jsonb));
  if action in ('accept','reject') then
    if l.status<>'current' then raise exception 'This assignment is no longer current.' using errcode='22023'; end if;
    if row_progress #>> array['driverResponses',assigned::text,'decision'] is not null then
      raise exception 'You already responded to this assignment.' using errcode='22023';
    end if;
    row_progress := jsonb_set(row_progress,array['driverResponses',assigned::text],
      jsonb_build_object('decision',case action when 'accept' then 'accepted' else 'rejected' end,'at',moment));
    perform fleet_internal.write_driver_progress(l.id,row_progress);
    return '{}'::jsonb;
  end if;
  if row_progress #>> array['driverResponses',assigned::text,'decision'] is distinct from 'accepted' then
    raise exception 'Accept the assignment before working the load.' using errcode='22023';
  end if;
  if not fleet_internal.relay_driver_active(l,assigned) then
    raise exception 'The load is between drivers at the relay.' using errcode='55000';
  end if;

  if (action in ('arrive','finish_stop','report_breakdown','report_traffic','add_load_note')
      or (action='request_return' and l.status='current'))
    and exists(select 1 from fleet_internal.driver_load_queue(actor) queue
      where queue.queue_position=1 and queue.load_id<>l.id) then
    raise exception 'Finish your current load before starting this queued load.' using errcode='55000';
  end if;

  if action in ('report_breakdown','resume_breakdown','report_traffic','clear_traffic','add_load_note') then
    if l.status<>'current' or (l.driver_id=assigned and exists(select 1 from fleet_internal.driver_yard_handoffs y
        where y.load_id=l.id and y.picked_up_at is not null)) then
      raise exception 'This load is no longer active for this driver.' using errcode='22023';
    end if;
    if action='add_load_note' then
      event_body := nullif(btrim(payload ->> 'note'),'');
      if event_body is null or char_length(event_body)>1000 then
        raise exception 'Enter a load note up to 1,000 characters.' using errcode='22023';
      end if;
      perform fleet_internal.write_driver_progress(l.id,
        fleet_internal.append_load_note(row_progress,'Driver note',event_body,'Driver',moment));
      return '{}'::jsonb;
    end if;
    state_key := case when action in ('report_traffic','clear_traffic') then 'traffic' else 'breakdown' end;
    incident_report := row_progress -> state_key;
    if action in ('report_breakdown','report_traffic') then
      if incident_report ->> 'active'='true' then return '{}'::jsonb; end if;
      incident_report := jsonb_strip_nulls(jsonb_build_object('id',gen_random_uuid(),'active',true,'reportedAt',moment,
        'location',nullif(left(btrim(payload ->> 'location'),160),''),
        'notes',nullif(left(btrim(payload ->> 'notes'),500),'')));
      event_label := case when state_key='traffic' then 'Traffic delay reported' else 'Breakdown reported' end;
      event_body := concat_ws(' · ',incident_report ->> 'location',incident_report ->> 'notes');
    else
      if incident_report ->> 'active' is distinct from 'true' or incident_report ->> 'id' is distinct from payload ->> 'report_id' then
        raise exception 'The report changed. Refresh the load.' using errcode='40001';
      end if;
      incident_report := incident_report || jsonb_build_object('active',false,'resolvedAt',moment,
        'resolution',case when state_key='traffic' then 'cleared' else 'back_on_road' end);
      event_label := case when state_key='traffic' then 'Traffic cleared' else 'Back on the road' end;
    end if;
    row_progress := jsonb_set(row_progress,array[state_key],incident_report);
    perform fleet_internal.write_driver_progress(l.id,fleet_internal.append_load_note(row_progress,event_label,event_body,'Driver',moment));
    return '{}'::jsonb;
  end if;

  if action='request_return' then
    if l.return_of is not null or l.status not in ('current','completed') then
      raise exception 'Start the return request from the outbound A-PRO.' using errcode='22023';
    end if;
    request_key := (payload ->> 'request_id')::uuid;
    if request_key is null then raise exception 'Return request ID is required.' using errcode='22023'; end if;
    perform 1 from public.fleets where id=l.fleet_id for update;
    select pro_number into next_pro from public.fleet_dispatch_loads
      where id=request_key and fleet_id=l.fleet_id and return_of=l.id and driver_id=assigned;
    if found then return jsonb_build_object('pro',next_pro); end if;
    first_stop := l.details #> '{pickups,0}';
    last_stop := l.details #> '{receivers,-1}';
    pickup := last_stop;
    if payload ->> 'mode'='reverse' then
      receiver := first_stop;
    elsif payload ->> 'mode'='destination' and char_length(btrim(payload ->> 'destination')) between 1 and 160 then
      receiver := jsonb_build_object('company',btrim(payload ->> 'destination'));
    else
      raise exception 'Choose a return destination.' using errcode='22023';
    end if;
    if nullif(btrim(pickup ->> 'company'),'') is null or nullif(btrim(receiver ->> 'company'),'') is null then
      raise exception 'Enter a shipper and receiver for this return.' using errcode='22023';
    end if;
    pickup := (pickup - 'stopId' - 'date' - 'from' - 'to' - 'notes') || jsonb_build_object('stopId','pickup-0','driver1',true,'driver2',false);
    receiver := (receiver - 'stopId' - 'date' - 'from' - 'to' - 'notes') || jsonb_build_object('stopId','receiver-0','driver1',true,'driver2',false);
    select coalesce(max(r.pro_number),10000)+1 into next_pro
    from fleet_internal.dispatch_pro_reservations r where r.fleet_id=l.fleet_id;
    insert into fleet_internal.dispatch_pro_reservations(fleet_id,load_id,pro_number) values(l.fleet_id,request_key,next_pro);
    insert into public.fleet_dispatch_loads(id,fleet_id,pro_number,status,driver_id,details,progress,return_of,return_review)
    values(request_key,l.fleet_id,next_pro,'draft',assigned,
      jsonb_build_object('pickups',jsonb_build_array(pickup),'receivers',jsonb_build_array(receiver))
      || fleet_internal.driver_return_freight(payload),
      jsonb_build_object('stops','{}'::jsonb,'driverResponses',jsonb_build_object(assigned::text,
        jsonb_build_object('decision','accepted','at',moment))),l.id,'pending');
    return jsonb_build_object('pro',next_pro);
  end if;

  if action not in ('arrive','finish_stop') or not (l.status='current' or l.return_review='pending') then
    raise exception 'That action is unavailable for this load.' using errcode='22023';
  end if;
  if l.driver_id=assigned and exists(select 1 from fleet_internal.driver_yard_handoffs y
    where y.load_id=l.id and y.picked_up_at is not null) then
    raise exception 'The trailer was picked up by the next driver.' using errcode='22023';
  end if;
  select s.stop_key,s.kind into selected_stop,selected_kind from fleet_internal.driver_assigned_stops(l,assigned) s
    where l.progress #>> array['stops',s.stop_key,'completedAt'] is null
    order by s.sequence_no limit 1;
  if selected_stop is null or selected_stop is distinct from payload ->> 'stop' then
    raise exception 'Refresh the load and select your next stop.' using errcode='22023';
  end if;
  event_info := coalesce(row_progress #> array['stops',selected_stop],'{}'::jsonb);
  incoming_trailer := case when row_progress ? 'dispatchTrailerOverride' then row_progress ->> 'dispatchTrailerOverride'
    when event_info ? 'arrivalTrailer' then event_info ->> 'arrivalTrailer'
    else fleet_internal.driver_incoming_trailer(l,assigned,selected_stop) end;
  if action='arrive' then
    if not (event_info ? 'arrivalAt') then
      event_info := event_info || jsonb_build_object('arrivalAt',moment,'arrivalTrailer',incoming_trailer);
    end if;
  else
    if not (event_info ? 'arrivalAt') then raise exception 'Record arrival at the stop first.' using errcode='22023'; end if;
    if l.details ->> 'trailerDrop'='yes' and l.details ->> 'trailerDropStopId'=selected_stop then
      planned_drop := nullif(btrim(l.details ->> 'trailerDropNumber'),'');
      if planned_drop is not null and dropped_trailer is distinct from upper(planned_drop) then
        raise exception 'Enter the planned drop trailer number %.',planned_drop using errcode='22023';
      end if;
    end if;
    if l.details ->> 'trailerPickup'='yes' and l.details ->> 'trailerPickupStopId'=selected_stop then
      if l.details ->> 'trailerPickupMode'='bobtail' then
        if not bobtail then
          raise exception 'Select Bobtail to confirm you are leaving without a trailer.' using errcode='22023';
        end if;
      elsif not bobtail then
        planned_pickup := nullif(btrim(l.details ->> 'trailerPickupNumber'),'');
        if planned_pickup is not null and picked_trailer is distinct from upper(planned_pickup) then
          raise exception 'Enter the planned pickup trailer number %.',planned_pickup using errcode='22023';
        end if;
      end if;
    end if;
    if not bobtail and picked_trailer is not null then
      if departure_trailer<>'' and upper(departure_trailer)<>picked_trailer then
        raise exception 'Trailer number must match the picked-up trailer.' using errcode='22023';
      end if;
      departure_trailer := picked_trailer;
    end if;
    if incoming_trailer is not null and upper(departure_trailer)<>upper(incoming_trailer)
      and not bobtail and dropped_trailer is null and picked_trailer is null then
      raise exception 'Trailer mismatch. Enter the arrival trailer, record a trailer drop or pickup, or select Bobtail.'
        using errcode='22023';
    end if;
    documents := case
      when payload ? 'documents' then payload -> 'documents'
      when nullif(payload ->> 'document','') is not null then jsonb_build_array(payload ->> 'document')
      else '[]'::jsonb
    end;
    if jsonb_typeof(documents) is distinct from 'array' then
      raise exception 'Attach paperwork as a list of files.' using errcode='22023';
    end if;
    if jsonb_array_length(documents)>20 then
      raise exception 'Attach up to 20 files per stop.' using errcode='22023';
    end if;
    if exists(
      select 1 from jsonb_array_elements(documents) as attachment(value)
      cross join lateral (select attachment.value #>> '{}' as name) file
      where jsonb_typeof(attachment.value) <> 'string'
        or split_part(file.name,'/',1) <> l.id::text or split_part(file.name,'/',2) <> actor::text
        or not exists(select 1 from storage.objects where bucket_id='driver-load-documents' and name=file.name)
    ) then raise exception 'Upload every file to this load first.' using errcode='22023'; end if;
    if jsonb_array_length(documents)<>(select count(distinct path) from jsonb_array_elements_text(documents) as d(path)) then
      raise exception 'Attach each file only once.' using errcode='22023';
    end if;
    if not bobtail and picked_trailer is not null and coalesce(payload ->> 'loaded_state','') not in ('loaded','empty') then
      raise exception 'Mark the picked-up trailer Loaded or Empty.' using errcode='22023';
    end if;
    lumper_fee := nullif(btrim(payload ->> 'lumperFee'),'');
    if lumper_fee !~ '^([0-9]{1,12}(\.[0-9]{1,2})?|\.[0-9]{1,2})$' then
      raise exception 'Enter a valid lumper fee in dollars, such as 125.50, or leave it blank.' using errcode='22023';
    end if;
    lumper_amount := coalesce(lumper_fee::numeric,0);
    if lumper_amount>0 then
      lumper_payer := nullif(payload ->> 'lumperPayer','');
      -- A driver may still be submitting from a form opened before this field was added.
      if payload ? 'lumperPayer' and coalesce(lumper_payer,'') not in ('driver','fleet') then
        raise exception 'Choose Driver or Fleet for who paid the lumper fee.' using errcode='22023';
      end if;
    end if;
    effective_trailer := case when bobtail then ''
      when picked_trailer is not null then picked_trailer
      when dropped_trailer is not null and (departure_trailer='' or upper(departure_trailer)=dropped_trailer) then ''
      else nullif(departure_trailer,'') end;
    if nullif(effective_trailer,'') is not null then
      if selected_trailer_type not in ('fleet','power_only') then
        raise exception 'Choose Fleet or Power Only for this trailer.' using errcode='22023';
      end if;
      if selected_trailer_type='fleet' and (fleet_internal.registered_equipment(l.fleet_id,'trailer',effective_trailer)).id is null then
        raise exception 'Select a trailer saved in Equipment or choose Power Only.' using errcode='22023';
      end if;
    end if;
    if effective_trailer is not null then
      row_progress := row_progress - 'dispatchTrailerOverride';
      if selected_kind='pickup' then pickup_trailer := effective_trailer; end if;
    end if;
    event_info := event_info || jsonb_build_object('completedAt',moment,'driverReport',jsonb_strip_nulls(jsonb_build_object(
      'bobtail',case when bobtail then true end,
      'trailer',nullif(effective_trailer,''),
      'trailerType',case when nullif(effective_trailer,'') is not null then selected_trailer_type end,
      'commodity',nullif(left(btrim(payload ->> 'commodity'),120),''),
      'weight',nullif(left(btrim(payload ->> 'weight'),20),''),
      'pieces',nullif(left(btrim(payload ->> 'pieces'),20),''),
      'bol',nullif(left(btrim(payload ->> 'bol'),100),''),
      'lumperFee',lumper_amount,
      'lumperPayer',lumper_payer,
      'droppedTrailer',dropped_trailer,
      'pickedTrailer',case when not bobtail then picked_trailer end,
      'loadedState',case when not bobtail then nullif(left(payload ->> 'loaded_state',10),'') end,
      'document',documents ->> 0,
      'documents',nullif(documents,'[]'::jsonb),'at',moment
    )));
  end if;
  perform fleet_internal.write_driver_progress(l.id,jsonb_set(row_progress,array['stops',selected_stop],event_info),pickup_trailer);
  return '{}'::jsonb;
end;
$function$;

create or replace function fleet_internal.stamp_dispatch_load_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Older history rows used their last update as their completion date.
  if tg_op='UPDATE' and old.status='completed' and new.status='completed'
    and nullif(new.progress->>'completedAt','') is null then
    new.progress := new.progress || jsonb_build_object('completedAt',old.updated_at);
  end if;
  new.updated_at := clock_timestamp();
  if new.status = 'current' then
    if tg_op = 'INSERT' then
      new.assigned_at := new.updated_at;
    elsif old.status is distinct from 'current' then
      new.assigned_at := new.updated_at;
    end if;
  end if;
  return new;
end;
$$;
