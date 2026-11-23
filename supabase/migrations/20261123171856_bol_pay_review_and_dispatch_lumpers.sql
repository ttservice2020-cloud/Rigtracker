create table fleet_internal.load_bol_pay_reviews (
  load_id uuid primary key references public.fleet_dispatch_loads(id) on delete cascade,
  status text not null check(status in ('flagged','reviewed')),
  note text not null default '' check(char_length(note)<=500),
  reviewer uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz not null default clock_timestamp()
);
create index load_bol_pay_reviews_reviewer_idx on fleet_internal.load_bol_pay_reviews(reviewer);
alter table fleet_internal.load_bol_pay_reviews enable row level security;
revoke all on fleet_internal.load_bol_pay_reviews from public,anon,authenticated;

create function fleet_internal.review_load_bol_for_pay(target_load uuid,review_status text,review_note text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  load public.fleet_dispatch_loads%rowtype;
  actor uuid := auth.uid();
  note text := left(btrim(coalesce(review_note,'')),500);
begin
  select l.* into load from public.fleet_dispatch_loads l
  where l.id=target_load and l.status='completed' and actor is not null
    and fleet_internal.company_pay_staff(actor,l.fleet_id);
  if not found then raise exception 'This load is unavailable for payroll review.' using errcode='42501'; end if;
  if review_status is null or review_status not in ('flagged','reviewed') then
    raise exception 'Choose a BOL review status.' using errcode='22023';
  end if;
  if review_status='reviewed' and not fleet_internal.load_has_driver_bol(load) then
    raise exception 'A driver must upload the BOL before it can be marked reviewed.' using errcode='22023';
  end if;
  insert into fleet_internal.load_bol_pay_reviews(load_id,status,note,reviewer)
  values(load.id,review_status,note,actor)
  on conflict(load_id) do update set status=excluded.status,note=excluded.note,reviewer=excluded.reviewer,reviewed_at=clock_timestamp();
  return jsonb_build_object('status',review_status,'note',note);
end;
$$;
create function public.review_load_bol_for_pay(target_load uuid,review_status text,review_note text default null)
returns jsonb language sql security invoker set search_path = ''
as $$select fleet_internal.review_load_bol_for_pay(target_load,review_status,review_note)$$;

create function fleet_internal.set_dispatch_stop_lumper(
  target_load uuid,target_stop text,fee numeric,paid_by text,reimburse_driver boolean,payee uuid,expected_updated_at timestamptz)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  load public.fleet_dispatch_loads%rowtype;
  stop_state jsonb;
  report jsonb;
begin
  select l.* into load from public.fleet_dispatch_loads l
  where l.id=target_load and l.status in ('current','completed') and auth.uid() is not null
    and fleet_internal.office_has_permission(l.fleet_id,'dispatch') for update;
  if not found then raise exception 'This load is unavailable for Dispatch.' using errcode='42501'; end if;
  perform fleet_internal.assert_dispatch_load_unlocked(load.id);
  if expected_updated_at is distinct from load.updated_at then
    raise exception 'The load changed. Reopen the lumper fee to save your update.' using errcode='40001';
  end if;
  if not exists(select 1 from fleet_internal.workflow_stops(load.details) s where s.stop_key=target_stop) then
    raise exception 'Choose a stop on this load.' using errcode='22023';
  end if;
  if fee is null or fee not between 0 and 99999999.99 or fee<>round(fee,2)
    or (fee>0 and coalesce(paid_by,'') not in ('driver','fleet')) then
    raise exception 'Enter the lumper fee and who paid it.' using errcode='22023';
  end if;
  if coalesce(reimburse_driver,false) then
    if fee=0 or paid_by is distinct from 'driver' or payee is null
      or (payee is distinct from load.driver_id and payee is distinct from load.second_driver_id) then
      raise exception 'Choose the assigned driver to reimburse for this stop.' using errcode='22023';
    end if;
  end if;

  -- Serialize amount changes with a paid check for either leg of a split load.
  perform pg_advisory_xact_lock(hashtextextended(load.fleet_id || ':' || assigned.profile_user_id::text,0))
  from (select distinct l.profile_user_id from public.rigtracker_fleet_links l
    where l.fleet_id=load.fleet_id and l.dispatch_driver_id in (load.driver_id,load.second_driver_id)
      and l.unlinked_at is null order by l.profile_user_id) assigned;

  stop_state := coalesce(load.progress#>array['stops',target_stop],'{}'::jsonb);
  report := coalesce(stop_state->'driverReport','{}'::jsonb);
  report := (report-'lumperPayer'-'lumperDriverId') || jsonb_strip_nulls(jsonb_build_object(
    'lumperFee',fee,'lumperPayer',case when fee>0 then paid_by end,
    'lumperReimburse',coalesce(reimburse_driver,false),
    'lumperDriverId',case when reimburse_driver then payee end));
  stop_state := stop_state || jsonb_build_object('driverReport',report);
  perform fleet_internal.write_driver_progress(load.id,jsonb_set(load.progress,'{stops}',
    coalesce(load.progress->'stops','{}'::jsonb) || jsonb_build_object(target_stop,stop_state)));
end;
$$;
create function public.set_dispatch_stop_lumper(
  target_load uuid,target_stop text,fee numeric,paid_by text,reimburse_driver boolean,payee uuid,expected_updated_at timestamptz)
returns void language sql security invoker set search_path = ''
as $$select fleet_internal.set_dispatch_stop_lumper(target_load,target_stop,fee,paid_by,reimburse_driver,payee,expected_updated_at)$$;
revoke all on function fleet_internal.review_load_bol_for_pay(uuid,text,text),public.review_load_bol_for_pay(uuid,text,text),
  fleet_internal.set_dispatch_stop_lumper(uuid,text,numeric,text,boolean,uuid,timestamptz),
  public.set_dispatch_stop_lumper(uuid,text,numeric,text,boolean,uuid,timestamptz) from public,anon,authenticated;
grant execute on function fleet_internal.review_load_bol_for_pay(uuid,text,text),public.review_load_bol_for_pay(uuid,text,text),
  fleet_internal.set_dispatch_stop_lumper(uuid,text,numeric,text,boolean,uuid,timestamptz),
  public.set_dispatch_stop_lumper(uuid,text,numeric,text,boolean,uuid,timestamptz) to authenticated;

create function fleet_internal.load_lumper_reimbursement(load public.fleet_dispatch_loads,driver uuid)
returns numeric language sql stable set search_path = ''
as $$
  select coalesce(sum((r.data->>'lumperFee')::numeric),0)
  from fleet_internal.workflow_stops((load).details) s
  cross join lateral (select (load).progress#>array['stops',s.stop_key,'driverReport'] as data) r
  where r.data->>'lumperDriverId'=driver::text and r.data->>'lumperReimburse'='true'
    and r.data->>'lumperPayer'='driver' and r.data->>'lumperFee' ~ '^[0-9]+([.][0-9]{1,2})?$';
$$;
revoke all on function fleet_internal.load_lumper_reimbursement(public.fleet_dispatch_loads,uuid) from public,anon,authenticated;

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

create or replace function fleet_internal.company_driver_load_settlements(target_fleet text, target_profile text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  dispatch_driver uuid;
begin
  if actor is null then
    raise exception 'Sign in first.' using errcode = '42501';
  end if;
  if not fleet_internal.company_pay_staff(actor, target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode = '42501';
  end if;

  select link.dispatch_driver_id into dispatch_driver
  from public.rigtracker_fleet_links link
  join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
  where link.fleet_id = target_fleet
    and profile.profile_id = target_profile
    and profile.profile_type = 'company_driver';

  if dispatch_driver is null then
    raise exception 'Company Driver is not linked to this fleet.' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'load_id', load.id,
      'pro_number', load.pro_number,
      'is_return', load.return_of is not null,
      'has_signed_bol', fleet_internal.load_has_driver_bol(load),
      'bol_review', (select jsonb_build_object('status',r.status,'note',r.note)
        from fleet_internal.load_bol_pay_reviews r where r.load_id=load.id),
      'lumper_reimbursement',fleet_internal.load_lumper_reimbursement(load,dispatch_driver),
      'route_number', load.details ->> 'routeNumber',
      'updated_at', load.updated_at,
      'completed_at', coalesce(nullif(load.progress->>'completedAt',''),load.updated_at::text),
      'created_settlement', case when settlement.id is not null then jsonb_build_object(
        'id',settlement.id,'number',settlement.settlement_number,'status',settlement.status,'line_total',line.total_pay) end,
      'pickup', load.details -> 'pickups' -> 0,
      'receiver', load.details -> 'receivers' -> 0,
      'freight', jsonb_build_object(
        'truckNumber', load.details -> 'truckNumber',
        'trailerNumber', load.details -> 'trailerNumber',
        'commodity', load.details -> 'commodity',
        'commodityOther', load.details -> 'commodityOther',
        'weightLbs', load.details -> 'weightLbs',
        'pieces', load.details -> 'pieces',
        'equipmentType', load.details -> 'equipmentType',
        'equipmentTypeOther', load.details -> 'equipmentTypeOther',
        'trailerDrop', load.details -> 'trailerDrop',
        'trailerDropNotes', load.details -> 'trailerDropNotes',
        'trailerPickup', load.details -> 'trailerPickup',
        'trailerPickupNotes', load.details -> 'trailerPickupNotes',
        'brokerName', load.details -> 'brokerName',
        'brokerPhone', load.details -> 'brokerPhone',
        'brokerEmail', load.details -> 'brokerEmail',
        'brokerLoadNumber', load.details -> 'brokerLoadNumber',
        'routeNumber', load.details -> 'routeNumber',
        'pickupNumber', load.details -> 'pickupNumber',
        'stopPay', load.details -> 'stopPay',
        'driver1AdditionalPay', load.details -> 'driver1AdditionalPay',
        'driver2AdditionalPay', load.details -> 'driver2AdditionalPay',
        'rateConfirmation', load.details -> 'rateConfirmation'
      ),
      'pickup_reports', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', 'pickup',
          'stop', stop.value,
          'report', load.progress #> array['stops', coalesce(nullif(stop.value ->> 'stopId', ''), 'pickup-' || (stop.ordinality - 1)::text), 'driverReport']
        ))
        from jsonb_array_elements(coalesce(load.details -> 'pickups', '[]'::jsonb)) with ordinality as stop(value, ordinality)
      ), '[]'::jsonb),
      'receiver_reports', coalesce((
        select jsonb_agg(jsonb_build_object(
          'kind', 'receiver',
          'stop', stop.value,
          'report', load.progress #> array['stops', coalesce(nullif(stop.value ->> 'stopId', ''), 'receiver-' || (stop.ordinality - 1)::text), 'driverReport']
        ))
        from jsonb_array_elements(coalesce(load.details -> 'receivers', '[]'::jsonb)) with ordinality as stop(value, ordinality)
      ), '[]'::jsonb),
      'loaded_miles', case when load.driver_id = dispatch_driver
        then coalesce(nullif(load.details ->> 'firstLegMiles', '')::numeric, nullif(load.details ->> 'loadedMiles', '')::numeric)
        else case when nullif(load.details ->> 'firstLegMiles', '') is null
          then nullif(load.details ->> 'loadedMiles', '')::numeric
          else greatest(0, coalesce(nullif(load.details ->> 'loadedMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegMiles', '')::numeric) end end,
      'empty_miles', case when load.driver_id = dispatch_driver
        then coalesce(nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric,
          case when load.second_driver_id is null then nullif(load.details ->> 'emptyMiles', '')::numeric else null end)
        else case when nullif(load.details ->> 'firstLegEmptyMiles', '') is null
          then nullif(load.details ->> 'emptyMiles', '')::numeric
          else greatest(0, coalesce(nullif(load.details ->> 'emptyMiles', '')::numeric, 0) - nullif(load.details ->> 'firstLegEmptyMiles', '')::numeric) end end,
      'gross', nullif(load.details ->> 'payGross', '')::numeric,
      'stop_pay', case when load.driver_id = dispatch_driver then coalesce(nullif(load.details ->> 'stopPay', '')::numeric, 0) else 0 end,
      'driver_slot', case when load.driver_id = dispatch_driver then 1 else 2 end,
      'pay_scale', (
        select jsonb_build_object(
          'driver_type', driver.driver_type,
          'method', coalesce(driver.pay_method, case when driver.driver_type = 'company' then 'per_load' else null end),
          'split_percent', driver.split_percent,
          'mile_rate', driver.mile_rate,
          'empty_mile_rate', driver.empty_mile_rate
        )
        from public.fleet_dispatch_drivers driver
        where driver.id = dispatch_driver and driver.fleet_id = target_fleet
      ),
      'pay_entry', (
        select entry.value
        from jsonb_array_elements(coalesce(load.details #> '{driverPay,drivers}', '[]'::jsonb)) entry(value)
        where entry.value ->> 'slot' = case when load.driver_id = dispatch_driver then '1' else '2' end
        limit 1
      ),
      'manual_pay', nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1Pay' else 'driver2Pay' end, '')::numeric,
      'additional_pay', coalesce(nullif(load.details ->> case when load.driver_id = dispatch_driver then 'driver1AdditionalPay' else 'driver2AdditionalPay' end, '')::numeric, 0)
    ) order by load.updated_at desc)
    from public.fleet_dispatch_loads load
    left join fleet_internal.company_driver_settlement_lines line
      on line.fleet_id=load.fleet_id and line.load_id=load.id and line.driver_profile_id=target_profile
    left join fleet_internal.company_driver_settlements settlement
      on settlement.fleet_id=load.fleet_id and settlement.id=line.settlement_id
    where load.fleet_id = target_fleet
      and load.status = 'completed'
      and (settlement.id is not null or fleet_internal.load_ready_for_settlement(load))
      and (load.driver_id = dispatch_driver or load.second_driver_id = dispatch_driver)
  ), '[]'::jsonb);
