alter table public.fleet_employees
  add column office_can_manage_fuel_settings boolean not null default false;

grant select (office_can_manage_fuel_settings) on public.fleet_employees to authenticated;

create function fleet_internal.office_can_manage_fuel_settings(target_fleet text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.fleet_employees e
    where e.user_id = (select auth.uid()) and e.fleet_id = target_fleet
      and not e.password_required and e.office_can_manage_fuel_settings
  );
$$;

revoke all on function fleet_internal.office_can_manage_fuel_settings(text) from public, anon, authenticated;
grant execute on function fleet_internal.office_can_manage_fuel_settings(text) to authenticated;

drop policy fleet_dispatch_official_add_fuel_rates on public.fleet_dispatch_fuel_rates;
drop policy fleet_dispatch_official_update_fuel_rates on public.fleet_dispatch_fuel_rates;

create policy fleet_dispatch_approved_read_fuel_rates on public.fleet_dispatch_fuel_rates
  for select to authenticated using (fleet_internal.office_can_manage_fuel_settings(fleet_id));
create policy fleet_dispatch_approved_add_fuel_rates on public.fleet_dispatch_fuel_rates
  for insert to authenticated with check (fleet_internal.office_can_manage_fuel_settings(fleet_id));
create policy fleet_dispatch_approved_update_fuel_rates on public.fleet_dispatch_fuel_rates
  for update to authenticated using (fleet_internal.office_can_manage_fuel_settings(fleet_id))
  with check (fleet_internal.office_can_manage_fuel_settings(fleet_id));

create or replace function fleet_internal.office_can_edit_employee(account public.fleet_employees, actor uuid)
returns boolean language sql stable set search_path = ''
as $$
  select exists(select 1 from public.fleets f where f.id=account.fleet_id and f.admin_user_id=actor)
    or (account.user_id<>actor and not account.office_is_official and not account.office_can_manage_profiles
    and not account.office_can_manage_fuel_settings and exists(
      select 1 from public.fleet_employees e where e.fleet_id=account.fleet_id and e.user_id=actor
        and not e.password_required and e.office_can_manage_profiles
        and (e.office_is_official or account.office_permissions <@ e.office_permissions)
    ));
$$;

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
  if not (selected_permissions <@ array['dispatch','drivers','assets','messages','hr','payroll','settlements','hourly','bank_ledger','payments','policies','activity']) then
    raise exception 'Select valid Office access options.' using errcode='22023';
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
