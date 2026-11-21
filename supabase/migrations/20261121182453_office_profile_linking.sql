alter table public.fleet_employees
  add column office_can_link_profiles boolean not null default false,
  add constraint fleet_employee_link_profiles_requires_official
    check (not office_can_link_profiles or office_is_official);

grant select (office_can_link_profiles) on public.fleet_employees to authenticated;

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
begin
  if actor is null or not fleet_internal.office_profile_manager(fleet,actor) then
    raise exception 'Manage Employee Profiles access is required.' using errcode='42501';
  end if;
  if action='list' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'employee_id',e.employee_id,'first_name',e.first_name,'last_name',e.last_name,
      'office_role',e.office_role,'office_is_official',e.office_is_official,'office_permissions',e.office_permissions,
      'office_can_manage_profiles',e.office_can_manage_profiles,'office_can_link_profiles',e.office_can_link_profiles,
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
      office_can_link_profiles=official_choice and link_profiles_choice
    where e.user_id=account.user_id and e.fleet_id=fleet;
  return '{}'::jsonb;
end;
$function$;

CREATE OR REPLACE FUNCTION fleet_internal.profile_link_key(action text, link_key text, employee_number text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  target_fleet text;
  fleet_admin uuid;
  normalized_key text;
  key_text text;
  seed text;
  key_expires timestamptz;
  target_user uuid;
  profile public.rigtracker_profiles%rowtype;
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;

  if action in ('issue','revoke','status') then
    perform 1 from public.rigtracker_profiles p where p.user_id=actor and not p.password_required
      for update;
    if not found then raise exception 'An active RigTracker profile is required.' using errcode='42501'; end if;
    if action='revoke' then
      delete from fleet_internal.rigtracker_profile_link_keys where profile_user_id=actor;
      return '{}'::jsonb;
    end if;
    if action='status' then
      select k.expires_at into key_expires from fleet_internal.rigtracker_profile_link_keys k
        where k.profile_user_id=actor and k.expires_at>clock_timestamp();
      return jsonb_build_object('expires_at',key_expires);
    end if;

    -- Use 80 random bits from UUIDv4, excluding its version and variant fields.
    seed := replace(gen_random_uuid()::text,'-','');
    normalized_key := upper(substr(seed,1,12) || substr(seed,18,8));
    key_text := substr(normalized_key,1,4) || '-' || substr(normalized_key,5,4) || '-'
      || substr(normalized_key,9,4) || '-' || substr(normalized_key,13,4) || '-' || substr(normalized_key,17,4);
    key_expires := clock_timestamp() + interval '24 hours';
    insert into fleet_internal.rigtracker_profile_link_keys(profile_user_id,key_hash,expires_at)
      values(actor,sha256(convert_to(normalized_key,'UTF8')),key_expires)
      on conflict(profile_user_id) do update set key_hash=excluded.key_hash,expires_at=excluded.expires_at;
    return jsonb_build_object('key',key_text,'expires_at',key_expires);
  end if;

  if coalesce(action,'') not in ('preview','redeem') then
    raise exception 'Choose a link key action.' using errcode='22023';
  end if;
  select f.id, f.admin_user_id into target_fleet, fleet_admin
    from public.fleets f where f.admin_user_id=actor;
  if not found then
    select f.id, f.admin_user_id into target_fleet, fleet_admin
      from public.fleet_employees e
      join public.fleets f on f.id=e.fleet_id
      where e.user_id=actor and e.office_is_official and e.office_can_link_profiles
        and not e.password_required
      for share of e;
    if not found then
      raise exception 'Profile linking access is required.' using errcode='42501';
    end if;
  end if;

  normalized_key := upper(regexp_replace(coalesce(link_key,''),'[-[:space:]]','','g'));
  if normalized_key !~ '^[A-F0-9]{20}$' then
    raise exception 'Enter a complete link key.' using errcode='22023';
  end if;
  if action='redeem' then
    select k.profile_user_id into target_user from fleet_internal.rigtracker_profile_link_keys k
      where k.key_hash=sha256(convert_to(normalized_key,'UTF8')) and k.expires_at>clock_timestamp()
      for update;
  else
    select k.profile_user_id into target_user from fleet_internal.rigtracker_profile_link_keys k
      where k.key_hash=sha256(convert_to(normalized_key,'UTF8')) and k.expires_at>clock_timestamp();
  end if;

  select * into profile from public.rigtracker_profiles p where p.user_id=target_user and not p.password_required;
  if not found then
    raise exception 'This link key is no longer available. Ask the profile owner for a new key.' using errcode='22023';
  end if;
  if exists(select 1 from public.rigtracker_fleet_links l
    where l.fleet_id=target_fleet and l.profile_user_id=target_user and l.unlinked_at is null) then
    raise exception 'This profile is already linked to your fleet.' using errcode='22023';
  end if;
  if action='redeem' then
    perform fleet_internal.set_rigtracker_link(fleet_admin,target_fleet,target_user,nullif(btrim(employee_number),''),false);
    delete from fleet_internal.rigtracker_profile_link_keys where profile_user_id=target_user;
  end if;
  return jsonb_build_object('first_name',profile.first_name,'last_name',profile.last_name,'profile_type',profile.profile_type);
end;
$function$;
