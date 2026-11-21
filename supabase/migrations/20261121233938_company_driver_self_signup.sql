create or replace function fleet_internal.create_rigtracker_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  kind text := coalesce(new.raw_app_meta_data ->> 'account_type', new.raw_user_meta_data ->> 'account_type', 'driver');
  trusted_kind text := new.raw_app_meta_data ->> 'account_type';
  setup jsonb := new.raw_app_meta_data -> 'company_setup';
  fleet_created_company boolean := trusted_kind is not distinct from 'company_driver';
  profile_phone text := coalesce(setup ->> 'phone', '');
  profile_license text := coalesce(setup ->> 'license_number', '');
begin
  if tg_op = 'UPDATE' and (not fleet_created_company or setup is null) then return new; end if;
  if lower(coalesce(new.email, '')) like '%@fleet-login.rigtrackerpro.com' then return new; end if;
  if kind not in ('driver', 'company_driver', 'mechanic') then return new; end if;

  if kind = 'company_driver' and not fleet_created_company then
    if jsonb_typeof(new.raw_user_meta_data -> 'first_name') is distinct from 'string'
      or jsonb_typeof(new.raw_user_meta_data -> 'last_name') is distinct from 'string'
      or jsonb_typeof(new.raw_user_meta_data -> 'phone') is distinct from 'string'
      or jsonb_typeof(new.raw_user_meta_data -> 'license_number') is distinct from 'string' then
      raise exception 'Complete all Company Driver fields.' using errcode = '22023';
    end if;
    profile_phone := btrim(new.raw_user_meta_data ->> 'phone');
    profile_license := btrim(new.raw_user_meta_data ->> 'license_number');
    new.raw_user_meta_data := new.raw_user_meta_data - array['phone', 'license_number'];
  end if;

  if tg_op = 'UPDATE' then
    update public.rigtracker_profiles
    set profile_type = kind,
        first_name = setup ->> 'first_name',
        last_name = setup ->> 'last_name',
        phone = profile_phone,
        license_number = profile_license,
        password_required = true
    where user_id = new.id;
  end if;
  if tg_op = 'INSERT' or not found then
    loop
      insert into public.rigtracker_profiles(user_id, profile_type, first_name, last_name, phone, license_number, password_required)
      values (new.id, kind,
        coalesce(setup ->> 'first_name', left(btrim(new.raw_user_meta_data ->> 'first_name'), 100), ''),
        coalesce(setup ->> 'last_name', left(btrim(new.raw_user_meta_data ->> 'last_name'), 100), ''),
        profile_phone, profile_license, fleet_created_company)
      on conflict (profile_id) do nothing;
      exit when found;
    end loop;
  end if;
  new.raw_app_meta_data := (coalesce(new.raw_app_meta_data, '{}'::jsonb) - 'company_setup')
    || jsonb_build_object('account_type', kind);

  if fleet_created_company then
    perform fleet_internal.set_rigtracker_link((setup ->> 'admin_id')::uuid, setup ->> 'fleet_id',
      new.id, setup ->> 'employee_number', false);
  end if;
  return new;
end;
$$;
