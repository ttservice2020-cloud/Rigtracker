create function fleet_internal.new_rigtracker_profile_id()
returns text language sql volatile set search_path = ''
as $$
  select (1000000000000000 + (
    ('x' || substr(replace(gen_random_uuid()::text, '-', ''), 17, 15))::bit(60)::bigint % 9000000000000000
  ))::text;
$$;

create table public.rigtracker_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade deferrable initially deferred,
  profile_id text unique not null default fleet_internal.new_rigtracker_profile_id()
    check (profile_id ~ '^[0-9]{16}$'),
  profile_type text not null check (profile_type in ('company_driver', 'driver', 'mechanic')),
  first_name text not null default '' check (char_length(first_name) <= 100),
  last_name text not null default '' check (char_length(last_name) <= 100),
  phone text not null default '' check (char_length(phone) <= 40),
  license_number text not null default '' check (char_length(license_number) <= 80),
  password_required boolean not null default false,
  check (profile_type <> 'company_driver' or (
    btrim(first_name) <> '' and btrim(last_name) <> '' and btrim(phone) <> '' and btrim(license_number) <> ''
  ))
);
alter table public.fleet_employees add column password_required boolean not null default false;
alter table public.fleet_dispatch_drivers add column link_active boolean not null default true;

create table public.rigtracker_fleet_links (
  fleet_id text not null references public.fleets(id) on delete cascade,
  profile_user_id uuid not null references public.rigtracker_profiles(user_id) on delete cascade,
  employee_number text check (employee_number ~ '^[0-9]{1,6}$'),
  dispatch_driver_id uuid,
  unlinked_at timestamptz,
  primary key (fleet_id, profile_user_id),
  foreign key (fleet_id, dispatch_driver_id) references public.fleet_dispatch_drivers(fleet_id, id)
);
create unique index rigtracker_fleet_employee_number_idx
  on public.rigtracker_fleet_links(fleet_id, employee_number)
  where employee_number is not null and unlinked_at is null;
create index rigtracker_fleet_links_profile_idx on public.rigtracker_fleet_links(profile_user_id);
create index rigtracker_fleet_links_dispatch_idx on public.rigtracker_fleet_links(fleet_id, dispatch_driver_id);

alter table public.rigtracker_profiles enable row level security;
alter table public.rigtracker_fleet_links enable row level security;
revoke all on public.rigtracker_profiles, public.rigtracker_fleet_links from public, anon, authenticated;
grant select on public.rigtracker_profiles, public.rigtracker_fleet_links to authenticated, service_role;
grant update (first_name, last_name, phone, license_number) on public.rigtracker_profiles to authenticated;

create policy rigtracker_profile_self_read on public.rigtracker_profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy rigtracker_profile_self_update on public.rigtracker_profiles
  for update to authenticated
  using (user_id = (select auth.uid()) and not password_required)
  with check (user_id = (select auth.uid()) and not password_required);
create policy rigtracker_fleet_link_read on public.rigtracker_fleet_links
  for select to authenticated using (
    fleet_id in (select id from public.fleets where admin_user_id = (select auth.uid()))
    or (
      profile_user_id = (select auth.uid()) and unlinked_at is null
      and exists (select 1 from public.rigtracker_profiles p where p.user_id = (select auth.uid()) and not p.password_required)
    )
  );

-- Serialize Office and Company Driver claims on the same employee number.
create function fleet_internal.check_office_employee_number()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  select coalesce(raw_app_meta_data ->> 'temporary_password' = 'true', false)
    into new.password_required from auth.users where id = new.user_id;
  new.password_required := coalesce(new.password_required, false);
  perform pg_advisory_xact_lock(hashtextextended(new.fleet_id || '/' || new.employee_id, 0));
  if exists (
    select 1 from public.rigtracker_fleet_links l
    where l.fleet_id = new.fleet_id and l.employee_number = new.employee_id and l.unlinked_at is null
  ) then
    raise exception 'That employee number is already in use.' using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger rigtracker_check_office_employee_number
  before insert on public.fleet_employees
  for each row execute function fleet_internal.check_office_employee_number();

create function fleet_internal.set_rigtracker_link(
  acting_admin uuid, target_fleet text, target_user uuid, requested_number text, removing boolean
)
returns void language plpgsql security definer set search_path = ''
as $$
declare
  profile public.rigtracker_profiles%rowtype;
  existing public.rigtracker_fleet_links%rowtype;
  driver_id uuid;
  driver_name text;
  number_value text;
  attempt integer;
