create function fleet_internal.driver_profile_permissions()
returns text[] language sql immutable set search_path = ''
as $$
  select array['driver_documents','driver_bols','driver_company_file','driver_messages',
    'driver_history','driver_pay_settlements','driver_tax','driver_pay_status'];
$$;

revoke all on function fleet_internal.driver_profile_permissions() from public, anon, authenticated;
grant execute on function fleet_internal.driver_profile_permissions() to authenticated, service_role;

alter table public.fleet_employees drop constraint fleet_employee_office_permissions_check;
alter table public.fleet_employees add constraint fleet_employee_office_permissions_check check (
  office_permissions <@ (array['dispatch','drivers','assets','messages','hr','payroll','settlements','hourly',
    'bank_ledger','payments','policies','activity'] || fleet_internal.driver_profile_permissions())
);

create function fleet_internal.driver_profile_access(target_fleet text, permission text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists(select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=(select auth.uid()))
    or exists(select 1 from public.fleet_employees e
      where e.fleet_id=target_fleet and e.user_id=(select auth.uid()) and not e.password_required
        and (e.office_is_official or e.office_permissions && array['dispatch','drivers','payroll','settlements'])
        and (permission is null or permission=any(e.office_permissions)));
$$;
revoke all on function fleet_internal.driver_profile_access(text,text) from public, anon, authenticated;
grant execute on function fleet_internal.driver_profile_access(text,text) to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('fleet-driver-profile-files','fleet-driver-profile-files',false,10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']);

create function fleet_internal.driver_profile_file_access(object_name text, for_upload boolean)
returns boolean language sql stable security definer set search_path = ''
as $$
  select cardinality(string_to_array(object_name,'/'))=4
    and split_part(object_name,'/',4)<>''
    and split_part(object_name,'/',3) in ('documents','company','tax')
    and exists (select 1 from public.fleet_dispatch_drivers d
      where d.fleet_id=split_part(object_name,'/',1) and d.id::text=split_part(object_name,'/',2))
    and case when for_upload then exists (
      select 1 from public.fleets f where f.id=split_part(object_name,'/',1) and f.admin_user_id=(select auth.uid()))
      else fleet_internal.driver_profile_access(split_part(object_name,'/',1),case split_part(object_name,'/',3)
        when 'documents' then 'driver_documents' when 'company' then 'driver_company_file' when 'tax' then 'driver_tax' end) end;
$$;
revoke all on function fleet_internal.driver_profile_file_access(text,boolean) from public, anon, authenticated;
grant execute on function fleet_internal.driver_profile_file_access(text,boolean) to authenticated;

create policy fleet_driver_profile_files_read on storage.objects for select to authenticated
  using(bucket_id='fleet-driver-profile-files' and fleet_internal.driver_profile_file_access(name,false));
create policy fleet_driver_profile_files_upload on storage.objects for insert to authenticated
  with check(bucket_id='fleet-driver-profile-files' and fleet_internal.driver_profile_file_access(name,true));

create policy fleet_driver_profile_statements_read on storage.objects for select to authenticated
  using(bucket_id='company-driver-pay' and fleet_internal.driver_profile_access(split_part(name,'/',1),'driver_pay_settlements'));

create table public.office_review_issues (
  id uuid primary key,
  fleet_id text not null references public.fleets(id) on delete cascade,
  filed_by uuid not null references auth.users(id),
  driver_id uuid,
  title text not null check(char_length(btrim(title)) between 1 and 120),
  description text not null check(char_length(btrim(description)) between 1 and 2000),
  reviewer_ids uuid[] not null check(cardinality(reviewer_ids) between 1 and 50),
  created_at timestamptz not null default clock_timestamp(),
  foreign key(fleet_id,driver_id) references public.fleet_dispatch_drivers(fleet_id,id)
);
create index office_review_issues_filer on public.office_review_issues (filed_by);
create index office_review_issues_reviewers on public.office_review_issues using gin (reviewer_ids);
alter table public.office_review_issues enable row level security;
revoke all on public.office_review_issues from public, anon, authenticated;
grant select on public.office_review_issues to authenticated;

create function fleet_internal.office_review_issue_viewer(target_fleet text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=(select auth.uid()))
    or exists (select 1 from public.fleet_employees e where e.fleet_id=target_fleet and e.user_id=(select auth.uid())
      and not e.password_required and e.office_is_official);
$$;
revoke all on function fleet_internal.office_review_issue_viewer(text) from public, anon, authenticated;
grant execute on function fleet_internal.office_review_issue_viewer(text) to authenticated;

create policy office_review_issues_participants on public.office_review_issues for select to authenticated
  using(filed_by=(select auth.uid()) or (reviewer_ids @> array[(select auth.uid())]
     and fleet_internal.office_review_issue_viewer(fleet_id)));

create function fleet_internal.office_issue_reviewers(target_fleet text, author uuid)
returns table(id uuid, name text)
language sql stable set search_path = ''
as $$
  select e.user_id, coalesce(nullif(btrim(e.first_name || ' ' || e.last_name),''), 'Official ' || e.employee_id)
  from public.fleet_employees e where e.fleet_id=target_fleet and e.office_is_official
    and not e.password_required and e.user_id<>author
  union all
  select f.admin_user_id, 'Fleet Admin' from public.fleets f where f.id=target_fleet and f.admin_user_id<>author;
$$;
revoke all on function fleet_internal.office_issue_reviewers(text,uuid) from public, anon, authenticated;

create function fleet_internal.file_office_review_issue(target_fleet text, action text, target_driver uuid, payload jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  selected uuid[];
  issue_id uuid;
begin
  if not exists (select 1 from public.fleet_employees e where e.fleet_id=target_fleet
    and e.user_id=actor and not e.password_required) then
    raise exception 'Only an active Office employee can file an issue in this fleet.' using errcode='42501';
  end if;
  if action='reviewers' then
    return coalesce((select jsonb_agg(to_jsonb(r) order by r.name,r.id)
      from fleet_internal.office_issue_reviewers(target_fleet,actor) r),'[]');
  end if;
  if action is distinct from 'file' or jsonb_typeof(payload->'reviewers') is distinct from 'array'
    or coalesce(char_length(btrim(payload->>'title')),0) not between 1 and 120
    or coalesce(char_length(btrim(payload->>'description')),0) not between 1 and 2000 then
    raise exception 'Enter an issue title, description, and reviewers.' using errcode='22023';
  end if;
  if target_driver is not null and (not fleet_internal.driver_profile_access(target_fleet,null) or not exists(
    select 1 from public.fleet_dispatch_drivers d where d.fleet_id=target_fleet and d.id=target_driver)) then
    raise exception 'That driver is unavailable in this fleet.' using errcode='42501';
  end if;
  select array_agg(distinct value::uuid order by value::uuid) into selected from jsonb_array_elements_text(payload->'reviewers') value;
  if coalesce(cardinality(selected),0) not between 1 and 50 or exists (
    select unnest(selected) except select r.id from fleet_internal.office_issue_reviewers(target_fleet,actor) r) then
    raise exception 'Select one or more active officials in this fleet.' using errcode='22023';
  end if;
  issue_id := (payload->>'id')::uuid;
  if issue_id is null then raise exception 'The issue needs a submission ID.' using errcode='22023'; end if;
  insert into public.office_review_issues(id,fleet_id,filed_by,driver_id,title,description,reviewer_ids)
  values(issue_id,target_fleet,actor,target_driver,btrim(payload->>'title'),btrim(payload->>'description'),selected)
  on conflict(id) do nothing;
  if not exists(select 1 from public.office_review_issues i where i.id=issue_id and i.filed_by=actor and i.fleet_id=target_fleet) then
    raise exception 'This issue ID is unavailable.' using errcode='42501';
  end if;
  if not exists(select 1 from public.office_review_issues i where i.id=issue_id
    and i.driver_id is not distinct from target_driver and i.title=btrim(payload->>'title')
    and i.description=btrim(payload->>'description') and i.reviewer_ids=selected) then
    raise exception 'This issue was already filed. Close the form to submit a separate issue.' using errcode='22023';
  end if;
  return jsonb_build_object('id',issue_id);
end;
$$;

create function public.file_office_review_issue(target_fleet text, action text, target_driver uuid default null, payload jsonb default '{}')
returns jsonb language sql security invoker set search_path = ''
as $$ select fleet_internal.file_office_review_issue(target_fleet,action,target_driver,payload); $$;

revoke all on function public.file_office_review_issue(text,text,uuid,jsonb),
  fleet_internal.file_office_review_issue(text,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.file_office_review_issue(text,text,uuid,jsonb),
  fleet_internal.file_office_review_issue(text,text,uuid,jsonb) to authenticated;

CREATE OR REPLACE FUNCTION fleet_internal.office_profiles(fleet text, action text, employee_number text, settings jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  fleet_admin boolean := exists (select 1 from public.fleets f where f.id=fleet and f.admin_user_id=actor);
  account public.fleet_employees%rowtype;
  selected_permissions text[];
  official_choice boolean;
  manage_profiles_choice boolean;
  link_profiles_choice boolean;
  manage_fuel_settings_choice boolean;
begin
  if actor is null or not fleet_internal.office_profile_manager(fleet,actor) then
    raise exception 'Manage Employee Profiles access is required.' using errcode='42501';
  end if;
  if action='list' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'employee_id',e.employee_id,'first_name',e.first_name,'last_name',e.last_name,
      'office_role',e.office_role,'office_is_official',e.office_is_official,'office_permissions',e.office_permissions,
      'office_can_manage_profiles',e.office_can_manage_profiles,'office_can_link_profiles',e.office_can_link_profiles,
      'office_can_manage_fuel_settings',e.office_can_manage_fuel_settings,
      'password_required',e.password_required,
      'can_edit',fleet_internal.office_can_edit_employee(e,actor)) order by e.created_at desc,e.employee_id)
      from public.fleet_employees e where e.fleet_id=fleet),'[]'::jsonb);
  end if;

  select * into account from public.fleet_employees e where e.fleet_id=fleet and e.employee_id=employee_number for update;
  if not found or not fleet_internal.office_can_edit_employee(account,actor) then
    raise exception 'You cannot manage this Office profile.' using errcode='42501';
  end if;
  if action='reset_target' then return jsonb_build_object('user_id',account.user_id); end if;
  if action is distinct from 'edit' or jsonb_typeof(settings -> 'permissions') is distinct from 'array' then
    raise exception 'Select valid Office access options.' using errcode='22023';
  end if;
  official_choice := account.office_is_official;
  manage_profiles_choice := account.office_can_manage_profiles;
  if settings ? 'is_official' or settings ? 'can_manage_profiles' then
    if not fleet_admin then raise exception 'Only the Fleet Admin can change designation or profile management access.' using errcode='42501'; end if;
    if jsonb_typeof(settings -> 'is_official') is distinct from 'boolean'
      or jsonb_typeof(settings -> 'can_manage_profiles') is distinct from 'boolean' then
      raise exception 'Choose Official or Unofficial and whether they can manage profiles.' using errcode='22023';
    end if;
    official_choice := (settings ->> 'is_official')::boolean;
    manage_profiles_choice := (settings ->> 'can_manage_profiles')::boolean;
  end if;
  link_profiles_choice := account.office_can_link_profiles;
  if settings ? 'can_link_profiles' then
    if not fleet_admin then
      raise exception 'Only the Fleet Admin can change profile linking access.' using errcode='42501';
    end if;
    if jsonb_typeof(settings -> 'can_link_profiles') is distinct from 'boolean' then
      raise exception 'Choose whether this Official can link profiles.' using errcode='22023';
    end if;
    link_profiles_choice := (settings ->> 'can_link_profiles')::boolean;
    if link_profiles_choice and not official_choice then
      raise exception 'Only Officials can be given profile linking access.' using errcode='22023';
    end if;
  end if;
  manage_fuel_settings_choice := account.office_can_manage_fuel_settings;
  if settings ? 'can_manage_fuel_settings' then
    if not fleet_admin then
      raise exception 'Only the Fleet Admin can change fuel surcharge access.' using errcode='42501';
    end if;
    if jsonb_typeof(settings -> 'can_manage_fuel_settings') is distinct from 'boolean' then
      raise exception 'Choose whether this employee can manage the fuel surcharge.' using errcode='22023';
    end if;
    manage_fuel_settings_choice := (settings ->> 'can_manage_fuel_settings')::boolean;
  end if;
  select array(select distinct value from jsonb_array_elements_text(settings -> 'permissions') value where value is not null order by value)
    into selected_permissions;
  if not (selected_permissions <@ (array['dispatch','drivers','assets','messages','hr','payroll','settlements','hourly','bank_ledger','payments','policies','activity'] || fleet_internal.driver_profile_permissions())) then
    raise exception 'Select valid Office access options.' using errcode='22023';
  end if;
  if not fleet_admin then
    selected_permissions := array(select p from unnest(selected_permissions) p
      where not (p=any(fleet_internal.driver_profile_permissions())))
      || array(select p from unnest(account.office_permissions) p where p=any(fleet_internal.driver_profile_permissions()));
  end if;
  if not fleet_admin and not exists(select 1 from public.fleet_employees e
    where e.user_id=actor and e.fleet_id=fleet and not e.password_required and e.office_can_manage_profiles
      and (e.office_is_official or selected_permissions <@ e.office_permissions)) then
    raise exception 'You can assign permissions within your own access.' using errcode='42501';
  end if;
  update public.fleet_employees e set office_is_official=official_choice,office_permissions=selected_permissions,
      office_can_manage_profiles=manage_profiles_choice,
      office_can_link_profiles=official_choice and link_profiles_choice,
      office_can_manage_fuel_settings=manage_fuel_settings_choice
    where e.user_id=account.user_id and e.fleet_id=fleet;
  return '{}'::jsonb;
end;
$function$;

create function fleet_internal.driver_profile_bol_access(object_name text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.fleet_dispatch_loads q
    where q.id=case when split_part(object_name,'/',1) ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
      then split_part(object_name,'/',1)::uuid end
    and fleet_internal.driver_profile_access(q.fleet_id,'driver_bols'));
$$;
revoke all on function fleet_internal.driver_profile_bol_access(text) from public, anon, authenticated;
grant execute on function fleet_internal.driver_profile_bol_access(text) to authenticated;
create policy fleet_driver_profile_bols_read on storage.objects for select to authenticated
  using(bucket_id='driver-load-documents' and fleet_internal.driver_profile_bol_access(name));

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
  select p.user_id,p.profile_id,p.display_profile_id,p.first_name,p.last_name,p.phone,p.license_number,
    p.profile_type,l.employee_number,l.unlinked_at,d.id as dispatch_driver_id,d.name,d.driver_type,d.equipment,d.availability
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
      d.id as dispatch_driver_id,d.name,d.driver_type,d.equipment,d.availability into driver
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
      'truck',equipment_info->>'truck','trailer',equipment_info->>'trailer',
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

CREATE OR REPLACE FUNCTION fleet_internal.message_staff_scope(actor uuid, fleet text)
 RETURNS text[]
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select case when exists(select 1 from public.fleets where id=fleet and admin_user_id=actor)
    then array['staff','official','dispatch','maintenance','safety']
    else coalesce((
      select array['staff']
        || case when e.office_is_official then array['official'] else array[]::text[] end
        || case when e.office_is_official or e.office_permissions && array['dispatch','messages','assets','policies']
          then array['dispatch','maintenance','safety']
          when 'driver_messages'=any(e.office_permissions) and 'drivers'=any(e.office_permissions)
          then array['dispatch'] else array[]::text[] end
      from public.fleet_employees e where e.fleet_id=fleet and e.user_id=actor and not e.password_required
    ),array[]::text[]) end;
$function$;
