-- A short lease makes the load view read-only to other dispatchers. The load row
-- serializes both lease changes and mutations that can change that load.
create table fleet_internal.dispatch_load_leases (
  load_id uuid primary key references public.fleet_dispatch_loads(id) on delete cascade,
  holder uuid not null,
  session_id uuid not null,
  expires_at timestamptz not null
);
revoke all on fleet_internal.dispatch_load_leases from public, anon, authenticated;

create function fleet_internal.assert_dispatch_load_unlocked(target_id uuid)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if exists(select 1 from fleet_internal.dispatch_load_leases lease where lease.load_id=target_id
      and lease.expires_at>clock_timestamp() and lease.holder is distinct from auth.uid()) then
    raise exception 'Another dispatcher has this load open. You can view it until they close it.' using errcode='55P03';
  end if;
end;
$$;
revoke all on function fleet_internal.assert_dispatch_load_unlocked(uuid) from public, anon, authenticated;

create function fleet_internal.guard_dispatch_load_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if current_setting('rigtracker.driver_progress_load',true) is distinct from old.id::text
    and fleet_internal.office_has_permission(old.fleet_id,'dispatch') then
    perform fleet_internal.assert_dispatch_load_unlocked(old.id);
  end if;
  if old.status='current' and new.status is distinct from old.status and new.progress #>> '{breakdown,active}'='true' then
    raise exception 'Mark the load back on the road or recovered before completing it.' using errcode='22023';
  end if;
  if new.status='completed' and new.progress #>> '{traffic,active}'='true' then
    raise exception 'Clear the traffic delay before completing this load.' using errcode='22023';
  end if;
  return new;
end;
$$;
revoke all on function fleet_internal.guard_dispatch_load_update() from public, anon, authenticated;
create trigger fleet_dispatch_guard_load_update before update on public.fleet_dispatch_loads
for each row execute function fleet_internal.guard_dispatch_load_update();

-- The driver workflow has already verified the actor's assignment. Driver progress
-- continues while an office user holds the dispatch lease, including dual-role users.
create function fleet_internal.write_driver_progress(target_id uuid, updated_progress jsonb)
returns void language plpgsql set search_path = ''
as $$
declare
  previous text := current_setting('rigtracker.driver_progress_load',true);
begin
  perform set_config('rigtracker.driver_progress_load',target_id::text,true);
  update public.fleet_dispatch_loads set progress=updated_progress where id=target_id;
  perform set_config('rigtracker.driver_progress_load',coalesce(previous,''),true);
end;
$$;
revoke all on function fleet_internal.write_driver_progress(uuid,jsonb) from public, anon, authenticated;

create function fleet_internal.append_load_note(progress jsonb, label text, body text, source text, noted_at timestamptz)
returns jsonb language sql immutable set search_path = ''
as $$
  select jsonb_set(progress,'{loadNotes}',coalesce(progress -> 'loadNotes','[]'::jsonb) ||
    jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('label',label,'body',nullif(body,''),'source',source,'at',noted_at))));
$$;
revoke all on function fleet_internal.append_load_note(jsonb,text,text,text,timestamptz) from public, anon, authenticated;