begin
  perform 1 from public.fleets where id = target_fleet and admin_user_id = acting_admin;
  if not found then raise exception 'Only this Fleet Admin can manage links.' using errcode = '42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_fleet || '/link/' || target_user::text, 0));

  select * into existing from public.rigtracker_fleet_links
  where fleet_id = target_fleet and profile_user_id = target_user;
  if removing then
    if existing.unlinked_at is null and existing.profile_user_id is not null then
      if existing.dispatch_driver_id is not null then
        update public.fleet_dispatch_drivers set link_active = false
        where fleet_id = target_fleet and id = existing.dispatch_driver_id;
      end if;
      update public.rigtracker_fleet_links set unlinked_at = clock_timestamp()
      where fleet_id = target_fleet and profile_user_id = target_user;
    end if;
    return;
  end if;

  select * into profile from public.rigtracker_profiles where user_id = target_user;
  if not found then raise exception 'No profile with that RigTracker ID.' using errcode = '22023'; end if;
  if existing.profile_user_id is not null and existing.unlinked_at is null then return; end if;
  if requested_number is not null and (profile.profile_type <> 'company_driver' or requested_number !~ '^[0-9]{1,6}$') then
    raise exception 'Enter a 1–6 digit employee number for a Company Driver.' using errcode = '22023';
  end if;

  if profile.profile_type = 'company_driver' then
    for attempt in 1..12 loop
      number_value := coalesce(requested_number, (100000 + floor(random() * 900000))::int::text);
      perform pg_advisory_xact_lock(hashtextextended(target_fleet || '/' || number_value, 0));
      exit when not exists (
        select 1 from public.fleet_employees where fleet_id = target_fleet and employee_id = number_value
      ) and not exists (
        select 1 from public.rigtracker_fleet_links l where l.fleet_id = target_fleet
          and l.employee_number = number_value and l.unlinked_at is null
      );
      number_value := null;
      exit when requested_number is not null;
    end loop;
    if number_value is null then
      raise exception 'That employee number is already in use. Choose a different number.' using errcode = '23505';
    end if;
  end if;

  driver_id := existing.dispatch_driver_id;
  if profile.profile_type <> 'mechanic' then
    driver_name := left(coalesce(nullif(btrim(profile.first_name || ' ' || profile.last_name), ''),
      'Owner Operator ' || profile.profile_id), 100);
    if driver_id is null then
      insert into public.fleet_dispatch_drivers(fleet_id, name, driver_type)
      values (target_fleet, driver_name, case profile.profile_type when 'company_driver' then 'company' else null end)
      returning id into driver_id;
    else
      update public.fleet_dispatch_drivers set link_active = true, name = driver_name
      where fleet_id = target_fleet and id = driver_id;
    end if;
  end if;

  insert into public.rigtracker_fleet_links(fleet_id, profile_user_id, employee_number, dispatch_driver_id)
  values (target_fleet, target_user, number_value, driver_id)
  on conflict (fleet_id, profile_user_id) do update
    set employee_number = excluded.employee_number, unlinked_at = null;
end;
$$;

create function public.manage_rigtracker_link(
  acting_admin uuid, target_fleet text, target_profile_id text, requested_number text, removing boolean
)
returns void language sql security invoker set search_path = ''
as $$
  select fleet_internal.set_rigtracker_link(acting_admin, target_fleet,
    (select user_id from public.rigtracker_profiles where profile_id = target_profile_id), requested_number, removing);
$$;
revoke all on function public.manage_rigtracker_link(uuid, text, text, text, boolean) from public, anon, authenticated;
grant usage on schema fleet_internal to service_role;
grant execute on function public.manage_rigtracker_link(uuid, text, text, text, boolean) to service_role;

create function fleet_internal.create_rigtracker_profile()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  kind text := coalesce(new.raw_app_meta_data ->> 'account_type', new.raw_user_meta_data ->> 'account_type', 'driver');
  trusted_kind text := new.raw_app_meta_data ->> 'account_type';
  setup jsonb := new.raw_app_meta_data -> 'company_setup';
begin
  if kind = 'company_driver' and trusted_kind is distinct from 'company_driver' then
    raise exception 'A fleet must create a Company Driver profile.';
  end if;
  if kind not in ('driver', 'company_driver', 'mechanic') then return new; end if;
  loop
    insert into public.rigtracker_profiles(user_id, profile_type, first_name, last_name, phone, license_number, password_required)
    values (new.id, kind,
      coalesce(setup ->> 'first_name', left(btrim(new.raw_user_meta_data ->> 'first_name'), 100), ''),
      coalesce(setup ->> 'last_name', left(btrim(new.raw_user_meta_data ->> 'last_name'), 100), ''),
      coalesce(setup ->> 'phone', ''), coalesce(setup ->> 'license_number', ''), kind = 'company_driver')
    on conflict (profile_id) do nothing;
    exit when found;
  end loop;
  new.raw_app_meta_data := (coalesce(new.raw_app_meta_data, '{}'::jsonb) - 'company_setup')
    || jsonb_build_object('account_type', kind);
  if kind = 'company_driver' then
    perform fleet_internal.set_rigtracker_link((setup ->> 'admin_id')::uuid, setup ->> 'fleet_id',
      new.id, setup ->> 'employee_number', false);
  end if;
  return new;
