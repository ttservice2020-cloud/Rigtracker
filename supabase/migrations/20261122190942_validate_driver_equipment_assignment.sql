alter table public.fleet_dispatch_drivers
  add column assigned_trailer_type text check (assigned_trailer_type in ('fleet','power_only'));

create function fleet_internal.registered_equipment(target_fleet text, target_type text, unit text)
returns public.fleet_equipment language sql stable set search_path = ''
as $$
  select e.*
  from public.fleet_equipment e
  where e.fleet_id=target_fleet and e.equipment_type=target_type
    and upper(e.unit_number)=upper(btrim(unit));
$$;
revoke all on function fleet_internal.registered_equipment(text,text,text) from public, anon, authenticated;

create or replace function fleet_internal.fleet_company_driver_profile(
  action text, target_fleet text, profile_number text, roster_driver uuid,
  before_time timestamptz, before_load uuid
)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  driver record;
  activity jsonb;
  equipment_info jsonb;
  current_truck text;
  current_trailer text;
  truck_unit uuid;
  trailer_unit uuid;
  view_equipment boolean;
  admin boolean := exists (select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=(select auth.uid()));
  allowed text[];
begin
  if not fleet_internal.driver_profile_access(target_fleet,null) then
    raise exception 'You do not have access to this fleet’s driver profiles.' using errcode='42501';
  end if;
  select array(select permission from unnest(fleet_internal.driver_profile_permissions()) permission
    where fleet_internal.driver_profile_access(target_fleet,permission)) into allowed;
  if fleet_internal.office_has_permission(target_fleet,'dispatch') or 'driver_history'=any(allowed) then
    allowed := array_append(allowed,'driver_mileage');
  end if;
  if fleet_internal.office_has_permission(target_fleet,'dispatch')
    or fleet_internal.office_has_permission(target_fleet,'payroll') or 'driver_pay_settlements'=any(allowed) then
    allowed := array_append(allowed,'driver_pay_scale');
  end if;
  allowed := array_append(allowed,'driver_concerns');
  select p.user_id,p.profile_id,p.display_profile_id,p.first_name,p.last_name,p.phone,p.license_number,
    p.profile_type,l.employee_number,l.unlinked_at,d.id as dispatch_driver_id,d.name,d.driver_type,d.equipment,d.availability,
    d.link_active,d.assigned_truck_number,d.assigned_trailer_number,d.assigned_trailer_type
  into driver
  from public.rigtracker_fleet_links l
  join public.rigtracker_profiles p on p.user_id=l.profile_user_id and p.profile_type in ('company_driver','driver')
  left join public.fleet_dispatch_drivers d on d.id=l.dispatch_driver_id and d.fleet_id=l.fleet_id
  where l.fleet_id=target_fleet and ((profile_number is not null and p.profile_id=profile_number)
    or (roster_driver is not null and l.dispatch_driver_id=roster_driver and l.unlinked_at is null))
  order by (l.unlinked_at is null) desc, p.user_id limit 1;
  if not found and roster_driver is not null then
    select null::uuid as user_id,null::text as profile_id,null::text as display_profile_id,
      null::text as first_name,null::text as last_name,null::text as phone,null::text as license_number,
      null::text as profile_type,null::text as employee_number,null::timestamptz as unlinked_at,
      d.id as dispatch_driver_id,d.name,d.driver_type,d.equipment,d.availability,
      d.link_active,d.assigned_truck_number,d.assigned_trailer_number,d.assigned_trailer_type into driver
    from public.fleet_dispatch_drivers d where d.fleet_id=target_fleet and d.id=roster_driver and d.link_active;
  end if;
  if not found or (not admin and driver.unlinked_at is not null) then
    raise exception 'This driver is unavailable in your fleet.' using errcode='22023';
  end if;

  if action in ('overview','presence') then
    select jsonb_build_object('last_seen_at',p.last_seen_at,
      'online',p.last_seen_at >= statement_timestamp() - interval '2 minutes')
      into activity from fleet_internal.company_driver_presence p
      where p.user_id=driver.user_id and driver.unlinked_at is null and 'driver_company_file'=any(allowed);
    if action='presence' then return coalesce(activity,'{}'); end if;
    select jsonb_build_object('truck',q.details->>'truckNumber','trailer',
      case when q.progress ? 'dispatchTrailerOverride' then q.progress->>'dispatchTrailerOverride'
        when handoff.offered_driver=driver.dispatch_driver_id and handoff.confirmed_at is not null and report.data is null then handoff.trailer
        when report.data->>'bobtail'='true' or (
          nullif(report.data->>'droppedTrailer','') is not null and coalesce(report.data->>'pickedTrailer','')=''
          and (coalesce(report.data->>'trailer','')='' or upper(report.data->>'trailer')=upper(report.data->>'droppedTrailer')))
          then 'Bobtail'
        else coalesce(nullif(report.data->>'pickedTrailer',''),nullif(report.data->>'trailer',''),q.details->>'trailerNumber') end)
    into equipment_info
    from public.fleet_dispatch_loads q
    left join fleet_internal.driver_yard_handoffs handoff on handoff.load_id=q.id
    left join lateral (
      select q.progress #> array['stops',s.stop_key,'driverReport'] as data
      from fleet_internal.driver_assigned_stops(q,driver.dispatch_driver_id) s
      where q.progress #> array['stops',s.stop_key,'driverReport'] is not null
      order by s.sequence_no desc limit 1
    ) report on true
    where q.fleet_id=target_fleet and q.status='current' and driver.dispatch_driver_id in(q.driver_id,q.second_driver_id)
      and q.progress #>> array['driverResponses',driver.dispatch_driver_id::text,'decision'] is distinct from 'rejected'
    order by (coalesce(q.progress->'stops','{}')<>'{}') desc,q.assigned_at desc nulls last,q.created_at desc,q.id limit 1;
    current_truck := coalesce(driver.assigned_truck_number,equipment_info->>'truck');
    current_trailer := coalesce(driver.assigned_trailer_number,equipment_info->>'trailer');
    truck_unit := (fleet_internal.registered_equipment(target_fleet,'truck',current_truck)).id;
    trailer_unit := (fleet_internal.registered_equipment(target_fleet,'trailer',current_trailer)).id;
    view_equipment := fleet_internal.office_has_permission(target_fleet,'dispatch')
      or fleet_internal.office_has_permission(target_fleet,'assets');
    return jsonb_build_object(
      'profile_id',driver.profile_id,'display_profile_id',driver.display_profile_id,'first_name',driver.first_name,
      'last_name',driver.last_name,'name',driver.name,'employee_number',case when 'driver_company_file'=any(allowed) then driver.employee_number end,
      'linked',driver.user_id is not null and driver.unlinked_at is null,
      'company_driver',driver.profile_type is not distinct from 'company_driver',
      'driver_type',coalesce(driver.driver_type,case driver.profile_type when 'driver' then 'owner_op' when 'company_driver' then 'company' end),
      'dispatch_driver_id',driver.dispatch_driver_id,'equipment',driver.equipment,
      'availability',case when driver.unlinked_at is not null then null when equipment_info is not null then 'assigned' else driver.availability end,
      'email',case when driver.unlinked_at is null then (select u.email from auth.users u where u.id=driver.user_id) end,
      'phone',case when driver.unlinked_at is null then driver.phone end,
      'license_number',case when driver.unlinked_at is null then driver.license_number end,
      'truck',current_truck,
      'truck_equipment_id',case when view_equipment then truck_unit end,
      'trailer_equipment_id',case when view_equipment and lower(btrim(current_trailer))<>'bobtail' then trailer_unit end,
      'trailer',current_trailer,
      'trailer_type',case
        when nullif(btrim(current_trailer),'') is null or lower(btrim(current_trailer))='bobtail' then null
        when trailer_unit is null then 'power_only'
        else coalesce(driver.assigned_trailer_type,'fleet') end,
      'assigned_trailer_type',driver.assigned_trailer_type,
      'assigned_truck_number',driver.assigned_truck_number,'assigned_trailer_number',driver.assigned_trailer_number,
      'can_edit_equipment',driver.dispatch_driver_id is not null and coalesce(driver.link_active,false)
        and driver.unlinked_at is null and fleet_internal.office_has_permission(target_fleet,'dispatch'),
      'tabs',to_jsonb(allowed),'presence',coalesce(activity,'{}'));
  end if;

  if action in ('pay_settlements','pay_status') then
    if not ('driver_' || action=any(allowed)) then
      raise exception 'You do not have access to this driver profile tab.' using errcode='42501';
    end if;
    return jsonb_build_object(
      'statements',coalesce((select jsonb_agg(jsonb_build_object(
        'title',f.title,'period_start',f.period_start,'period_end',f.period_end,'status',f.status,'submitted_at',f.submitted_at,
        'storage_key',case when action='pay_settlements' then f.storage_key end) order by f.period_end desc,f.published_at desc)
        from (select * from fleet_internal.company_driver_pay_files p where p.fleet_id=target_fleet and p.driver_id=driver.user_id
          order by p.period_end desc,p.published_at desc limit 50) f),'[]'),
      'settlements',coalesce((select jsonb_agg(jsonb_build_object(
        'settlement_number',s.settlement_number,'status',s.status,'created_at',s.created_at,
        'total_pay',case when action='pay_settlements' then s.total_pay end) order by s.created_at desc)
        from (select * from fleet_internal.company_driver_settlements s where s.fleet_id=target_fleet and s.driver_user_id=driver.user_id
            and not exists(select 1 from fleet_internal.company_driver_pay_files f
              where f.fleet_id=target_fleet and f.driver_id=driver.user_id
                and (f.settlement_id=s.id or lower(btrim(f.title))=lower(s.settlement_number)))
          order by s.created_at desc limit 50) s),'[]'));
  end if;
  if action is null or action not in ('history','bols') or not ('driver_' || action=any(allowed)) then
    raise exception 'You do not have access to this driver profile tab.' using errcode='42501';
  end if;

  return (
    with candidates as (
      select l.id,l.updated_at from public.fleet_dispatch_loads l
      where l.fleet_id=target_fleet and driver.dispatch_driver_id in(l.driver_id,l.second_driver_id)
        and (before_load is null or (l.updated_at,l.id)<(before_time,before_load))
        and (case action when 'history' then l.status='completed' else
          l.status in('current','completed') and exists(
            select 1 from fleet_internal.workflow_stops(l.details) s
            cross join lateral fleet_internal.driver_report_documents(l.progress #> array['stops',s.stop_key,'driverReport']) file
            where split_part(file.path,'/',1)=l.id::text) end)
      order by l.updated_at desc,l.id desc limit 26
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'load_id',l.id,'pro_number',l.pro_number::text,'return_load',l.return_of is not null,
      'updated_at',l.updated_at,'completed_at',case when l.status='completed' then coalesce(l.progress->>'completedAt',l.updated_at::text) end,
      'origin',l.details #>> '{pickups,0,company}','destination',l.details #>> '{receivers,-1,company}',
      'paperwork',coalesce(documents.files,'[]')) order by l.updated_at desc,l.id desc),'[]')
    from candidates c join public.fleet_dispatch_loads l on l.id=c.id
    left join lateral (
      select jsonb_agg(jsonb_build_object('kind',s.kind,'stop',s.stop_key,'company',s.info->>'company','path',file.path)
        order by s.sequence_no,file.file_order) as files
      from fleet_internal.workflow_stops(l.details) s
      cross join lateral fleet_internal.driver_report_documents(l.progress #> array['stops',s.stop_key,'driverReport']) file
      where split_part(file.path,'/',1)=l.id::text and 'driver_bols'=any(allowed)
    ) documents on true
  );
