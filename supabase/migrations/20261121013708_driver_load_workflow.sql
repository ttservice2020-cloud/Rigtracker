alter table public.fleet_dispatch_loads
  add column return_of uuid references public.fleet_dispatch_loads(id),
  add column return_review text check (return_review in ('pending','posted','denied')),
  add constraint driver_return_review_state check (
    (return_of is null and return_review is null) or
    (return_of is not null and return_review is not null and
      ((return_review in ('pending','denied') and status = 'draft') or
       (return_review = 'posted' and status in ('current','completed'))))
  );
create index fleet_dispatch_return_lookup on public.fleet_dispatch_loads(fleet_id, return_review)
  where return_of is not null;
create index fleet_dispatch_return_parent on public.fleet_dispatch_loads(return_of) where return_of is not null;

create table fleet_internal.driver_yard_handoffs (
  load_id uuid primary key references public.fleet_dispatch_loads(id) on delete cascade,
  fleet_id text not null references public.fleets(id),
  trailer text not null check (char_length(trailer) between 1 and 40),
  yard text not null check (char_length(yard) between 1 and 160),
  offered_driver uuid references public.fleet_dispatch_drivers(id),
  picked_up_at timestamptz,
  confirmed_at timestamptz
);
create index driver_yard_handoffs_fleet on fleet_internal.driver_yard_handoffs(fleet_id, confirmed_at);
create index driver_yard_handoffs_offered_driver on fleet_internal.driver_yard_handoffs(offered_driver);
create unique index driver_yard_open_trailer on fleet_internal.driver_yard_handoffs(fleet_id, trailer)
  where picked_up_at is null;
revoke all on fleet_internal.driver_yard_handoffs from public, anon, authenticated;

create function fleet_internal.workflow_driver(acting_user uuid, fleet text)
returns uuid language sql stable set search_path = ''
as $$
  select link.dispatch_driver_id
  from public.rigtracker_fleet_links link
  join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
  where link.fleet_id = fleet and link.profile_user_id = acting_user and link.unlinked_at is null
    and profile.profile_type in ('company_driver','driver') and not profile.password_required;
$$;

create function fleet_internal.workflow_stops(details jsonb)
returns table(stop_key text, kind text, sequence_no bigint, info jsonb)
language sql immutable set search_path = ''
as $$
  select coalesce(nullif(stop ->> 'stopId',''), 'pickup-'||(position-1)), 'pickup', position, stop
  from jsonb_array_elements(coalesce(details -> 'pickups','[]')) with ordinality as p(stop,position)
  union all
  select coalesce(nullif(stop ->> 'stopId',''), 'receiver-'||(position-1)), 'delivery', position+100, stop
  from jsonb_array_elements(coalesce(details -> 'receivers','[]')) with ordinality as d(stop,position);
$$;

create function fleet_internal.driver_document_access(object_name text, writing boolean)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load_key text := split_part(object_name,'/',1);
  load_row public.fleet_dispatch_loads%rowtype;
  assigned uuid;
begin
  if actor is null or load_key !~ '^[0-9a-f-]{36}$'
    or load_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  select * into load_row from public.fleet_dispatch_loads where id = load_key::uuid;
  if not found then return false; end if;
  if not writing and exists (select 1 from public.fleets where id=load_row.fleet_id and admin_user_id=actor) then return true; end if;
  assigned := fleet_internal.workflow_driver(actor,load_row.fleet_id);
  if assigned is null or (assigned is distinct from load_row.driver_id and assigned is distinct from load_row.second_driver_id) then
    return false;
  end if;
  if not writing then return load_row.status in ('current','completed') or load_row.return_review is not null; end if;
  return split_part(object_name,'/',2)=actor::text
    and (load_row.status='current' or load_row.return_review='pending')
    and coalesce(load_row.progress #>> array['driverResponses',assigned::text,'decision'],'')='accepted';
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('driver-load-documents','driver-load-documents',false,10485760,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']);
create policy driver_load_document_read on storage.objects for select to authenticated
  using (bucket_id='driver-load-documents' and fleet_internal.driver_document_access(name,false));
create policy driver_load_document_upload on storage.objects for insert to authenticated
  with check (bucket_id='driver-load-documents' and fleet_internal.driver_document_access(name,true));

create function fleet_internal.driver_workflow(action text, load_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
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
$$;

create function fleet_internal.dispatch_workflow(fleet text, action text, load_id uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
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
  if actor is null or not exists(select 1 from public.fleets where id=fleet and admin_user_id=actor) then
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
$$;

create function public.driver_workflow(action text, load_id uuid default null, payload jsonb default '{}')
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.driver_workflow(action,load_id,payload); $$;
create function public.dispatch_workflow(fleet text, action text, load_id uuid default null, payload jsonb default '{}')
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.dispatch_workflow(fleet,action,load_id,payload); $$;
revoke all on function fleet_internal.workflow_driver(uuid,text), fleet_internal.workflow_stops(jsonb),
  fleet_internal.driver_document_access(text,boolean), fleet_internal.driver_workflow(text,uuid,jsonb),
  fleet_internal.dispatch_workflow(text,text,uuid,jsonb), public.driver_workflow(text,uuid,jsonb),
  public.dispatch_workflow(text,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.driver_document_access(text,boolean),
  fleet_internal.driver_workflow(text,uuid,jsonb), fleet_internal.dispatch_workflow(text,text,uuid,jsonb),
  public.driver_workflow(text,uuid,jsonb), public.dispatch_workflow(text,text,uuid,jsonb) to authenticated;
