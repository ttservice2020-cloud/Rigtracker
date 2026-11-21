alter table public.fleet_dispatch_drivers
  drop constraint fleet_dispatch_driver_pay_profile,
  add constraint fleet_dispatch_driver_pay_profile check (
    case driver_type
      when 'company' then (pay_method is null or pay_method='hourly') and split_percent is null and mile_rate is null
      when 'owner_op' then
        case pay_method
          when 'hourly' then split_percent is null and mile_rate is null
          when 'split' then split_percent is not null and split_percent between 0 and 100 and mile_rate is null
          when 'per_mile' then split_percent is null and mile_rate is not null and mile_rate between 0 and 9999
          else false
        end
      else driver_type is null and pay_method is null and split_percent is null and mile_rate is null
    end
  );

-- Used by the existing driver workflow after checking current fleet membership and load assignment.
create function fleet_internal.driver_offer_pay(details jsonb, assigned uuid, profile_type text, active_method text)
returns jsonb
language sql immutable security invoker set search_path = ''
as $$
  select case
    when active_method='hourly' or entry ->> 'method'='hourly' then null
    when profile_type='company_driver' and coalesce(entry ->> 'type','company')='company'
      and (manual_pay is not null or entry ->> 'additionalPay' is not null) then
      jsonb_strip_nulls(jsonb_build_object(
        'type','company','amount',manual_pay,'additionalPay',entry -> 'additionalPay',
        'totalPay',entry -> 'totalPay'))
    when profile_type='driver' and entry ->> 'type'='owner_op' and entry ->> 'method'='split' then
      jsonb_strip_nulls(jsonb_build_object(
        'type','owner_op','method','split','amount',entry -> 'amount',
        'additionalPay',entry -> 'additionalPay','totalPay',entry -> 'totalPay',
        'splitPercent',entry -> 'splitPercent','gross',details #> '{driverPay,gross}',
        'loadedMiles',details #> '{driverPay,loadedMiles}','fuelRateCents',details #> '{driverPay,fuelRateCents}',
        'fuelSurcharge',details #> '{driverPay,fuelSurcharge}','splitBase',details #> '{driverPay,splitBase}'))
    when profile_type='driver' and entry ->> 'type'='owner_op' and entry ->> 'method'='per_mile' then
      jsonb_strip_nulls(jsonb_build_object(
        'type','owner_op','method','per_mile','amount',entry -> 'amount',
        'additionalPay',entry -> 'additionalPay','totalPay',entry -> 'totalPay',
        'mileRate',entry -> 'mileRate','miles',entry -> 'miles'))
    end
  from jsonb_array_elements(case when jsonb_typeof(details #> '{driverPay,drivers}')='array'
    then details #> '{driverPay,drivers}' else '[]'::jsonb end) as pay(entry)
  cross join lateral (
    select case when details ->> ('driver' || (entry ->> 'slot') || 'Pay')
        ~ '^([0-9]{1,12}(\.[0-9]{0,2})?|\.[0-9]{1,2})$'
      then (details ->> ('driver' || (entry ->> 'slot') || 'Pay'))::numeric
    end as manual_pay
  ) as own_pay
  where entry ->> 'driverId'=assigned::text
  limit 1;
$$;

revoke all on function fleet_internal.driver_offer_pay(jsonb,uuid,text,text) from public, anon, authenticated;

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
  path text;
  moment timestamptz := clock_timestamp();
begin
  if actor is null then raise exception 'Sign in as a driver.' using errcode='42501'; end if;
  if action='list' then
    return jsonb_build_object(
      'loads',coalesce((
        select jsonb_agg(summary order by changed desc) from (
          select loads.updated_at as changed, jsonb_build_object(
            'id',loads.id,'fleet',loads.fleet_id,'pro',loads.pro_number,'return_of',loads.return_of,
            'review',loads.return_review,'status',loads.status,
            'decision',loads.progress #>> array['driverResponses',links.dispatch_driver_id::text,'decision'],
            'offer',case when loads.status='current' and
                loads.progress #>> array['driverResponses',links.dispatch_driver_id::text,'decision'] is null then
              jsonb_build_object(
                'freight',jsonb_strip_nulls(jsonb_build_object(
                  'commodity',coalesce(nullif(case when loads.details ->> 'commodity'='Other'
                    then loads.details ->> 'commodityOther' end,''),nullif(loads.details ->> 'commodity','')),
                  'equipment',coalesce(nullif(case when loads.details ->> 'equipmentType'='Other'
                    then loads.details ->> 'equipmentTypeOther' end,''),nullif(loads.details ->> 'equipmentType','')),
                  'weight',nullif(loads.details ->> 'weightLbs',''),
                  'pieces',nullif(loads.details ->> 'pieces',''),
                  'route',nullif(loads.details ->> 'routeNumber',''),
                  'miles',nullif(loads.details ->> 'loadedMiles',''),
                  'pickupNumber',nullif(loads.details ->> 'pickupNumber',''),
                  'trailerDrop',case when loads.details ->> 'trailerDrop'='yes'
                    then coalesce(nullif(loads.details ->> 'trailerDropNotes',''),'Yes') end,
                  'trailerPickup',case when loads.details ->> 'trailerPickup'='yes'
                    then coalesce(nullif(loads.details ->> 'trailerPickupNotes',''),'Yes') end
                )),
                'pay',fleet_internal.driver_offer_pay(loads.details,links.dispatch_driver_id,p.profile_type,d.pay_method))
            end,
            'yard_handoff',(select jsonb_build_object('yard',y.yard,'trailer',y.trailer,'picked_up_at',y.picked_up_at,
              'first_driver',loads.driver_id=links.dispatch_driver_id)
              from fleet_internal.driver_yard_handoffs y where y.load_id=loads.id),
            'stops',coalesce((select jsonb_agg(jsonb_build_object('key',s.stop_key,'kind',s.kind,'info',s.info - 'driver1' - 'driver2',
                 'progress',loads.progress #> array['stops',s.stop_key]) order by s.sequence_no)
               from fleet_internal.workflow_stops(loads.details) s
               where (loads.driver_id=links.dispatch_driver_id and coalesce(s.info ->> 'driver1','true') <> 'false')
                  or (loads.second_driver_id=links.dispatch_driver_id and (
                      case when exists(select 1 from fleet_internal.driver_yard_handoffs y where y.load_id=loads.id and y.confirmed_at is not null)
                        then s.kind='delivery' else s.info ->> 'driver2'='true' end))), '[]'::jsonb)
          ) as summary
          from public.rigtracker_fleet_links links
          join public.rigtracker_profiles p on p.user_id=links.profile_user_id and not p.password_required
          join public.fleet_dispatch_drivers d on d.id=links.dispatch_driver_id and d.fleet_id=links.fleet_id
          join public.fleet_dispatch_loads loads on loads.fleet_id=links.fleet_id
            and links.dispatch_driver_id in (loads.driver_id,loads.second_driver_id)
          where links.profile_user_id=actor and links.unlinked_at is null
            and (loads.status in ('current','completed') or loads.return_review is not null)
          order by loads.updated_at desc limit 150
        ) selected
      ),'[]'::jsonb),
      'yard',coalesce((
        select jsonb_agg(jsonb_build_object('id',y.load_id,'trailer',y.trailer,'yard',y.yard,'picked_up_at',y.picked_up_at,
          'pro',loads.pro_number,'return_of',loads.return_of) order by y.yard,y.trailer)
        from fleet_internal.driver_yard_handoffs y join public.fleet_dispatch_loads loads on loads.id=y.load_id
        where y.confirmed_at is null and loads.status='current' and y.offered_driver=fleet_internal.workflow_driver(actor,y.fleet_id)
      ),'[]'::jsonb));
  end if;

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
    if handoff.picked_up_at is null then
      update fleet_internal.driver_yard_handoffs set picked_up_at=moment where driver_yard_handoffs.load_id=l.id;
      update public.fleet_dispatch_loads set progress=progress || jsonb_build_object('yardPickedUpAt',moment) where id=l.id;
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
    update public.fleet_dispatch_loads set progress=row_progress where id=l.id;
    return '{}'::jsonb;
  end if;
  if row_progress #>> array['driverResponses',assigned::text,'decision'] is distinct from 'accepted' then
    raise exception 'Accept the assignment before working the load.' using errcode='22023';
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
    values(request_key,l.fleet_id,next_pro,'draft',assigned,jsonb_build_object('pickups',jsonb_build_array(pickup),'receivers',jsonb_build_array(receiver)),
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
  select s.stop_key into selected_stop from fleet_internal.workflow_stops(l.details) s
    where l.progress #>> array['stops',s.stop_key,'completedAt'] is null
      and ((l.driver_id=assigned and coalesce(s.info ->> 'driver1','true') <> 'false')
      or (l.second_driver_id=assigned and (
        case when exists(select 1 from fleet_internal.driver_yard_handoffs y where y.load_id=l.id and y.confirmed_at is not null)
          then s.kind='delivery' else s.info ->> 'driver2'='true' end)))
    order by s.sequence_no limit 1;
  if selected_stop is null or selected_stop is distinct from payload ->> 'stop' then
    raise exception 'Refresh the load and select your next stop.' using errcode='22023';
  end if;
  event_info := coalesce(row_progress #> array['stops',selected_stop],'{}'::jsonb);
  if action='arrive' then
    if not (event_info ? 'arrivalAt') then event_info := event_info || jsonb_build_object('arrivalAt',moment); end if;
  else
    if not (event_info ? 'arrivalAt') then raise exception 'Record arrival at the stop first.' using errcode='22023'; end if;
    path := nullif(payload ->> 'document','');
    if path is not null and (split_part(path,'/',1)<>l.id::text or split_part(path,'/',2)<>actor::text or not exists(
      select 1 from storage.objects where bucket_id='driver-load-documents' and name=path
    )) then raise exception 'Upload the document to this load first.' using errcode='22023'; end if;
    if nullif(payload ->> 'picked_trailer','') is not null and coalesce(payload ->> 'loaded_state','') not in ('loaded','empty') then
      raise exception 'Mark the picked-up trailer Loaded or Empty.' using errcode='22023';
    end if;
    event_info := event_info || jsonb_build_object('completedAt',moment,'driverReport',jsonb_strip_nulls(jsonb_build_object(
      'trailer',nullif(left(btrim(payload ->> 'trailer'),40),''),
      'commodity',nullif(left(btrim(payload ->> 'commodity'),120),''),
      'weight',nullif(left(btrim(payload ->> 'weight'),20),''),
      'pieces',nullif(left(btrim(payload ->> 'pieces'),20),''),
      'bol',nullif(left(btrim(payload ->> 'bol'),100),''),
      'droppedTrailer',nullif(upper(left(btrim(payload ->> 'dropped_trailer'),40)),''),
      'pickedTrailer',nullif(upper(left(btrim(payload ->> 'picked_trailer'),40)),''),
      'loadedState',nullif(left(payload ->> 'loaded_state',10),''),
      'document',path,'at',moment
    )));
  end if;
  update public.fleet_dispatch_loads set progress=jsonb_set(row_progress,array['stops',selected_stop],event_info) where id=l.id;
  return '{}'::jsonb;
end;
$function$;