create function fleet_internal.dispatch_load_control(
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
    insert into fleet_internal.dispatch_load_leases as lease(load_id,holder,session_id,expires_at)
      values(target_id,actor,dispatch_load_control.session_id,clock_timestamp()+interval '60 seconds')
      on conflict (load_id) do update set holder=excluded.holder, session_id=excluded.session_id, expires_at=excluded.expires_at
      where lease.expires_at<=clock_timestamp() or (lease.holder=actor and lease.session_id=excluded.session_id);
    return jsonb_build_object('writable',found);
  end if;
  if action not in ('resolve_breakdown','add_note','report_traffic','clear_traffic') or action is null then
    raise exception 'Choose a supported load action.' using errcode='22023';
  end if;
  if char_length(note_text)>1000 then raise exception 'Enter a note up to 1,000 characters.' using errcode='22023'; end if;
  if action<>'add_note' and load.status<>'current' then raise exception 'Open an active load to update its status.' using errcode='22023'; end if;
  select exists(select 1 from fleet_internal.dispatch_load_leases lease where lease.load_id=target_id
    and lease.holder=actor and lease.session_id=dispatch_load_control.session_id and lease.expires_at>clock_timestamp()) into owned;
  if not owned then raise exception 'Open this load for editing before making changes.' using errcode='55P03'; end if;
  new_progress := load.progress;
  if action='add_note' then
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

create function public.dispatch_load_control(action text, target_id uuid, session_id uuid,
  report_id uuid default null, resolution text default null, note text default null)
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.dispatch_load_control(action,target_id,session_id,report_id,resolution,note); $$;
revoke all on function fleet_internal.dispatch_load_control(text,uuid,uuid,uuid,text,text),
  public.dispatch_load_control(text,uuid,uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function fleet_internal.dispatch_load_control(text,uuid,uuid,uuid,text,text),
  public.dispatch_load_control(text,uuid,uuid,uuid,text,text) to authenticated;

-- Older stop reports contain one document path. Keep their existing file and map
-- newer reports to the same ordered rows used by dispatch and driver history.
create function fleet_internal.driver_report_documents(report jsonb)
returns table(path text, file_order bigint)
language sql immutable security invoker set search_path = ''
as $$
  select file.path, file.file_order
  from jsonb_array_elements_text(case
    when jsonb_typeof(report -> 'documents') = 'array' and report -> 'documents' <> '[]'::jsonb then report -> 'documents'
    when nullif(report ->> 'document','') is not null then jsonb_build_array(report ->> 'document')
    else '[]'::jsonb
  end) with ordinality as file(path, file_order);
$$;

revoke all on function fleet_internal.driver_report_documents(jsonb) from public, anon, authenticated;

-- Acceptance reserves a place in the driver's queue. Work already underway
-- stays first, including loads underway when this migration is applied.
create function fleet_internal.driver_load_queue(target_actor uuid)
returns table(load_id uuid, queue_position bigint)
language sql stable set search_path = ''
as $$
  select l.id, row_number() over (order by
    (coalesce(assigned_stops.started,false)
      or (l.driver_id=link.dispatch_driver_id and l.progress ->> 'enRouteAt' is not null)) desc,
    (l.progress #>> array['driverResponses',link.dispatch_driver_id::text,'at'])::timestamptz nulls last,
    l.created_at,l.id)
  from public.rigtracker_fleet_links link
  join public.rigtracker_profiles profile on profile.user_id=link.profile_user_id and not profile.password_required
  join public.fleet_dispatch_loads l on l.fleet_id=link.fleet_id
    and link.dispatch_driver_id in (l.driver_id,l.second_driver_id)
  left join fleet_internal.driver_yard_handoffs yard on yard.load_id=l.id
  cross join lateral (
    select bool_or(l.progress #>> array['stops',stop.stop_key,'arrivalAt'] is not null
        or l.progress #>> array['stops',stop.stop_key,'completedAt'] is not null) as started,
      count(*) filter(where l.progress #>> array['stops',stop.stop_key,'completedAt'] is null) as remaining
    from fleet_internal.workflow_stops(l.details) stop
    where (l.driver_id=link.dispatch_driver_id and coalesce(stop.info ->> 'driver1','true')<>'false')
      or (l.second_driver_id=link.dispatch_driver_id and
        case when yard.confirmed_at is not null then stop.kind='delivery' else stop.info ->> 'driver2'='true' end)
  ) assigned_stops
  where link.profile_user_id=target_actor and link.unlinked_at is null
    and (l.status='current' or l.return_review='pending')
    and l.progress #>> array['driverResponses',link.dispatch_driver_id::text,'decision']='accepted'
    and not (l.driver_id=link.dispatch_driver_id and yard.picked_up_at is not null)
    and (assigned_stops.remaining>0 or l.progress #>> '{breakdown,active}'='true' or l.progress #>> '{traffic,active}'='true');
$$;
revoke all on function fleet_internal.driver_load_queue(uuid) from public, anon, authenticated;

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
    if nullif(payload ->> 'picked_trailer','') is not null and coalesce(payload ->> 'loaded_state','') not in ('loaded','empty') then
      raise exception 'Mark the picked-up trailer Loaded or Empty.' using errcode='22023';
    end if;
    lumper_fee := nullif(btrim(payload ->> 'lumperFee'),'');
    if lumper_fee !~ '^([0-9]{1,12}(\.[0-9]{1,2})?|\.[0-9]{1,2})$' then
      raise exception 'Enter a valid lumper fee in dollars, such as 125.50, or leave it blank.' using errcode='22023';
    end if;
    event_info := event_info || jsonb_build_object('completedAt',moment,'driverReport',jsonb_strip_nulls(jsonb_build_object(
      'trailer',nullif(left(btrim(payload ->> 'trailer'),40),''),
      'commodity',nullif(left(btrim(payload ->> 'commodity'),120),''),
      'weight',nullif(left(btrim(payload ->> 'weight'),20),''),
      'pieces',nullif(left(btrim(payload ->> 'pieces'),20),''),
      'bol',nullif(left(btrim(payload ->> 'bol'),100),''),
      'lumperFee',lumper_fee::numeric,
      'droppedTrailer',nullif(upper(left(btrim(payload ->> 'dropped_trailer'),40)),''),
      'pickedTrailer',nullif(upper(left(btrim(payload ->> 'picked_trailer'),40)),''),
      'loadedState',nullif(left(payload ->> 'loaded_state',10),''),
      'document',documents ->> 0,
      'documents',nullif(documents,'[]'::jsonb),'at',moment
    )));
  end if;
  perform fleet_internal.write_driver_progress(l.id,jsonb_set(row_progress,array['stops',selected_stop],event_info));
  return '{}'::jsonb;
end;
$function$;

create or replace function fleet_internal.list_fleet_bol_payments(
  target_fleet text,
  paid boolean,
  target_pro text,
  pro_prefix text,
  before_date date,
  before_time timestamptz,
  before_load uuid
)
returns table (
  load_id uuid,
  pro_number text,
  return_load boolean,
  delivered_at text,
  paid_on date,
  sort_at timestamptz,
  destination text,
  paperwork jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  requested_number bigint;
begin
  if not fleet_internal.office_has_permission(target_fleet, 'bol_payments') then
    raise exception 'BOLs & Payments access is required.' using errcode = '42501';
  end if;

  if target_pro is not null then
    if target_pro !~ '^[0-9]{1,19}$' then
      return;
    end if;
    if target_pro::numeric > 9223372036854775807 then
      return;
    end if;
    requested_number := target_pro::bigint;
  end if;

  return query
  with candidate_loads as (
    (
      select l.id, null::date as payment_date, l.updated_at as sort_time
      from public.fleet_dispatch_loads l
      where not paid
        and l.fleet_id = target_fleet
        and l.status = 'completed'
        and (requested_number is null or l.pro_number = requested_number)
        and (pro_prefix is null or pro_prefix = case when l.return_of is null then 'A' else 'B' end)
        and (before_load is null or (l.updated_at, l.id) < (before_time, before_load))
        and not exists (
          select 1 from fleet_internal.load_customer_payments p
          where p.fleet_id = target_fleet and p.load_id = l.id
        )
      order by l.updated_at desc, l.id desc
      limit 31
    )
    union all
    (
      select l.id, p.paid_on, p.recorded_at
      from fleet_internal.load_customer_payments p
      join public.fleet_dispatch_loads l on l.fleet_id = p.fleet_id and l.id = p.load_id
      where paid
        and p.fleet_id = target_fleet
        and l.status = 'completed'
        and (requested_number is null or l.pro_number = requested_number)
        and (pro_prefix is null or pro_prefix = case when l.return_of is null then 'A' else 'B' end)
        and (before_load is null or (p.paid_on, p.recorded_at, p.load_id) < (before_date, before_time, before_load))
      order by p.paid_on desc, p.recorded_at desc, p.load_id desc
      limit 31
    )
  )
  select l.id, l.pro_number::text, l.return_of is not null,
    coalesce(nullif(l.progress ->> 'completedAt', ''), l.updated_at::text),
    c.payment_date, c.sort_time,
    concat_ws(', ',
      nullif(l.details #>> '{receivers,-1,company}', ''),
      nullif(l.details #>> '{receivers,-1,city}', ''),
      nullif(l.details #>> '{receivers,-1,state}', '')
    ),
    coalesce(d.documents, '[]'::jsonb)
  from candidate_loads c
  join public.fleet_dispatch_loads l on l.fleet_id = target_fleet and l.id = c.id
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'kind', s.kind,
      'company', s.info ->> 'company',
      'bol', r.report ->> 'bol',
      'path', file.path
    ) order by s.sequence_no, file.file_order) as documents
    from fleet_internal.workflow_stops(l.details) s
    cross join lateral (select l.progress #> array['stops', s.stop_key, 'driverReport'] as report) r
    cross join lateral fleet_internal.driver_report_documents(r.report) file
    where split_part(file.path, '/', 1) = l.id::text
  ) d on true
  order by c.payment_date desc, c.sort_time desc, c.id desc;
end;
$$;

create or replace function fleet_internal.fleet_company_driver_profile(
  action text, target_fleet text, profile_number text, roster_driver uuid,
  before_time timestamptz, before_load uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  driver record;
  recent_activity jsonb;
begin
  if not exists(select 1 from public.fleets f where f.id = target_fleet and f.admin_user_id = (select auth.uid())) then
    raise exception 'Fleet Admin access is required to view this driver profile.' using errcode = '42501';
  end if;

  select p.user_id, p.profile_id, p.display_profile_id, p.first_name, p.last_name, p.phone, p.license_number,
    l.employee_number, l.dispatch_driver_id, l.unlinked_at, d.equipment, d.availability
  into driver
  from public.rigtracker_fleet_links l
  join public.rigtracker_profiles p on p.user_id = l.profile_user_id and p.profile_type = 'company_driver'
  left join public.fleet_dispatch_drivers d on d.id = l.dispatch_driver_id and d.fleet_id = l.fleet_id
  where l.fleet_id = target_fleet and (
    (profile_number is not null and p.profile_id = profile_number)
    or (roster_driver is not null and l.dispatch_driver_id = roster_driver and l.unlinked_at is null)
  );
  if not found then
    raise exception 'This driver does not have a Company Driver profile linked to your fleet.' using errcode = '22023';
  end if;

  if action in ('overview', 'presence') then
    select jsonb_build_object('last_seen_at', p.last_seen_at, 'online',
      p.last_seen_at >= statement_timestamp() - interval '2 minutes')
    into recent_activity from fleet_internal.company_driver_presence p
    where p.user_id = driver.user_id and driver.unlinked_at is null;
    if action = 'presence' then return coalesce(recent_activity, '{}'::jsonb); end if;
    return jsonb_build_object('profile_id', driver.profile_id, 'display_profile_id', driver.display_profile_id, 'first_name', driver.first_name,
      'last_name', driver.last_name, 'employee_number', driver.employee_number,
      'linked', driver.unlinked_at is null, 'dispatch_driver_id', driver.dispatch_driver_id, 'equipment', driver.equipment,
      'availability', case
        when driver.unlinked_at is not null then null
        when exists(select 1 from public.fleet_dispatch_loads l
          where l.fleet_id = target_fleet and l.status = 'current'
            and driver.dispatch_driver_id in (l.driver_id, l.second_driver_id)) then 'assigned'
        else driver.availability end,
      'email', case when driver.unlinked_at is null then (select u.email from auth.users u where u.id = driver.user_id) end,
      'phone', case when driver.unlinked_at is null then driver.phone end,
      'license_number', case when driver.unlinked_at is null then driver.license_number end,
      'presence', coalesce(recent_activity, '{}'::jsonb));
  end if;

  if action <> 'history' or action is null then
    raise exception 'Choose a driver profile section.' using errcode = '22023';
  end if;

  return (
    with candidate_loads as (
      (
        select l.id, l.updated_at from public.fleet_dispatch_loads l
        where l.fleet_id = target_fleet and l.status = 'completed' and l.driver_id = driver.dispatch_driver_id
          and (before_load is null or (l.updated_at, l.id) < (before_time, before_load))
        order by l.updated_at desc, l.id desc limit 26
      )
      union all
      (
        select l.id, l.updated_at from public.fleet_dispatch_loads l
        where l.fleet_id = target_fleet and l.status = 'completed' and l.second_driver_id = driver.dispatch_driver_id
          and (before_load is null or (l.updated_at, l.id) < (before_time, before_load))
        order by l.updated_at desc, l.id desc limit 26
      )
    ), page as (
      select c.id from candidate_loads c order by c.updated_at desc, c.id desc limit 26
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'load_id', l.id, 'pro_number', l.pro_number::text, 'return_load', l.return_of is not null,
      'updated_at', l.updated_at, 'completed_at', coalesce(l.progress ->> 'completedAt', l.updated_at::text),
      'origin', l.details #>> '{pickups,0,company}', 'destination', l.details #>> '{receivers,-1,company}',
      'paperwork', coalesce(documents.files, '[]'::jsonb)
    ) order by l.updated_at desc, l.id desc), '[]'::jsonb)
    from page p join public.fleet_dispatch_loads l on l.id = p.id
    left join lateral (
      select jsonb_agg(jsonb_build_object('kind', s.kind, 'path', file.path) order by s.sequence_no, file.file_order) as files
      from fleet_internal.workflow_stops(l.details) s
      cross join lateral fleet_internal.driver_report_documents(l.progress #> array['stops', s.stop_key, 'driverReport']) file
      where split_part(file.path, '/', 1) = l.id::text
    ) documents on true
  );
end;
$$;

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
          'source_pro',source.pro_number) order by q.created_at)
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

alter table fleet_internal.company_messages add column image_path text;
alter table fleet_internal.company_messages drop constraint company_messages_body_check,
  add constraint company_messages_content_check check
    (char_length(body) <= 4000 and (char_length(body) > 0 or image_path is not null));
create unique index company_messages_image_path on fleet_internal.company_messages(image_path) where image_path is not null;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('company-message-images','company-message-images',false,10485760,
  array['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif']);

create function fleet_internal.company_message_image_access(object_name text, writing boolean)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  chat fleet_internal.company_message_threads%rowtype;
begin
  if actor is null or object_name !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f-]{36}\.(jpg|png|webp|gif|heic|heif)$'
    or split_part(object_name,'/',1) !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then return false; end if;
  select * into chat from fleet_internal.company_message_threads where id=split_part(object_name,'/',1)::uuid;
  if not found or not fleet_internal.message_thread_visible(chat,actor) then return false; end if;
  if writing then
    return split_part(object_name,'/',2)=actor::text
      and fleet_internal.company_driver_is_linked(chat.driver_id,chat.fleet_id)
      and (chat.kind<>'private' or exists(select 1 from fleet_internal.driver_private_message_access access
        where access.fleet_id=chat.fleet_id and access.driver_id=chat.driver_id and access.staff_id=chat.staff_id));
  end if;
  return exists(select 1 from fleet_internal.company_messages msg where msg.thread_id=chat.id and msg.image_path=object_name);
end;
$$;
revoke all on function fleet_internal.company_message_image_access(text,boolean) from public, anon, authenticated;
grant execute on function fleet_internal.company_message_image_access(text,boolean) to authenticated;

create policy company_message_images_read on storage.objects for select to authenticated
  using(bucket_id='company-message-images' and fleet_internal.company_message_image_access(name,false));
create policy company_message_images_upload on storage.objects for insert to authenticated
  with check(bucket_id='company-message-images' and fleet_internal.company_message_image_access(name,true));

CREATE OR REPLACE FUNCTION fleet_internal.company_messaging(action text, fleet text, thread uuid, params jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  scope text[];
  target_driver uuid;
  target_staff uuid;
  chat fleet_internal.company_message_threads%rowtype;
  channel text := params ->> 'kind';
  message_body text := coalesce(btrim(params ->> 'body'),'');
  attachment_path text := nullif(params ->> 'image_path','');
  message_id uuid;
  author_name text;
  history jsonb;
  last_seen_at timestamptz;
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;
  if action='list' then
    return jsonb_build_object(
      'threads',coalesce((select jsonb_agg(
        jsonb_build_object('id',t.id,'fleet_id',t.fleet_id,'kind',t.kind,
         'profile_id',(select p.profile_id from public.rigtracker_profiles p where p.user_id=t.driver_id),
         'contact',case when t.driver_id=actor then case when t.kind='private' then coalesce(
              (select nullif(btrim(concat_ws(' ',first_name,last_name)),'') from public.fleet_employees where user_id=t.staff_id),
              'Fleet Official') else initcap(t.kind) end
            else coalesce((select nullif(btrim(concat_ws(' ',first_name,last_name)),'') from public.rigtracker_profiles where user_id=t.driver_id),'Company Driver') end,
         'unread',exists(select 1 from fleet_internal.company_messages pending
            where pending.thread_id=t.id and pending.sender_id<>actor and pending.created_at>coalesce(
              (select r.read_at from fleet_internal.company_message_reads r where r.thread_id=t.id and r.viewer_id=actor),
              '-infinity'::timestamptz)),
         'last_message',(select jsonb_build_object('id',m.id,'sender_id',m.sender_id,'body',case when m.body='' and m.image_path is not null then 'Photo' else left(m.body,140) end,'created_at',m.created_at)
           from fleet_internal.company_messages m where m.thread_id=t.id order by m.created_at desc,m.id desc limit 1))
          order by t.updated_at desc) from (
            select * from fleet_internal.company_message_threads t
             where fleet_internal.message_thread_visible(t,actor) order by t.updated_at desc limit 150
          ) t),'[]'::jsonb),
      'staff_fleet',(select jsonb_build_object('id',f.id,'scope',fleet_internal.message_staff_scope(actor,f.id))
        from public.fleets f where f.admin_user_id=actor
          or f.id=(select e.fleet_id from public.fleet_employees e where e.user_id=actor and not e.password_required)
        order by (f.admin_user_id=actor) desc limit 1),
      'mechanic_fleets',coalesce((select jsonb_agg(l.fleet_id order by l.fleet_id)
        from public.rigtracker_fleet_links l
        where l.profile_user_id=actor and fleet_internal.company_mechanic_is_linked(actor,l.fleet_id)), '[]'::jsonb),
      'linked_fleets',coalesce((select jsonb_agg(l.fleet_id order by l.fleet_id) from public.rigtracker_fleet_links l
        where l.profile_user_id=actor and fleet_internal.company_driver_is_linked(actor,l.fleet_id)), '[]'::jsonb)
    );
  end if;
  if action='contacts' then
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if not ('staff'=any(scope)) and not fleet_internal.company_mechanic_is_linked(actor,fleet) then
      raise exception 'Fleet team access is required.' using errcode='42501';
    end if;
    return jsonb_build_object(
      'drivers',coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'dispatch_driver_id',l.dispatch_driver_id,'name',
           coalesce(nullif(btrim(concat_ws(' ',p.first_name,p.last_name)),''),'Company Driver'),
           'private_enabled',exists(select 1 from fleet_internal.driver_private_message_access x
             where x.fleet_id=fleet and x.driver_id=p.user_id and x.staff_id=actor)) order by p.last_name,p.first_name)
        from public.rigtracker_profiles p join public.rigtracker_fleet_links l on l.profile_user_id=p.user_id
        where l.fleet_id=fleet and l.unlinked_at is null and p.profile_type='company_driver'), '[]'::jsonb),
      'staff', case when 'official'=any(scope) then coalesce((
        select jsonb_agg(staff_member order by name) from (
          select 'Fleet Admin' as name, jsonb_build_object('id',admin_user_id,'name','Fleet Admin') as staff_member
          from public.fleets where id=fleet
          union all
          select btrim(concat_ws(' ',first_name,last_name)),jsonb_build_object('id',user_id,'name',
            coalesce(nullif(btrim(concat_ws(' ',first_name,last_name)),''),fleet_id || '-' || employee_id))
          from public.fleet_employees where fleet_id=fleet
        ) staff_rows
      ),'[]'::jsonb) else '[]'::jsonb end,
      'grants',case when 'official'=any(scope) then coalesce((
        select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'staff_id',x.staff_id))
        from fleet_internal.driver_private_message_access x join public.rigtracker_profiles p on p.user_id=x.driver_id
        where x.fleet_id=fleet
      ),'[]'::jsonb) else '[]'::jsonb end);
  end if;
  if action in ('start','set_private_access') then
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if 'staff'=any(scope) or fleet_internal.company_mechanic_is_linked(actor,fleet) then
      select p.user_id into target_driver from public.rigtracker_profiles p
      where p.profile_id=params ->> 'profile_id' and p.profile_type='company_driver';
    else
      target_driver := actor;
    end if;
    if target_driver is null or not fleet_internal.company_driver_is_linked(target_driver,fleet) then
      raise exception 'Choose an active Company Driver in this fleet.' using errcode='42501';
    end if;
    if action='set_private_access' then
      if not ('official'=any(scope)) or jsonb_typeof(params -> 'enabled') is distinct from 'boolean' then
        raise exception 'Only an Official can change private messaging access.' using errcode='42501';
      end if;
      target_staff := (params ->> 'staff_id')::uuid;
      if not exists(select 1 from public.fleets where id=fleet and admin_user_id=target_staff)
        and not exists(select 1 from public.fleet_employees where fleet_id=fleet and user_id=target_staff) then
        raise exception 'Choose a member of this fleet’s staff.' using errcode='42501';
      end if;
      if (params ->> 'enabled')::boolean then
        insert into fleet_internal.driver_private_message_access(fleet_id,driver_id,staff_id,granted_by)
          values(fleet,target_driver,target_staff,actor) on conflict do nothing;
      else
        delete from fleet_internal.driver_private_message_access
          where fleet_id=fleet and driver_id=target_driver and staff_id=target_staff;
      end if;
      return '{}'::jsonb;
    end if;
    if channel='private' then
      if not ('staff'=any(scope)) or not exists(select 1 from fleet_internal.driver_private_message_access
        where fleet_id=fleet and driver_id=target_driver and staff_id=actor) then
        raise exception 'An Official must grant you private messaging for this driver.' using errcode='42501';
      end if;
      target_staff := actor;
    elsif coalesce(channel,'') not in ('dispatch','maintenance','safety') or ('staff'=any(scope) and not (channel=any(scope))) then
      raise exception 'You do not have access to this team conversation.' using errcode='42501';
    end if;
    insert into fleet_internal.company_message_threads(fleet_id,driver_id,kind,staff_id)
      values(fleet,target_driver,channel,target_staff)
      on conflict(fleet_id,driver_id,kind,staff_id) do nothing returning * into chat;
    if not found then
      select * into chat from fleet_internal.company_message_threads
        where fleet_id=fleet and driver_id=target_driver and kind=channel and staff_id is not distinct from target_staff;
    end if;
    return jsonb_build_object('id',chat.id);
  end if;

  select * into chat from fleet_internal.company_message_threads where id=thread;
  if not found or not fleet_internal.message_thread_visible(chat,actor) then
    raise exception 'Conversation unavailable to this account.' using errcode='42501';
  end if;
  if action='thread' then
    select coalesce(jsonb_agg(to_jsonb(msg) - 'thread_id' order by msg.created_at,msg.id),'[]'::jsonb),
        max(msg.created_at)
      into history,last_seen_at
      from (select * from fleet_internal.company_messages where thread_id=chat.id
        order by created_at desc,id desc limit 150) msg;
    if params -> 'mark_read' = 'true'::jsonb and last_seen_at is not null then
      insert into fleet_internal.company_message_reads(thread_id,viewer_id,read_at)
        values(chat.id,actor,last_seen_at) on conflict(thread_id,viewer_id)
        do update set read_at=greatest(company_message_reads.read_at,excluded.read_at);
    end if;
    return jsonb_build_object(
      'can_send',fleet_internal.company_driver_is_linked(chat.driver_id,chat.fleet_id)
          and (chat.kind<>'private' or exists(select 1 from fleet_internal.driver_private_message_access
            where fleet_id=chat.fleet_id and driver_id=chat.driver_id and staff_id=chat.staff_id)),
      'messages',history);
  end if;
  if action<>'send' then raise exception 'Unsupported messaging action.' using errcode='22023'; end if;
  if not fleet_internal.company_driver_is_linked(chat.driver_id,chat.fleet_id)
    or (chat.kind='private' and not exists(select 1 from fleet_internal.driver_private_message_access
      where fleet_id=chat.fleet_id and driver_id=chat.driver_id and staff_id=chat.staff_id)) then
    raise exception 'This conversation is closed for new messages.' using errcode='42501';
  end if;
  if char_length(message_body)>4000 or (message_body='' and attachment_path is null) then
    raise exception 'Enter a message up to 4,000 characters or attach a photo.' using errcode='22023';
  end if;
  message_id := (params ->> 'message_id')::uuid;
  if message_id is null then raise exception 'Message ID is missing.' using errcode='22023'; end if;
  if attachment_path is not null and (
    attachment_path !~ ('^'||chat.id||'/'||actor||'/'||message_id||'[.](jpg|png|webp|gif|heic|heif)$')
    or not exists(select 1 from storage.objects where bucket_id='company-message-images' and name=attachment_path)
  ) then raise exception 'Upload the photo to this conversation first.' using errcode='22023'; end if;
  if actor=chat.driver_id then
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name from public.rigtracker_profiles where user_id=actor;
    author_name := coalesce(author_name,'Company Driver');
  elsif fleet_internal.company_mechanic_is_linked(actor,chat.fleet_id) then
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name
      from public.rigtracker_profiles where user_id=actor;
    author_name := coalesce(author_name,'Maintenance');
  else
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name from public.fleet_employees where user_id=actor;
    author_name := coalesce(author_name,'Fleet Admin');
  end if;
  insert into fleet_internal.company_messages(id,thread_id,sender_id,sender_name,body,image_path)
    values(message_id,chat.id,actor,author_name,message_body,attachment_path) on conflict(id) do nothing;
  if found then update fleet_internal.company_message_threads set updated_at=clock_timestamp() where id=chat.id; end if;
  return '{}'::jsonb;
end;
$function$;
