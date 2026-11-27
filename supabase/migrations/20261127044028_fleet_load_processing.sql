-- Extend the existing payment list so paid dates and the PRO search have one source.
create function fleet_internal.list_fleet_load_processing(
  target_fleet text, paid boolean, target_pro text, pro_prefix text,
  before_date date, before_time timestamptz, before_load uuid
)
returns table (
  load_id uuid, pro_number text, return_load boolean, delivered_at text, paid_on date,
  sort_at timestamptz, destination text, paperwork jsonb, rate_confirmation text,
  broker_name text, broker_phone text, broker_email text, broker_load_number text
)
language sql stable security definer set search_path = ''
as $$
  select p.*,
    case when starts_with(l.details #>> '{rateConfirmation,path}', l.fleet_id || '/' || l.id::text || '/')
      then l.details #>> '{rateConfirmation,path}' end,
    nullif(btrim(l.details ->> 'brokerName'), ''),
    nullif(btrim(l.details ->> 'brokerPhone'), ''),
    nullif(btrim(l.details ->> 'brokerEmail'), ''),
    nullif(btrim(l.details ->> 'brokerLoadNumber'), '')
  from fleet_internal.list_fleet_bol_payments(
    target_fleet, paid, target_pro, pro_prefix, before_date, before_time, before_load
  ) p
  join public.fleet_dispatch_loads l on l.fleet_id = target_fleet and l.id = p.load_id
  order by p.paid_on desc, p.sort_at desc, p.load_id desc;
$$;

create function public.list_fleet_load_processing(
  target_fleet text, paid boolean, target_pro text, pro_prefix text,
  before_date date, before_time timestamptz, before_load uuid
)
returns table (
  load_id uuid, pro_number text, return_load boolean, delivered_at text, paid_on date,
  sort_at timestamptz, destination text, paperwork jsonb, rate_confirmation text,
  broker_name text, broker_phone text, broker_email text, broker_load_number text
)
language sql stable security invoker set search_path = ''
as $$
  select * from fleet_internal.list_fleet_load_processing(
    target_fleet, paid, target_pro, pro_prefix, before_date, before_time, before_load
  );
$$;

-- Load Processing adds read access only for files attached to a completed load.
create function fleet_internal.load_processing_document_access(object_name text, is_rate_confirmation boolean)
returns boolean
language sql stable security definer set search_path = ''
as $$
  with object_load as (
    select split_part(object_name, '/', case when is_rate_confirmation then 2 else 1 end) as id
  )
  select exists (
    select 1
    from object_load o
    join public.fleet_dispatch_loads l on l.id = case
      when o.id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then o.id::uuid
    end
    where l.status = 'completed' and fleet_internal.office_has_permission(l.fleet_id, 'bol_payments')
      and case when is_rate_confirmation then
        split_part(object_name, '/', 1) = l.fleet_id
        and l.details #>> '{rateConfirmation,path}' = object_name
      else exists (
        select 1
        from fleet_internal.workflow_stops(l.details) s
        cross join lateral fleet_internal.driver_report_documents(
          l.progress #> array['stops', s.stop_key, 'driverReport']
        ) f
        where f.path = object_name
      ) end
  );
$$;

revoke all on function fleet_internal.list_fleet_load_processing(text, boolean, text, text, date, timestamptz, uuid),
  public.list_fleet_load_processing(text, boolean, text, text, date, timestamptz, uuid),
  fleet_internal.load_processing_document_access(text, boolean)
  from public, anon, authenticated;

grant execute on function fleet_internal.list_fleet_load_processing(text, boolean, text, text, date, timestamptz, uuid),
  public.list_fleet_load_processing(text, boolean, text, text, date, timestamptz, uuid),
  fleet_internal.load_processing_document_access(text, boolean)
  to authenticated;

create policy load_processing_bol_read on storage.objects for select to authenticated
  using (bucket_id = 'driver-load-documents' and fleet_internal.load_processing_document_access(name, false));

create policy load_processing_rate_confirmation_read on storage.objects for select to authenticated
  using (bucket_id = 'dispatch-rate-confirmations' and fleet_internal.load_processing_document_access(name, true));

-- Make the existing payment permission selectable in Employee Profiles.
alter table public.fleet_employees drop constraint fleet_employee_office_permissions_check;
alter table public.fleet_employees add constraint fleet_employee_office_permissions_check check (
  office_permissions <@ (array['dispatch','bol_payments','drivers','assets','messages','hr','payroll','settlements','hourly',
    'bank_ledger','payments','policies','activity'] || fleet_internal.driver_profile_permissions())
);

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
  if not (selected_permissions <@ (array['dispatch','bol_payments','drivers','assets','messages','hr','payroll','settlements','hourly','bank_ledger','payments','policies','activity'] || fleet_internal.driver_profile_permissions())) then
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
