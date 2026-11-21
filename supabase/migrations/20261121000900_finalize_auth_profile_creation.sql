CREATE OR REPLACE FUNCTION fleet_internal.add_employee_membership()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  account auth.users%rowtype;
  employee_fleet_id text;
  employee_number text;
begin
  -- Auth sets administrator-supplied app metadata after its initial insert.
  select * into account from auth.users where id = new.id;
  employee_fleet_id := account.raw_app_meta_data ->> 'fleet_id';
  employee_number := account.raw_app_meta_data ->> 'employee_id';
  if account.raw_app_meta_data ->> 'account_type' = 'fleet_employee' then
    if employee_fleet_id is null or employee_fleet_id !~ '^[a-z0-9]{1,20}$'
      or employee_number is null or employee_number !~ '^[0-9]{1,6}$'
      or account.email is distinct from lower(employee_fleet_id || '-' || employee_number) || '@fleet-login.rigtrackerpro.com' then
      raise exception 'Invalid fleet employee account.';
    end if;
    insert into public.fleet_employees (
      user_id, fleet_id, employee_id, first_name, last_name, office_role, office_permissions
    ) values (
      new.id, employee_fleet_id, employee_number,
      account.raw_user_meta_data ->> 'first_name',
      account.raw_user_meta_data ->> 'last_name',
      account.raw_app_meta_data ->> 'office_role',
      array(select jsonb_array_elements_text(coalesce(account.raw_app_meta_data -> 'office_permissions', '[]'::jsonb)))
    );
  elsif lower(coalesce(account.email, '')) like '%@fleet-login.rigtrackerpro.com' then
    raise exception 'Fleet employee accounts must be created by the Fleet Admin.';
  end if;
  return new;
end;
$function$;

drop trigger rigtracker_add_fleet_employee on auth.users;
create constraint trigger rigtracker_add_fleet_employee
  after insert on auth.users deferrable initially deferred
  for each row execute function fleet_internal.add_employee_membership();

create or replace function fleet_internal.create_rigtracker_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  kind text := coalesce(new.raw_app_meta_data ->> 'account_type', new.raw_user_meta_data ->> 'account_type', 'driver');
  trusted_kind text := new.raw_app_meta_data ->> 'account_type';
  setup jsonb := new.raw_app_meta_data -> 'company_setup';
begin
  if tg_op = 'UPDATE' and (trusted_kind is distinct from 'company_driver' or setup is null) then return new; end if;
  if lower(coalesce(new.email, '')) like '%@fleet-login.rigtrackerpro.com' then return new; end if;
  if kind = 'company_driver' and trusted_kind is distinct from 'company_driver' then
    raise exception 'A fleet must create a Company Driver profile.';
  end if;
  if kind not in ('driver', 'company_driver', 'mechanic') then return new; end if;
  if tg_op = 'UPDATE' then
    update public.rigtracker_profiles
    set profile_type = kind,
        first_name = setup ->> 'first_name',
        last_name = setup ->> 'last_name',
        phone = setup ->> 'phone',
        license_number = setup ->> 'license_number',
        password_required = true
    where user_id = new.id;
  end if;
  if tg_op = 'INSERT' or not found then
    loop
      insert into public.rigtracker_profiles(user_id, profile_type, first_name, last_name, phone, license_number, password_required)
    values (new.id, kind,
      coalesce(setup ->> 'first_name', left(btrim(new.raw_user_meta_data ->> 'first_name'), 100), ''),
      coalesce(setup ->> 'last_name', left(btrim(new.raw_user_meta_data ->> 'last_name'), 100), ''),
      coalesce(setup ->> 'phone', ''), coalesce(setup ->> 'license_number', ''), kind = 'company_driver')
      on conflict (profile_id) do nothing;
      exit when found;
    end loop;
  end if;
  new.raw_app_meta_data := (coalesce(new.raw_app_meta_data, '{}'::jsonb) - 'company_setup')
    || jsonb_build_object('account_type', kind);
  if kind = 'company_driver' then
    perform fleet_internal.set_rigtracker_link((setup ->> 'admin_id')::uuid, setup ->> 'fleet_id',
      new.id, setup ->> 'employee_number', false);
  end if;
  return new;
end;
$$;

create trigger rigtracker_finalize_profile_metadata
  before update of raw_app_meta_data on auth.users
  for each row execute function fleet_internal.create_rigtracker_profile();
