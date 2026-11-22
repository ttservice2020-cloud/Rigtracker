create function fleet_internal.dispatch_load_driver_contacts(target_load uuid)
returns table(driver_id uuid, phone text, can_message boolean)
language sql stable security definer set search_path = ''
as $$
  select driver.id, nullif(btrim(profile.phone), ''),
    coalesce(profile.profile_type = 'company_driver'
      and 'dispatch' = any(fleet_internal.message_staff_scope((select auth.uid()), load.fleet_id))
      and fleet_internal.company_driver_is_linked(profile.user_id, load.fleet_id), false)
  from public.fleet_dispatch_loads load
  join public.fleet_dispatch_drivers driver on driver.fleet_id = load.fleet_id
    and driver.id in (load.driver_id, load.second_driver_id)
  left join public.rigtracker_fleet_links link on link.fleet_id = load.fleet_id
    and link.dispatch_driver_id = driver.id and link.unlinked_at is null
  left join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
    and profile.profile_type in ('company_driver', 'driver')
  where load.id = target_load and fleet_internal.office_has_permission(load.fleet_id, 'dispatch');
$$;

create function public.dispatch_load_driver_contacts(target_load uuid)
returns table(driver_id uuid, phone text, can_message boolean)
language sql stable security invoker set search_path = ''
as $$ select * from fleet_internal.dispatch_load_driver_contacts(target_load); $$;

revoke all on function fleet_internal.dispatch_load_driver_contacts(uuid),
  public.dispatch_load_driver_contacts(uuid) from public, anon, authenticated;
grant execute on function fleet_internal.dispatch_load_driver_contacts(uuid),
  public.dispatch_load_driver_contacts(uuid) to authenticated;

create function fleet_internal.driver_return_freight(payload jsonb)
returns jsonb language plpgsql immutable set search_path = ''
as $$
declare
  commodity text := nullif(left(btrim(payload ->> 'commodity'),120),'');
  weight text := nullif(btrim(payload ->> 'weight'),'');
  pieces text := nullif(btrim(payload ->> 'pieces'),'');
begin
  if weight is not null and not (case when weight ~ '^([0-9]{1,12}([.][0-9]{1,2})?|[.][0-9]{1,2})$'
    then weight::numeric > 0 else false end) then
    raise exception 'Enter a positive weight in pounds with up to two decimal places.' using errcode='22023';
  end if;
  if pieces is not null and not (case when pieces ~ '^[0-9]{1,9}$' then pieces::integer > 0 else false end) then
    raise exception 'Enter a positive whole number of pieces.' using errcode='22023';
  end if;
  return jsonb_strip_nulls(jsonb_build_object(
    'bolNumber',nullif(left(btrim(payload ->> 'bol'),100),''),
    'commodity',case when commodity is not null then 'Other' end,
    'commodityOther',commodity,'weightLbs',weight,'pieces',pieces
  ));
end;
$$;
revoke all on function fleet_internal.driver_return_freight(jsonb) from public, anon, authenticated;

create or replace function fleet_internal.driver_load_info(details jsonb, primary_driver boolean)
returns jsonb language sql immutable security invoker set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'commodity',coalesce(nullif(case when details ->> 'commodity'='Other'
      then details ->> 'commodityOther' end,''),nullif(details ->> 'commodity','')),
    'equipment',coalesce(nullif(case when details ->> 'equipmentType'='Other'
      then details ->> 'equipmentTypeOther' end,''),nullif(details ->> 'equipmentType','')),
    'weight',nullif(details ->> 'weightLbs',''),
    'pieces',nullif(details ->> 'pieces',''),
    'route',nullif(details ->> 'routeNumber',''),
    'miles',nullif(details ->> 'loadedMiles',''),
    'emptyMiles',nullif(details ->> 'emptyMiles',''),
    'pickupNumber',nullif(details ->> 'pickupNumber',''),
    'bolNumber',nullif(details ->> 'bolNumber',''),
    'brokerName',nullif(details ->> 'brokerName',''),
    'brokerLoadNumber',nullif(details ->> 'brokerLoadNumber',''),
    'brokerPhone',nullif(details ->> 'brokerPhone',''),
    'brokerEmail',nullif(details ->> 'brokerEmail',''),
    'truckNumber',nullif(details ->> 'truckNumber',''),
    'trailerNumber',nullif(details ->> 'trailerNumber',''),
    'trailerDrop',case when details ->> 'trailerDrop'='yes'
      then coalesce(nullif(details ->> 'trailerDropNotes',''),'Yes') end,
    'trailerPickup',case when details ->> 'trailerPickup'='yes'
      then coalesce(nullif(details ->> 'trailerPickupNotes',''),'Yes') end,
    'relayLocation',nullif(details ->> 'relayLocation',''),
    'relayDate',nullif(details ->> 'relayDate',''),
    'relayDrop',nullif(details ->> 'relayDrop',''),
    'relayPickup',nullif(details ->> 'relayPickup',''),
    'firstLegMiles',nullif(details ->> 'firstLegMiles',''),
    'firstLegEmptyMiles',nullif(details ->> 'firstLegEmptyMiles',''),
    'stopPay',case when primary_driver then nullif(details ->> 'stopPay','') end
  ));