end;
$function$;

create or replace function fleet_internal.company_payroll_saved_settlements(target_fleet text, requested_settlement_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not fleet_internal.company_pay_staff(actor,target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',draft.id,'driver_profile_id',draft.driver_profile_id,
      'paid',exists(select 1 from fleet_internal.payroll_paid_checks c where c.settlement_id=draft.id),
      'settlement_number',draft.settlement_number,'created_at',draft.created_at,
      'load_count',draft.load_count,'total_pay',draft.total_pay,
      'driver',concat_ws(' ',profile.first_name,profile.last_name),'sent_for_review',publication.sent,
      'lines',case when requested_settlement_id is not null then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'pro_number',line.pro_number,'is_return',load.return_of is not null,
          'pickup',coalesce(line.load_snapshot->'pickup',load.details#>'{pickups,0}'),
          'receiver',coalesce(line.load_snapshot->'receiver',load.details#>'{receivers,0}'),
          'total_pay',line.total_pay,
          'lumper_reimbursement',fleet_internal.load_lumper_reimbursement(load,
            fleet_internal.workflow_driver(draft.driver_user_id,draft.fleet_id)),
          'has_signed_bol',fleet_internal.load_has_driver_bol(load),
          'loaded_miles',line.loaded_miles,'empty_miles',line.empty_miles,
          'pay_scale',line.pay_scale,'base_pay',line.base_pay,'base_pay_entered',line.base_pay_entered,
          'empty_mile_pay',line.empty_mile_pay,'stop_pay',line.stop_pay,'additional_pay',line.additional_pay
        ) order by line.created_at,line.pro_number),'[]'::jsonb)
        from fleet_internal.company_driver_settlement_lines line
        join public.fleet_dispatch_loads load on load.fleet_id=line.fleet_id and load.id=line.load_id
        where line.fleet_id=draft.fleet_id and line.settlement_id=draft.id
      ) end
    ) order by draft.created_at desc,draft.id)
    from fleet_internal.company_driver_settlements draft
    join public.rigtracker_profiles profile on profile.user_id=draft.driver_user_id
    cross join lateral (select exists (
      select 1 from fleet_internal.company_driver_pay_files f
      where f.fleet_id=draft.fleet_id and f.driver_id=draft.driver_user_id
        and (f.settlement_id=draft.id or lower(btrim(f.title))=lower(draft.settlement_number))
    ) as sent) publication
    where draft.fleet_id=target_fleet
      and case when requested_settlement_id is null then not publication.sent else draft.id=requested_settlement_id end
  ),'[]'::jsonb);