end;
$$;

create or replace function fleet_internal.track_driver_reported_trailer()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  driver uuid := fleet_internal.workflow_driver(auth.uid(),new.fleet_id);
  report jsonb;
  next_trailer text;
  reported_type text;
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
    reported_type := report->>'trailerType';
    next_trailer := case
      when report->>'bobtail'='true' then 'Bobtail'
      when nullif(report->>'pickedTrailer','') is not null then report->>'pickedTrailer'
      when nullif(report->>'trailer','') is not null then report->>'trailer'
      when nullif(report->>'droppedTrailer','') is not null then 'Bobtail'
    end;
  end if;
  if next_trailer is not null then
    update public.fleet_dispatch_drivers d
    set assigned_trailer_number=next_trailer,
      assigned_trailer_type=coalesce(reported_type,
        case when upper(d.assigned_trailer_number)=upper(next_trailer) then d.assigned_trailer_type end)
    where d.fleet_id=new.fleet_id and d.id=driver and d.link_active
      and (d.assigned_trailer_number is distinct from next_trailer
        or (reported_type is not null and d.assigned_trailer_type is distinct from reported_type));
  end if;
  return new;
end;
$$;

create function fleet_internal.save_dispatch_driver_equipment(
  target_fleet text, target_driver uuid, truck_number text, trailer_number text,
  expected_truck text, expected_trailer text, trailer_type text, expected_trailer_type text,
  require_trailer_type boolean
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  truck_assignment text := nullif(btrim(truck_number),'');
  trailer_assignment text := nullif(btrim(trailer_number),'');
  truck_match text;
  trailer_match text;
  selected_type text := nullif(btrim(trailer_type),'');
begin
  if not fleet_internal.office_has_permission(target_fleet,'dispatch') then
    raise exception 'Dispatch access is required to edit driver equipment.' using errcode='42501';
  end if;
  if char_length(truck_assignment)>40 or char_length(trailer_assignment)>40 then
    raise exception 'Use 40 characters or fewer for each equipment number.' using errcode='22023';
  end if;
  perform 1 from public.fleet_equipment e
  where e.fleet_id=target_fleet and (
    (e.equipment_type='truck' and upper(e.unit_number)=upper(truck_assignment))
    or (e.equipment_type='trailer' and upper(e.unit_number)=upper(trailer_assignment)))
  order by e.id for share;
  truck_match := (fleet_internal.registered_equipment(target_fleet,'truck',truck_assignment)).unit_number;
  if truck_assignment is not null and truck_match is null
    and upper(truck_assignment) is distinct from upper(nullif(btrim(expected_truck),'')) then
    raise exception 'Select a truck number saved in Equipment.' using errcode='22023';
  end if;

  if selected_type not in ('fleet','power_only') then
    raise exception 'Choose Fleet or Power Only for this trailer.' using errcode='22023';
  end if;
  if lower(trailer_assignment)='bobtail' then
    trailer_assignment := 'Bobtail';
    selected_type := null;
  elsif trailer_assignment is null then
    selected_type := null;
  else
    if require_trailer_type and selected_type is null then
      raise exception 'Choose Fleet or Power Only for this trailer.' using errcode='22023';
    end if;
    trailer_match := (fleet_internal.registered_equipment(target_fleet,'trailer',trailer_assignment)).unit_number;
    if selected_type='fleet' and trailer_match is null then
      raise exception 'Select a trailer saved in Equipment or choose Power Only.' using errcode='22023';
    end if;
  end if;

  update public.fleet_dispatch_drivers d
  set assigned_truck_number=coalesce(truck_match,truck_assignment),
    assigned_trailer_number=coalesce(trailer_match,trailer_assignment),
    assigned_trailer_type=case
      when trailer_assignment is null or trailer_assignment='Bobtail' then null
      when selected_type is not null then selected_type
      when upper(d.assigned_trailer_number)=upper(trailer_assignment) then d.assigned_trailer_type end
  where d.id=target_driver and d.fleet_id=target_fleet and d.link_active
    and d.assigned_truck_number is not distinct from nullif(btrim(expected_truck),'')
    and d.assigned_trailer_number is not distinct from nullif(btrim(expected_trailer),'')
    and (not require_trailer_type or d.assigned_trailer_type is not distinct from expected_trailer_type);
  if not found then
    raise exception 'Driver equipment changed or the driver is unavailable. Reopen the profile and try again.' using errcode='40001';
  end if;

  return fleet_internal.fleet_company_driver_profile('overview',target_fleet,null,target_driver,null,null);
end;
$$;

create or replace function fleet_internal.set_dispatch_driver_equipment(
  target_fleet text, target_driver uuid,
  truck_number text, trailer_number text, expected_truck text, expected_trailer text
)
returns jsonb language sql security definer set search_path = ''
as $$
  select fleet_internal.save_dispatch_driver_equipment(target_fleet,target_driver,truck_number,trailer_number,
    expected_truck,expected_trailer,null,null,false);
$$;

create function public.set_dispatch_driver_equipment(
  target_fleet text, target_driver uuid, truck_number text, trailer_number text,
  expected_truck text, expected_trailer text, trailer_type text, expected_trailer_type text
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.save_dispatch_driver_equipment(target_fleet,target_driver,truck_number,trailer_number,
    expected_truck,expected_trailer,trailer_type,expected_trailer_type,true);
$$;

revoke all on function fleet_internal.save_dispatch_driver_equipment(text,uuid,text,text,text,text,text,text,boolean),
  public.set_dispatch_driver_equipment(text,uuid,text,text,text,text,text,text) from public, anon, authenticated;
grant execute on function fleet_internal.save_dispatch_driver_equipment(text,uuid,text,text,text,text,text,text,boolean),
  public.set_dispatch_driver_equipment(text,uuid,text,text,text,text,text,text) to authenticated;

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
      'lumperFee',lumper_fee::numeric,
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

create function fleet_internal.driver_trailer_status(target_load uuid, unit_numbers text[])
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  load_row public.fleet_dispatch_loads%rowtype;
  driver uuid;
begin
  if auth.uid() is null or coalesce(cardinality(unit_numbers),0) not between 1 and 3 then
    return '{}'::jsonb;
  end if;
  select * into load_row from public.fleet_dispatch_loads l where l.id=target_load;
  driver := fleet_internal.workflow_driver(auth.uid(),load_row.fleet_id);
  if driver is null or (driver is distinct from load_row.driver_id and driver is distinct from load_row.second_driver_id)
    or (load_row.status is distinct from 'current' and load_row.return_review is distinct from 'pending')
    or load_row.progress #>> array['driverResponses',driver::text,'decision'] is distinct from 'accepted' then
    raise exception 'Open your assigned load to check trailer status.' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_object_agg(upper(e.unit_number),e.out_of_service)
    from public.fleet_equipment e, unnest(unit_numbers) number
    where e.fleet_id=load_row.fleet_id and e.equipment_type='trailer'
      and char_length(btrim(number)) between 1 and 40
      and upper(e.unit_number)=upper(btrim(number))
  ),'{}'::jsonb);
end;
$$;

create function public.driver_trailer_status(target_load uuid, unit_numbers text[])
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select fleet_internal.driver_trailer_status(target_load,unit_numbers);
$$;
revoke all on function fleet_internal.driver_trailer_status(uuid,text[]),
  public.driver_trailer_status(uuid,text[]) from public, anon, authenticated;
grant execute on function fleet_internal.driver_trailer_status(uuid,text[]),
  public.driver_trailer_status(uuid,text[]) to authenticated;
