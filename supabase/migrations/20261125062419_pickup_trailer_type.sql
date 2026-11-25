create or replace function fleet_internal.update_driver_stop_info(
  target_load uuid, target_stop text, load_info jsonb, expected_info jsonb, documents jsonb
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load public.fleet_dispatch_loads%rowtype;
  assigned uuid;
  stop_kind text;
  stop_state jsonb;
  previous_report jsonb;
  report jsonb;
  changed_fields jsonb;
  combined jsonb;
  expected_trailer text;
  pickup_trailer text;
  pickup_type text;
begin
  if actor is null then
    raise exception 'Sign in to update load info.' using errcode='42501';
  end if;
  select l.* into load from public.fleet_dispatch_loads l
  where l.id=target_load and (l.status in ('current','completed') or l.return_review='pending')
  for update;
  if not found then
    raise exception 'This load is unavailable.' using errcode='42501';
  end if;
  assigned := fleet_internal.workflow_driver(actor,load.fleet_id);
  if load.status='completed' then
    if not fleet_internal.can_attach_completed_paperwork(load,assigned) then
      raise exception 'This load is unavailable.' using errcode='42501';
    end if;
  elsif assigned is null or load.progress#>>array['driverResponses',assigned::text,'decision'] is distinct from 'accepted' then
    raise exception 'Accept this load before updating load info.' using errcode='42501';
  end if;

  select stop.kind into stop_kind from fleet_internal.driver_assigned_stops(load,assigned) stop where stop.stop_key=target_stop;
  if not found then
    raise exception 'You can update load info only for your assigned stops.' using errcode='42501';
  end if;
  stop_state := coalesce(load.progress#>array['stops',target_stop],'{}'::jsonb);
  if load.status<>'completed' and stop_state->>'completedAt' is null
    and (stop_kind<>'pickup' or stop_state->>'arrivalAt' is null) then
    raise exception 'Check in at pickup or record departure at delivery before updating this stop.'
      using errcode='22023';
  end if;
  previous_report := coalesce(stop_state->'driverReport','{}'::jsonb);
  report := previous_report;

  if jsonb_typeof(load_info) is distinct from 'object' or jsonb_typeof(expected_info) is distinct from 'object'
    or octet_length(load_info::text)>1600 or octet_length(expected_info::text)>1600 then
    raise exception 'Enter valid pickup information.' using errcode='22023';
  end if;
  if load_info<>'{}'::jsonb then
    if stop_kind<>'pickup' or exists (
      select 1 from jsonb_each(load_info) field
      where field.key not in ('pickupTrailer','pickupTrailerType','commodity','weight','pieces','bol')
        or jsonb_typeof(field.value) not in ('null','string')
        or char_length(field.value#>>'{}') > case field.key when 'pickupTrailer' then 40 when 'commodity' then 120 when 'bol' then 100 else 20 end
    ) then
      raise exception 'Enter valid pickup information.' using errcode='22023';
    end if;
    if exists (
      select 1 from jsonb_object_keys(load_info) field(key)
      where not (expected_info ? field.key)
        or (expected_info->>field.key) is distinct from (previous_report->>field.key)
    ) then
      raise exception 'This pickup was updated. Reopen Input Load Info to see the latest values.' using errcode='40001';
    end if;
    select jsonb_object_agg(field.key,nullif(btrim(field.value),'')) into changed_fields from jsonb_each_text(load_info) field;
    if changed_fields ?| array['pickupTrailer','pickupTrailerType'] then
      if previous_report->>'bobtail'='true' or coalesce(nullif(previous_report->>'trailer',''),
        nullif(previous_report->>'pickedTrailer',''),nullif(previous_report->>'droppedTrailer','')) is not null then
        raise exception 'Dispatch can correct a trailer already recorded for this stop.' using errcode='22023', hint='pickup_trailer';
      end if;
      pickup_trailer := (previous_report || changed_fields)->>'pickupTrailer';
      pickup_type := (previous_report || changed_fields)->>'pickupTrailerType';
      if pickup_trailer is not null and coalesce(pickup_type,'') not in ('fleet','power_only') then
        raise exception 'Choose Fleet or Power Only for this trailer.' using errcode='22023', hint='pickup_trailer';
      end if;
      if pickup_trailer is null then
        changed_fields := changed_fields || '{"pickupTrailerType":null}'::jsonb;
      end if;
      if pickup_type='fleet' and pickup_trailer is not null then
        expected_trailer := case
          when load.details->>'trailerPickup'='yes' and load.details->>'trailerPickupStopId'=target_stop
            and load.details->>'trailerPickupMode' is distinct from 'bobtail'
            and nullif(btrim(load.details->>'trailerPickupNumber'),'') is not null
            then btrim(load.details->>'trailerPickupNumber')
          when load.status<>'completed' and stop_state->>'completedAt' is null then
            case when load.progress ? 'dispatchTrailerOverride' then load.progress->>'dispatchTrailerOverride'
              when stop_state ? 'arrivalTrailer' then stop_state->>'arrivalTrailer'
              else fleet_internal.driver_incoming_trailer(load,assigned,target_stop) end
          else stop_state->>'arrivalTrailer'
        end;
        if nullif(btrim(expected_trailer),'') is not null
          and upper(pickup_trailer)<>upper(btrim(expected_trailer)) then
          raise exception 'Trailer number must match % for this pickup.', expected_trailer using errcode='22023', hint='pickup_trailer';
        end if;
        if (fleet_internal.registered_equipment(load.fleet_id,'trailer',pickup_trailer)).id is null then
          raise exception 'Choose a trailer saved in Equipment or select Power Only.' using errcode='22023', hint='pickup_trailer';
        end if;
      end if;
    end if;
    report := (report - array(select field.key from jsonb_each(changed_fields) field where field.value='null'::jsonb))
      || jsonb_strip_nulls(changed_fields);
  end if;

  if jsonb_typeof(documents) is distinct from 'array' then
    raise exception 'Attach paperwork as a list of files.' using errcode='22023';
  end if;
  if jsonb_array_length(documents)>20 or exists(
    select 1 from jsonb_array_elements(documents) attachment(value)
    cross join lateral (select attachment.value#>>'{}' as name) file
    where jsonb_typeof(attachment.value)<>'string'
      or split_part(file.name,'/',1)<>load.id::text or split_part(file.name,'/',2)<>actor::text
      or not exists(select 1 from storage.objects o where o.bucket_id='driver-load-documents' and o.name=file.name)
  ) then
    raise exception 'Upload up to 20 files to this load before attaching them.' using errcode='22023';
  end if;
  if documents<>'[]'::jsonb then
    combined := fleet_internal.merge_driver_stop_documents(report,documents);
    if jsonb_array_length(combined)>20 then
      raise exception 'Attach up to 20 files per stop.' using errcode='22023';
    end if;
    report := report || jsonb_build_object('document',combined->>0,'documents',combined);
  end if;
  if report=previous_report then return; end if;

  stop_state := stop_state || jsonb_build_object('driverReport',report);
  perform fleet_internal.write_driver_progress(load.id,jsonb_set(load.progress,'{stops}',
    coalesce(load.progress->'stops','{}'::jsonb) || jsonb_build_object(target_stop,stop_state)));
end;
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
  expected_departure_trailer text;
  departure_trailer text := left(btrim(coalesce(payload ->> 'trailer','')),40);
  picked_trailer text := nullif(upper(left(btrim(payload ->> 'picked_trailer'),40)),'');
  dropped_trailer text := nullif(upper(left(btrim(payload ->> 'dropped_trailer'),40)),'');
  effective_trailer text;
  selected_trailer_type text := nullif(payload->>'trailer_type','');
  pickup_trailer text;
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
    -- An outside trailer at pickup is checked against the bill entry when one
    -- exists. Delivery continuity and explicitly recorded swaps still apply.
    expected_departure_trailer := case when selected_kind='pickup' and selected_trailer_type='power_only' then
      case when event_info#>>'{driverReport,pickupTrailerType}'='power_only'
        then nullif(event_info#>>'{driverReport,pickupTrailer}','') end
      else incoming_trailer end;
    if expected_departure_trailer is not null and upper(departure_trailer)<>upper(expected_departure_trailer)
      and not bobtail and dropped_trailer is null and picked_trailer is null then
      raise exception 'Trailer mismatch. Enter the expected trailer, record a trailer drop or pickup, or select Bobtail.'
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
    effective_trailer := case when bobtail then ''
      when picked_trailer is not null then picked_trailer
      when dropped_trailer is not null and (departure_trailer='' or upper(departure_trailer)=dropped_trailer) then ''
      else nullif(departure_trailer,'') end;
    if nullif(effective_trailer,'') is not null then
      if coalesce(selected_trailer_type,'') not in ('fleet','power_only') then
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
    event_info := event_info || jsonb_build_object('completedAt',moment,'driverReport',
      (coalesce(event_info->'driverReport','{}'::jsonb) - 'document' - 'documents') || jsonb_strip_nulls(jsonb_build_object(
      'bobtail',case when bobtail then true end,
      'trailer',nullif(effective_trailer,''),
      'trailerType',case when nullif(effective_trailer,'') is not null then selected_trailer_type end,
      'commodity',nullif(left(btrim(payload ->> 'commodity'),120),''),
      'weight',nullif(left(btrim(payload ->> 'weight'),20),''),
      'pieces',nullif(left(btrim(payload ->> 'pieces'),20),''),
      'bol',nullif(left(btrim(payload ->> 'bol'),100),''),
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
