create function fleet_internal.hr_can_manage_tax(target_fleet text)
returns boolean language sql stable set search_path = ''
as $$
  select fleet_internal.office_has_permission(target_fleet,'hr')
    or fleet_internal.office_has_permission(target_fleet,'payroll');
$$;
revoke all on function fleet_internal.hr_can_manage_tax(text) from public,anon,authenticated;

create function fleet_internal.hr_tax_worker(
  target_fleet text,target_kind text,target_reference text,w2_only boolean
)
returns uuid language plpgsql stable set search_path = ''
as $$
declare
  worker uuid;
begin
  if auth.uid() is null or not fleet_internal.hr_can_manage_tax(target_fleet) then
    raise exception 'HR or payroll access is required to manage tax forms.' using errcode='42501';
  end if;
  if target_kind='hr_office' then
    select e.user_id into worker from public.fleet_employees e
    where e.fleet_id=target_fleet and e.user_id::text=target_reference;
  elsif target_kind='hr_driver' then
    select l.profile_user_id into worker
    from public.rigtracker_fleet_links l
    join public.rigtracker_profiles p on p.user_id=l.profile_user_id
    where l.fleet_id=target_fleet and p.profile_id=target_reference
      and (p.profile_type='company_driver' or (not w2_only and p.profile_type='driver'));
  end if;
  if worker is null then raise exception 'This worker is unavailable for this tax form.' using errcode='42501'; end if;
  return worker;
end;
$$;
revoke all on function fleet_internal.hr_tax_worker(text,text,text,boolean) from public,anon,authenticated;

