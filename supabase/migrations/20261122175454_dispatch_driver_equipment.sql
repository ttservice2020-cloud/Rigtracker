alter table public.fleet_dispatch_drivers
  add column assigned_truck_number text
    check (assigned_truck_number=btrim(assigned_truck_number) and char_length(assigned_truck_number) between 1 and 40),
  add column assigned_trailer_number text
    check (assigned_trailer_number=btrim(assigned_trailer_number) and char_length(assigned_trailer_number) between 1 and 40);

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
    d.link_active,d.assigned_truck_number,d.assigned_trailer_number
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
      d.link_active,d.assigned_truck_number,d.assigned_trailer_number into driver
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
      'truck',coalesce(driver.assigned_truck_number,equipment_info->>'truck'),
      'trailer',coalesce(driver.assigned_trailer_number,equipment_info->>'trailer'),
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

create function fleet_internal.set_dispatch_driver_equipment(
  target_fleet text, target_driver uuid,
  truck_number text, trailer_number text, expected_truck text, expected_trailer text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  truck_assignment text := nullif(btrim(truck_number),'');
  trailer_assignment text := case when lower(btrim(trailer_number))='bobtail' then 'Bobtail' else nullif(btrim(trailer_number),'') end;
begin
  if not fleet_internal.office_has_permission(target_fleet,'dispatch') then
    raise exception 'Dispatch access is required to edit driver equipment.' using errcode='42501';
  end if;
  if char_length(truck_assignment)>40 or char_length(trailer_assignment)>40 then
    raise exception 'Use 40 characters or fewer for each equipment number.' using errcode='22023';
  end if;

  update public.fleet_dispatch_drivers d
  set assigned_truck_number=truck_assignment,assigned_trailer_number=trailer_assignment
  where d.id=target_driver and d.fleet_id=target_fleet and d.link_active
    and d.assigned_truck_number is not distinct from nullif(btrim(expected_truck),'')
    and d.assigned_trailer_number is not distinct from nullif(btrim(expected_trailer),'');
  if not found then
    raise exception 'Driver equipment changed or the driver is unavailable. Reopen the profile and try again.' using errcode='40001';
  end if;

  return fleet_internal.fleet_company_driver_profile('overview',target_fleet,null,target_driver,null,null);
end;
$$;

create function public.set_dispatch_driver_equipment(
  target_fleet text, target_driver uuid,
  truck_number text, trailer_number text, expected_truck text, expected_trailer text
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.set_dispatch_driver_equipment(target_fleet,target_driver,truck_number,trailer_number,
    expected_truck,expected_trailer);
$$;

revoke all on function fleet_internal.set_dispatch_driver_equipment(text,uuid,text,text,text,text),
  public.set_dispatch_driver_equipment(text,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function fleet_internal.set_dispatch_driver_equipment(text,uuid,text,text,text,text),
  public.set_dispatch_driver_equipment(text,uuid,text,text,text,text) to authenticated;