$$;

create function fleet_internal.driver_assigned_stops(load public.fleet_dispatch_loads, assigned uuid)
returns table(stop_key text, kind text, sequence_no bigint, info jsonb)
language sql stable set search_path = ''
as $$
  select stop.stop_key, stop.kind, stop.sequence_no, stop.info
  from fleet_internal.workflow_stops((load).details) stop
  where ((load).driver_id=assigned and coalesce(stop.info ->> 'driver1','true') <> 'false')
    or ((load).second_driver_id=assigned and
      case when exists(select 1 from fleet_internal.driver_yard_handoffs yard
          where yard.load_id=(load).id and yard.confirmed_at is not null)
        then stop.kind='delivery' else stop.info ->> 'driver2'='true' end);
$$;

-- An empty string represents a known bobtail, while NULL represents no known trailer.
create function fleet_internal.driver_incoming_trailer(
  load public.fleet_dispatch_loads, assigned uuid, target_stop text
)
returns text language sql stable set search_path = ''
as $$
  select coalesce(
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
    nullif(btrim((load).details ->> 'trailerNumber'),'')
  );
$$;

revoke all on function fleet_internal.driver_assigned_stops(public.fleet_dispatch_loads,uuid),
  fleet_internal.driver_incoming_trailer(public.fleet_dispatch_loads,uuid,text) from public, anon, authenticated;

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
  event_info jsonb;
  documents jsonb;
  bobtail boolean := coalesce(payload ->> 'bobtail'='true',false);
  incoming_trailer text;
  departure_trailer text := btrim(coalesce(payload ->> 'trailer',''));
  lumper_fee text;
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
            'incomingTrailer',case when queue.queue_position=1 then (
              select case when load_stop.value ? 'arrivalTrailer' then load_stop.value ->> 'arrivalTrailer'
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
            loads.driver_id=links.dispatch_driver_id) as info) freight
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
  select s.stop_key into selected_stop from fleet_internal.driver_assigned_stops(l,assigned) s
    where l.progress #>> array['stops',s.stop_key,'completedAt'] is null
    order by s.sequence_no limit 1;
  if selected_stop is null or selected_stop is distinct from payload ->> 'stop' then
    raise exception 'Refresh the load and select your next stop.' using errcode='22023';
  end if;
  event_info := coalesce(row_progress #> array['stops',selected_stop],'{}'::jsonb);
  incoming_trailer := case when event_info ? 'arrivalTrailer' then event_info ->> 'arrivalTrailer'
    else fleet_internal.driver_incoming_trailer(l,assigned,selected_stop) end;
  if action='arrive' then
    if not (event_info ? 'arrivalAt') then
      event_info := event_info || jsonb_build_object('arrivalAt',moment,'arrivalTrailer',incoming_trailer);
    end if;
  else
    if not (event_info ? 'arrivalAt') then raise exception 'Record arrival at the stop first.' using errcode='22023'; end if;
    if incoming_trailer is not null and upper(departure_trailer)<>upper(incoming_trailer)
      and not bobtail and nullif(btrim(payload ->> 'dropped_trailer'),'') is null
      and nullif(btrim(payload ->> 'picked_trailer'),'') is null then
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
    if not bobtail and nullif(payload ->> 'picked_trailer','') is not null and coalesce(payload ->> 'loaded_state','') not in ('loaded','empty') then
      raise exception 'Mark the picked-up trailer Loaded or Empty.' using errcode='22023';
    end if;
    lumper_fee := nullif(btrim(payload ->> 'lumperFee'),'');
    if lumper_fee !~ '^([0-9]{1,12}(\.[0-9]{1,2})?|\.[0-9]{1,2})$' then
      raise exception 'Enter a valid lumper fee in dollars, such as 125.50, or leave it blank.' using errcode='22023';
    end if;
    event_info := event_info || jsonb_build_object('completedAt',moment,'driverReport',jsonb_strip_nulls(jsonb_build_object(
      'bobtail',case when bobtail then true end,
      'trailer',case when not bobtail then nullif(left(btrim(payload ->> 'trailer'),40),'') end,
      'commodity',nullif(left(btrim(payload ->> 'commodity'),120),''),
      'weight',nullif(left(btrim(payload ->> 'weight'),20),''),
      'pieces',nullif(left(btrim(payload ->> 'pieces'),20),''),
      'bol',nullif(left(btrim(payload ->> 'bol'),100),''),
      'lumperFee',lumper_fee::numeric,
      'droppedTrailer',nullif(upper(left(btrim(payload ->> 'dropped_trailer'),40)),''),
      'pickedTrailer',case when not bobtail then nullif(upper(left(btrim(payload ->> 'picked_trailer'),40)),'') end,
      'loadedState',case when not bobtail then nullif(left(payload ->> 'loaded_state',10),'') end,
      'document',documents ->> 0,
      'documents',nullif(documents,'[]'::jsonb),'at',moment
    )));
  end if;
  perform fleet_internal.write_driver_progress(l.id,jsonb_set(row_progress,array['stops',selected_stop],event_info));
  return '{}'::jsonb;
end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.dispatch_workflow(fleet text, action text, load_id uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  l public.fleet_dispatch_loads%rowtype;
  handoff fleet_internal.driver_yard_handoffs%rowtype;
  offered uuid;
  trailer_value text := upper(btrim(payload ->> 'trailer'));
  yard_value text := btrim(payload ->> 'yard');
  updated_details jsonb;
  new_progress jsonb;
begin
  if actor is null or not fleet_internal.office_has_permission(fleet,'dispatch') then
    raise exception 'Only this Fleet Admin can review driver activity.' using errcode='42501';
  end if;
  if action='list' then
    return jsonb_build_object(
      'returns',coalesce((
        select jsonb_agg(jsonb_build_object('id',q.id,'pro',q.pro_number,'driver',d.name,'shipper',q.details #>> '{pickups,0,company}',
          'receiver',q.details #>> '{receivers,0,company}','address',q.details #>> '{receivers,0,address}',
          'source_pro',source.pro_number,'freight',fleet_internal.driver_load_info(q.details,true)) order by q.created_at)
        from public.fleet_dispatch_loads q join public.fleet_dispatch_loads source on source.id=q.return_of
        left join public.fleet_dispatch_drivers d on d.id=q.driver_id
        where q.fleet_id=fleet and q.return_review='pending'
      ),'[]'::jsonb),
      'responses',coalesce((
        select jsonb_agg(notification order by responded desc) from (
          select jsonb_build_object('id',q.id,'pro',q.pro_number,'return_of',q.return_of,'driver',d.name,
            'decision',r.value ->> 'decision','at',r.value ->> 'at') notification, r.value ->> 'at' responded
          from public.fleet_dispatch_loads q
          cross join lateral jsonb_each(coalesce(q.progress->'driverResponses','{}'::jsonb)) r
          join public.fleet_dispatch_drivers d on d.id::text=r.key and d.id in (q.driver_id,q.second_driver_id)
          where q.fleet_id=fleet and q.status='current'
          order by responded desc limit 100
        ) rows
      ),'[]'::jsonb),
      'yard',coalesce((
        select jsonb_agg(jsonb_build_object('id',y.load_id,'pro',q.pro_number,'return_of',q.return_of,'trailer',y.trailer,'yard',y.yard,
          'driver',d.name,'offered_driver',y.offered_driver,'picked_up_at',y.picked_up_at) order by y.picked_up_at desc nulls last,y.trailer)
        from fleet_internal.driver_yard_handoffs y join public.fleet_dispatch_loads q on q.id=y.load_id
        left join public.fleet_dispatch_drivers d on d.id=y.offered_driver
        where y.fleet_id=fleet and y.confirmed_at is null and q.status='current'
      ),'[]'::jsonb),
      'loads',coalesce((
        select jsonb_agg(item order by pro desc) from (
          select q.pro_number pro,jsonb_build_object('id',q.id,'pro',q.pro_number,'return_of',q.return_of,
            'driver_id',q.driver_id,'receiver',q.details #>> '{receivers,0,company}') item
          from public.fleet_dispatch_loads q where q.fleet_id=fleet and q.status='current'
          order by q.pro_number desc limit 250
        ) rows
      ),'[]'::jsonb),
      'drivers',coalesce((
        select jsonb_agg(jsonb_build_object('id',d.id,'name',d.name) order by d.name)
        from public.rigtracker_fleet_links link join public.fleet_dispatch_drivers d on d.id=link.dispatch_driver_id
        where link.fleet_id=fleet and link.unlinked_at is null and d.link_active
      ),'[]'::jsonb));
  end if;

  select * into l from public.fleet_dispatch_loads where id=load_id and fleet_id=fleet for update;
  if not found then raise exception 'Load unavailable in this fleet.' using errcode='42501'; end if;
  perform fleet_internal.assert_dispatch_load_unlocked(l.id);
  if action in ('post_return','deny_return') then
    if l.return_review is distinct from 'pending' then raise exception 'This request was already reviewed.' using errcode='22023'; end if;
    if action='deny_return' then
      update public.fleet_dispatch_loads set return_review='denied' where id=l.id;
      return '{}'::jsonb;
    end if;
    if char_length(btrim(payload ->> 'shipper')) not between 1 and 160
      or char_length(btrim(payload ->> 'receiver')) not between 1 and 160
      or nullif(btrim(payload ->> 'shipper'),'') is null or nullif(btrim(payload ->> 'receiver'),'') is null then
      raise exception 'Enter a shipper and receiver.' using errcode='22023';
    end if;
    updated_details := jsonb_set(jsonb_set(l.details,'{pickups,0,company}',to_jsonb(btrim(payload ->> 'shipper'))),
      '{receivers,0,company}',to_jsonb(btrim(payload ->> 'receiver')));
    if payload ? 'address' then
      updated_details := jsonb_set(updated_details,'{receivers,0,address}',to_jsonb(left(coalesce(payload ->> 'address',''),180)));
    end if;
    update public.fleet_dispatch_loads set return_review='posted',status='current',details=updated_details where id=l.id;
    if coalesce(trailer_value,'')='' and coalesce(yard_value,'')='' then return '{}'::jsonb; end if;
    action := 'send_yard';
    l.status := 'current';
  end if;

  if l.status<>'current' then raise exception 'Post the load before working the yard split.' using errcode='22023'; end if;
  select * into handoff from fleet_internal.driver_yard_handoffs y where y.load_id=l.id for update;
  if action='send_yard' then
    if handoff.picked_up_at is not null then raise exception 'This trailer was already picked up.' using errcode='22023'; end if;
    if coalesce(char_length(trailer_value),0) not between 1 and 40 or coalesce(char_length(yard_value),0) not between 1 and 160 then
      raise exception 'Enter the trailer number and yard.' using errcode='22023';
    end if;
    offered := nullif(payload ->> 'driver_id','')::uuid;
    if offered is not null and (offered=l.driver_id or not exists(
      select 1 from public.rigtracker_fleet_links where fleet_id=fleet and dispatch_driver_id=offered and unlinked_at is null
    )) then raise exception 'Choose a different linked driver for the yard pickup.' using errcode='22023'; end if;
    insert into fleet_internal.driver_yard_handoffs(load_id,fleet_id,trailer,yard,offered_driver)
      values(l.id,fleet,trailer_value,yard_value,offered)
      on conflict on constraint driver_yard_handoffs_pkey do update
        set trailer=excluded.trailer,yard=excluded.yard,offered_driver=excluded.offered_driver;
    return '{}'::jsonb;
  end if;
  if action='finish_yard' then
    if handoff.picked_up_at is null or handoff.confirmed_at is not null or handoff.offered_driver is null then
      raise exception 'Wait for the driver’s yard pickup before confirming the split.' using errcode='22023';
    end if;
    new_progress := l.progress || jsonb_build_object('driverResponses',coalesce(l.progress -> 'driverResponses','{}'::jsonb));
    new_progress := jsonb_set(new_progress,array['driverResponses',handoff.offered_driver::text],
      jsonb_build_object('decision','accepted','at',handoff.picked_up_at));
    update public.fleet_dispatch_loads set second_driver_id=handoff.offered_driver,
      details=details || jsonb_build_object('secondDriverMode','assigned','relayLocation',handoff.yard),progress=new_progress where id=l.id;
    update fleet_internal.driver_yard_handoffs set confirmed_at=clock_timestamp() where driver_yard_handoffs.load_id=l.id;
    return '{}'::jsonb;
  end if;
  raise exception 'Unsupported Dispatch action.' using errcode='22023';
exception when unique_violation then
  raise exception 'This trailer is already listed for another open yard split.' using errcode='22023';
end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.record_dispatch_progress(requested_load_id uuid, expected_updated_at timestamp with time zone, requested_action text, requested_stop_key text, requested_arrival_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  load_row public.fleet_dispatch_loads%rowtype;
  next_key text;
  arrival_driver uuid;
  recorded jsonb;
  current_progress jsonb;
  occurred_at timestamptz := clock_timestamp();
  next_status text := 'current';
begin
  select loads.* into load_row
  from public.fleet_dispatch_loads loads
  join public.fleets fleets on fleets.id = loads.fleet_id
  where loads.id = requested_load_id and fleet_internal.office_has_permission(loads.fleet_id,'dispatch')
  for update of loads;
  if not found then raise exception 'Load unavailable to this account.' using errcode = '42501'; end if;
  if load_row.status <> 'current' or load_row.updated_at is distinct from expected_updated_at then
    raise exception 'This load changed. Refresh it before recording progress.' using errcode = '40001';
  end if;
  current_progress := load_row.progress;
  select stop_key into next_key
    from fleet_internal.dispatch_stop_keys(load_row.details)
    where current_progress #>> array['stops',stop_key,'completedAt'] is null
    order by stop_order limit 1;
  case requested_action
    when 'en_route' then
      if current_progress ? 'enRouteAt' or current_progress -> 'stops' <> '{}'::jsonb or next_key is null then
        raise exception 'The load has already started.' using errcode = '22023';
      end if;
      current_progress := current_progress || jsonb_build_object('enRouteAt', occurred_at);
    when 'arrive', 'depart' then
      if requested_stop_key is null or not exists (
        select 1 from fleet_internal.dispatch_stop_keys(load_row.details) where stop_key = requested_stop_key
      ) then
        raise exception 'Select a valid stop.' using errcode = '22023';
      end if;
      recorded := coalesce(current_progress #> array['stops', requested_stop_key], '{}'::jsonb);
      if requested_action = 'arrive' then
        if requested_stop_key is distinct from next_key and not (recorded ? 'arrivalAt') then
          raise exception 'Record the next scheduled stop first.' using errcode = '22023';
        end if;
        requested_arrival_at := coalesce(requested_arrival_at, occurred_at);
        if not isfinite(requested_arrival_at) or requested_arrival_at > occurred_at
          or requested_arrival_at > (recorded ->> 'completedAt')::timestamptz then
          raise exception 'Arrival must be at or before the current time and any recorded departure.' using errcode = '22023';
        end if;
        if recorded ? 'arrivalAt' and (recorded ->> 'arrivalAt')::timestamptz <> requested_arrival_at then
          recorded := recorded || jsonb_build_object('previousArrivalAt', recorded -> 'arrivalAt');
        end if;
        if not (recorded ? 'arrivalAt') then
          select candidate.driver_id into arrival_driver
          from (values (load_row.driver_id,1),(load_row.second_driver_id,2)) candidate(driver_id,position)
          where exists(select 1 from fleet_internal.driver_assigned_stops(load_row,candidate.driver_id)
              where stop_key=requested_stop_key)
          order by candidate.position limit 1;
          recorded := recorded || jsonb_build_object('arrivalTrailer',
            fleet_internal.driver_incoming_trailer(load_row,arrival_driver,requested_stop_key));
        end if;
        recorded := recorded || jsonb_build_object('arrivalAt', requested_arrival_at);
      else
        if requested_stop_key is distinct from next_key or not (recorded ? 'arrivalAt') or recorded ? 'completedAt' then
          raise exception 'Record an arrival for the next scheduled stop before completing it.' using errcode = '22023';
        end if;
        recorded := recorded || jsonb_build_object('completedAt', occurred_at);
      end if;
      current_progress := jsonb_set(current_progress, array['stops', requested_stop_key], recorded);
    when 'complete' then
      current_progress := current_progress || jsonb_build_object('completedAt', occurred_at);
      next_status := 'completed';
    else
      raise exception 'Unsupported progress action.' using errcode = '22023';
  end case;

  update public.fleet_dispatch_loads
  set progress = current_progress, status = next_status
  where id = load_row.id returning * into load_row;
  return to_jsonb(load_row);
end;
$function$;