end;
$$;



create or replace function fleet_internal.driver_profile_bol_access(object_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.fleet_dispatch_loads q
    where q.id=case when split_part(object_name,'/',1) ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      then split_part(object_name,'/',1)::uuid end
    and (fleet_internal.driver_profile_access(q.fleet_id,'driver_bols')
      or (q.status='completed' and auth.uid() is not null and fleet_internal.company_pay_staff(auth.uid(),q.fleet_id))));
$$;

create or replace function fleet_internal.check_paid_statement_load_count()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  check_lumper numeric;
begin
  if new.settlement_id is not null and new.statement ? 'loadCount'
    and (select d.load_count from fleet_internal.company_driver_settlements d where d.id=new.settlement_id)
      is distinct from (new.statement->>'loadCount')::integer then
    raise exception 'Loads changed on this statement. Reopen the statement before recording payment.' using errcode='40001';
  end if;
  if new.settlement_id is not null and new.statement ? 'lumperTotal' then
    select coalesce(sum(fleet_internal.load_lumper_reimbursement(l,
      fleet_internal.workflow_driver(d.driver_user_id,d.fleet_id))),0) into check_lumper
    from fleet_internal.company_driver_settlements d
    join fleet_internal.company_driver_settlement_lines sl on sl.settlement_id=d.id and sl.fleet_id=d.fleet_id
    join public.fleet_dispatch_loads l on l.id=sl.load_id and l.fleet_id=d.fleet_id
    where d.id=new.settlement_id;
    if check_lumper is distinct from (new.statement->>'lumperTotal')::numeric then
      raise exception 'Lumper reimbursement changed. Reopen the statement before recording payment.' using errcode='40001';
    end if;
  end if;
  return new;
end;
$$;