create function fleet_internal.hr_tax_roster(target_fleet text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  managed boolean := fleet_internal.hr_can_manage_tax(target_fleet);
begin
  if auth.uid() is null or not (managed or fleet_internal.driver_profile_access(target_fleet,'driver_tax')) then
    raise exception 'Tax forms access is required.' using errcode='42501';
  end if;
  return jsonb_build_object('managed',managed,'workers',coalesce((
    select jsonb_agg(to_jsonb(worker) order by worker.kind,worker.name,worker.reference)
    from (
      select 'office' as kind,e.user_id::text as reference,concat_ws(' ',e.first_name,e.last_name) as name,
        e.employee_id as number,null::uuid as driver_id,true as w2,false as former
      from public.fleet_employees e where managed and e.fleet_id=target_fleet
      union all
      select 'driver',p.profile_id,concat_ws(' ',p.first_name,p.last_name),
        coalesce(l.employee_number,p.profile_id),l.dispatch_driver_id,p.profile_type='company_driver',l.unlinked_at is not null
      from public.rigtracker_fleet_links l
      join public.rigtracker_profiles p on p.user_id=l.profile_user_id
      where l.fleet_id=target_fleet and p.profile_type in ('company_driver','driver')
        and (managed or l.dispatch_driver_id is not null)
      union all
      select 'roster',d.id::text,d.name,null,d.id,false,false
      from public.fleet_dispatch_drivers d
      where d.fleet_id=target_fleet and not exists (
        select 1 from public.rigtracker_fleet_links l
        where l.fleet_id=d.fleet_id and l.dispatch_driver_id=d.id)
    ) worker
  ),'[]'::jsonb));
end;
$$;

create function public.hr_tax_roster(target_fleet text)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select fleet_internal.hr_tax_roster(target_fleet);
$$;
revoke all on function fleet_internal.hr_tax_roster(text),public.hr_tax_roster(text) from public,anon,authenticated;
grant execute on function fleet_internal.hr_tax_roster(text),public.hr_tax_roster(text) to authenticated;

create or replace function fleet_internal.payroll_tax_profile(
  action text, target_fleet text, target_kind text, target_reference text, as_of date,
  settings jsonb, expected_revision uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee uuid := case when target_kind in ('hr_office','hr_driver')
    then fleet_internal.hr_tax_worker(target_fleet,target_kind,target_reference,true)
    else fleet_internal.payroll_tax_employee(target_fleet,target_kind,target_reference) end;
  profile fleet_internal.payroll_tax_profiles%rowtype;
begin
  if as_of is null or as_of not between date '2020-01-01' and date '2100-12-31' then
    raise exception 'Choose a valid effective date.' using errcode='22023';
  end if;

  if action='read' then
    select t.* into profile from fleet_internal.payroll_tax_profiles t
    where t.fleet_id=target_fleet and t.employee_user_id=employee and t.effective_on<=as_of
    order by t.effective_on desc limit 1;
  elsif action='save' then
    perform fleet_internal.validate_payroll_tax_settings(settings);
    if expected_revision is null then
      insert into fleet_internal.payroll_tax_profiles as t(fleet_id,employee_user_id,effective_on,settings,saved_by)
      values(target_fleet,employee,as_of,settings,actor)
      on conflict(fleet_id,employee_user_id,effective_on) do nothing returning t.* into profile;
    else
      update fleet_internal.payroll_tax_profiles t
      set settings=payroll_tax_profile.settings, revision=gen_random_uuid(), saved_by=actor, saved_at=clock_timestamp()
      where t.fleet_id=target_fleet and t.employee_user_id=employee and t.effective_on=as_of
        and t.revision=expected_revision returning t.* into profile;
    end if;
    if not found then
      raise exception 'Tax settings changed for this date. Reopen Tax Information and try again.' using errcode='40001';
    end if;
  else
    raise exception 'Choose a tax profile action.' using errcode='22023';
  end if;

  if profile.revision is null then return null; end if;
  return jsonb_build_object('effective_on',profile.effective_on,'settings',profile.settings,'revision',profile.revision);
end;
$$;

create or replace function fleet_internal.payroll_withholding_file_access(object_name text, uploading boolean)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  parts text[] := string_to_array(object_name,'/');
  employee uuid;
  payroll_staff boolean;
begin
  if actor is null or cardinality(parts) is distinct from 4
    or parts[1]='' or parts[2] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or parts[3] not in ('w4','state','w9') or parts[4] !~ '^[0-9a-f-]{36}\.(pdf|jpg|png|webp)$' then
    return false;
  end if;
  employee := parts[2]::uuid;
  payroll_staff := fleet_internal.hr_can_manage_tax(parts[1]);
  if parts[3]='w9' then
    if payroll_staff and not uploading then return true; end if;
    return (actor=employee or payroll_staff) and exists (
      select 1 from fleet_internal.payroll_withholding_fleets(employee) membership where membership.fleet_id=parts[1]
    );
  end if;

  payroll_staff := payroll_staff or (fleet_internal.office_has_permission(parts[1],'settlements')
    and fleet_internal.office_has_permission(parts[1],'driver_tax'));
  if not uploading then return actor=employee or payroll_staff; end if;
  return (actor=employee or payroll_staff) and (
    exists (select 1 from public.fleet_employees e
      where e.user_id=employee and e.fleet_id=parts[1] and not e.password_required)
    or exists (select 1 from public.rigtracker_fleet_links l
      join public.rigtracker_profiles p on p.user_id=l.profile_user_id
      where l.profile_user_id=employee and l.fleet_id=parts[1] and l.unlinked_at is null
        and p.profile_type='company_driver' and not p.password_required)
  );
end;
$$;

create or replace function fleet_internal.payroll_withholding_folders(target_fleet text, target_kind text, target_reference text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee uuid;
begin
  if actor is null then raise exception 'Sign in to open tax forms.' using errcode='42501'; end if;
  if target_fleet is null and target_kind is null and target_reference is null then
    return coalesce((select jsonb_agg(jsonb_build_object('fleet',m.fleet_id,'folder',m.fleet_id||'/'||actor::text) order by m.fleet_id)
      from fleet_internal.payroll_withholding_fleets(actor) m),'[]'::jsonb);
  end if;
  if target_kind in ('hr_office','hr_driver') then
    employee := fleet_internal.hr_tax_worker(target_fleet,target_kind,target_reference,false);
  elsif target_kind in ('contractor_driver','contractor_office') then
    if not fleet_internal.office_has_permission(target_fleet,'payroll') then
      raise exception 'Payroll access is required to open contractor tax forms.' using errcode='42501';
    end if;
    if target_kind='contractor_driver' then
      select l.profile_user_id into employee from public.rigtracker_fleet_links l
        join public.rigtracker_profiles p on p.user_id=l.profile_user_id
        where l.fleet_id=target_fleet and l.unlinked_at is null and p.profile_id=target_reference
          and p.profile_type in ('company_driver','driver');
    else
      select e.user_id into employee from public.fleet_employees e
        where e.fleet_id=target_fleet and e.employee_id=target_reference;
    end if;
    if employee is null then raise exception 'This recipient is unavailable in the selected fleet.' using errcode='42501'; end if;
  else
    employee := fleet_internal.payroll_tax_employee(target_fleet,target_kind,target_reference);
  end if;
  return jsonb_build_array(jsonb_build_object('fleet',target_fleet,'folder',target_fleet||'/'||employee::text));
end;
$$;

create or replace function fleet_internal.driver_profile_file_access(object_name text, for_upload boolean)
returns boolean language sql stable security definer set search_path = ''
as $$
  select cardinality(string_to_array(object_name,'/'))=4
    and split_part(object_name,'/',4)<>''
    and split_part(object_name,'/',3) in ('documents','company','tax')
    and exists (select 1 from public.fleet_dispatch_drivers d
      where d.fleet_id=split_part(object_name,'/',1) and d.id::text=split_part(object_name,'/',2))
    and case
      when split_part(object_name,'/',3)='tax' and fleet_internal.hr_can_manage_tax(split_part(object_name,'/',1)) then true
      when for_upload then exists (
      select 1 from public.fleets f where f.id=split_part(object_name,'/',1) and f.admin_user_id=(select auth.uid()))
      else fleet_internal.driver_profile_access(split_part(object_name,'/',1),case split_part(object_name,'/',3)
        when 'documents' then 'driver_documents' when 'company' then 'driver_company_file' when 'tax' then 'driver_tax' end) end;
$$;

alter policy payroll_withholding_forms_upload on storage.objects
  with check(bucket_id='payroll-withholding-forms' and fleet_internal.payroll_withholding_file_access(name,true)
    and (user_metadata is null or user_metadata - array['w4','signed_on']='{}'::jsonb)
    and (user_metadata->'w4' is null or (split_part(name,'/',3)='w4'
      and fleet_internal.valid_withholding_elections(user_metadata->'w4')))
    and case
      when user_metadata->'signed_on' is null then true
      when split_part(name,'/',3)='w9' and jsonb_typeof(user_metadata->'signed_on')='string'
        and user_metadata->>'signed_on' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        then (user_metadata->>'signed_on')::date between date '1900-01-01' and current_date
      else false
    end);

create or replace function public.payroll_withholding_submissions(target_folder text)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(rec) order by rec.created_at desc,rec.path),'[]'::jsonb)
  from (
    select o.name as path,o.created_at,split_part(o.name,'/',3) as kind,
      o.user_metadata->'w4' as elections,o.user_metadata->>'signed_on' as signed_on
    from storage.objects o
    where o.bucket_id='payroll-withholding-forms' and o.name like target_folder||'/%'
      and split_part(o.name,'/',1)||'/'||split_part(o.name,'/',2)=target_folder
      and fleet_internal.payroll_withholding_file_access(o.name,false)
    order by o.created_at desc,o.name limit 100
  ) rec;
$$;

create table fleet_internal.hr_workspaces (
  fleet_id text primary key references public.fleets(id) on delete cascade,
  tabs jsonb not null check (jsonb_typeof(tabs)='array'),
  revision uuid not null default gen_random_uuid()
);
alter table fleet_internal.hr_workspaces enable row level security;
revoke all on fleet_internal.hr_workspaces from public,anon,authenticated;

create function fleet_internal.hr_workspace_tabs(action text,target_fleet text,tabs jsonb,expected_revision uuid)
returns jsonb language plpgsql set search_path = '' security definer
as $$
declare
  actor uuid := auth.uid();
  workspace fleet_internal.hr_workspaces%rowtype;
begin
  if actor is null or not fleet_internal.office_has_permission(target_fleet,'hr') then
    raise exception 'HR access is required to open the workspace.' using errcode='42501';
  end if;
  if action='read' then
    select * into workspace from fleet_internal.hr_workspaces w where w.fleet_id=target_fleet;
  elsif action='save' then
    if not exists(select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=actor) then
      raise exception 'Only Fleet Admin can change the HR tabs.' using errcode='42501';
    end if;
    if jsonb_typeof(tabs) is distinct from 'array' then
      raise exception 'Enter a valid list of HR tabs.' using errcode='22023';
    end if;
    if jsonb_array_length(tabs)>30 or exists (
      select 1 from jsonb_array_elements(tabs) as item(tab)
      where jsonb_typeof(tab) is distinct from 'object'
        or tab - array['id','title','body','archived'] <> '{}'::jsonb
        or coalesce(tab->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or jsonb_typeof(tab->'title') is distinct from 'string'
        or char_length(btrim(tab->>'title')) not between 1 and 80
        or jsonb_typeof(tab->'body') is distinct from 'string'
        or char_length(tab->>'body')>4000
        or jsonb_typeof(tab->'archived') is distinct from 'boolean'
    ) then
      raise exception 'Enter a name for each HR tab. A fleet can save up to 30 tabs.' using errcode='22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(tabs) as item(tab)
      group by tab->>'id' having count(*)>1
    ) or exists (
      select 1 from jsonb_array_elements(tabs) as item(tab)
      where tab->'archived'='false'::jsonb
      group by lower(btrim(tab->>'title'))
      having count(*)>1 or lower(btrim(tab->>'title'))='tax forms'
    ) then
      raise exception 'Give each active HR tab its own name. Tax Forms is already built in.' using errcode='22023';
    end if;
    if expected_revision is null then
      insert into fleet_internal.hr_workspaces(fleet_id,tabs) values(target_fleet,tabs)
      on conflict do nothing returning * into workspace;
    else
      update fleet_internal.hr_workspaces w set tabs=hr_workspace_tabs.tabs,revision=gen_random_uuid()
      where w.fleet_id=target_fleet and w.revision=expected_revision returning * into workspace;
    end if;
    if workspace.revision is null then
      raise exception 'The HR tabs changed. Reopen Manage HR Tabs to see the latest version.' using errcode='40001';
    end if;
  else
    raise exception 'Choose a valid HR workspace action.' using errcode='22023';
  end if;
  return jsonb_build_object('tabs',coalesce(workspace.tabs,'[]'::jsonb),'revision',workspace.revision);
end;
$$;

create function public.hr_workspace_tabs(action text,target_fleet text,tabs jsonb default null,expected_revision uuid default null)
returns jsonb language sql set search_path = '' security invoker
as $$
  select fleet_internal.hr_workspace_tabs(action,target_fleet,tabs,expected_revision);
$$;
revoke all on function fleet_internal.hr_workspace_tabs(text,text,jsonb,uuid),
  public.hr_workspace_tabs(text,text,jsonb,uuid) from public,anon,authenticated;
grant execute on function fleet_internal.hr_workspace_tabs(text,text,jsonb,uuid),
  public.hr_workspace_tabs(text,text,jsonb,uuid) to authenticated;