end;
$$;

create trigger rigtracker_create_profile_on_auth
  before insert on auth.users
  for each row execute function fleet_internal.create_rigtracker_profile();

-- Existing Owner Op accounts retain their Auth user IDs and get a shareable number.
do $$
declare account record;
begin
  for account in
    select id, raw_user_meta_data from auth.users
    where coalesce(raw_app_meta_data ->> 'account_type', raw_user_meta_data ->> 'account_type', 'driver') = 'driver'
  loop
    loop
      insert into public.rigtracker_profiles(user_id, profile_type, first_name, last_name)
      values (account.id, 'driver',
        coalesce(left(btrim(account.raw_user_meta_data ->> 'first_name'), 100), ''),
        coalesce(left(btrim(account.raw_user_meta_data ->> 'last_name'), 100), ''))
      on conflict (profile_id) do nothing;
      exit when found;
    end loop;
  end loop;
end;
$$;

create function fleet_internal.finish_rigtracker_password_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if new.encrypted_password is not null and new.encrypted_password is distinct from old.encrypted_password then
    update public.rigtracker_profiles set password_required = false
    where user_id = new.id and password_required;
    update public.fleet_employees set password_required = false
    where user_id = new.id and password_required;
  end if;
  return new;
end;
$$;

create trigger rigtracker_complete_first_password
  after update of encrypted_password on auth.users
  for each row execute function fleet_internal.finish_rigtracker_password_change();

create function fleet_internal.prevent_unlinked_driver_assignment()
returns trigger language plpgsql security invoker set search_path = ''
as $$
declare check_driver_one boolean := false;
declare check_driver_two boolean := false;
begin
  if tg_op = 'INSERT' then
    check_driver_one := new.driver_id is not null;
    check_driver_two := new.second_driver_id is not null;
  else
    check_driver_one := new.driver_id is distinct from old.driver_id or (new.status = 'current' and old.status <> 'current');
    check_driver_two := new.second_driver_id is distinct from old.second_driver_id or (new.status = 'current' and old.status <> 'current');
  end if;
  perform 1 from public.fleet_dispatch_drivers d where d.fleet_id = new.fleet_id
    and ((check_driver_one and d.id = new.driver_id) or (check_driver_two and d.id = new.second_driver_id))
    order by d.id for share;
  if exists (
    select 1 from public.fleet_dispatch_drivers d where d.fleet_id = new.fleet_id and not d.link_active
      and ((check_driver_one and d.id = new.driver_id) or (check_driver_two and d.id = new.second_driver_id))
  ) then
    raise exception 'That driver is no longer linked to this fleet. Choose another driver.' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger rigtracker_dispatch_link_check
  before insert or update of driver_id, second_driver_id, status on public.fleet_dispatch_loads
  for each row execute function fleet_internal.prevent_unlinked_driver_assignment();

create function fleet_internal.sync_rigtracker_dispatch_name()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  update public.fleet_dispatch_drivers d
    set name = left(coalesce(nullif(btrim(new.first_name || ' ' || new.last_name), ''),
      'Owner Operator ' || new.profile_id), 100)
  from public.rigtracker_fleet_links l
  where l.profile_user_id = new.user_id and l.unlinked_at is null
    and d.id = l.dispatch_driver_id and d.fleet_id = l.fleet_id;
  return new;
end;
$$;

create trigger rigtracker_sync_dispatch_name
  after update of first_name, last_name on public.rigtracker_profiles
  for each row when (old.first_name is distinct from new.first_name or old.last_name is distinct from new.last_name)
  execute function fleet_internal.sync_rigtracker_dispatch_name();

revoke all on function fleet_internal.new_rigtracker_profile_id(),
  fleet_internal.sync_rigtracker_dispatch_name(),
  fleet_internal.check_office_employee_number(),
  fleet_internal.set_rigtracker_link(uuid, text, uuid, text, boolean),
  fleet_internal.create_rigtracker_profile(),
  fleet_internal.finish_rigtracker_password_change(),
  fleet_internal.prevent_unlinked_driver_assignment()
  from public, anon, authenticated;
grant execute on function fleet_internal.set_rigtracker_link(uuid, text, uuid, text, boolean) to service_role;
