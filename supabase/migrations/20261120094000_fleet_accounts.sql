create table public.fleets (
  id text primary key check (id ~ '^[a-z0-9]{1,20}$'),
  admin_user_id uuid not null unique references auth.users(id) on delete cascade
);

create table public.fleet_employees (
  user_id uuid primary key references auth.users(id) on delete cascade,
  fleet_id text not null references public.fleets(id) on delete cascade,
  employee_id text not null check (employee_id ~ '^[0-9]{1,6}$'),
  created_at timestamptz not null default now(),
  unique (fleet_id, employee_id)
);

alter table public.fleets enable row level security;
alter table public.fleet_employees enable row level security;

revoke all on public.fleets, public.fleet_employees from public, anon, authenticated;
grant select on public.fleets, public.fleet_employees to authenticated;
grant select on public.fleets, public.fleet_employees to service_role;

create policy fleet_admin_read on public.fleets for select to authenticated
  using (admin_user_id = (select auth.uid()));

create policy fleet_employee_read on public.fleet_employees for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.fleets f
      where f.id = fleet_id and f.admin_user_id = (select auth.uid())
    )
  );

create function public.register_fleet(requested_id text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  owner_id uuid := auth.uid();
  fleet_id text := lower(trim(requested_id));
  registered_id text;
begin
  if owner_id is null or not exists (
    select 1 from auth.users u
    where u.id = owner_id
      and u.email_confirmed_at is not null
      and coalesce(u.raw_app_meta_data ->> 'account_type', u.raw_user_meta_data ->> 'account_type') = 'fleet'
      and not exists (select 1 from public.fleet_employees e where e.user_id = u.id)
  ) then
    raise exception 'A confirmed Fleet Admin account is required.' using errcode = '42501';
  end if;

  if fleet_id is null or fleet_id !~ '^[a-z0-9]{1,20}$' then
    raise exception 'Use 1–20 letters or numbers for the Fleet ID.' using errcode = '22023';
  end if;

  select f.id into registered_id from public.fleets f where f.admin_user_id = owner_id;
  if found then
    return registered_id;
  end if;

  begin
    insert into public.fleets (id, admin_user_id) values (fleet_id, owner_id)
      on conflict (admin_user_id) do nothing;
  exception when unique_violation then
    select f.id into registered_id from public.fleets f where f.admin_user_id = owner_id;
    if found then
      return registered_id;
    end if;
    raise exception 'That Fleet ID is already in use.' using errcode = '23505';
  end;

  select f.id into registered_id from public.fleets f where f.admin_user_id = owner_id;
  return registered_id;
end;
$$;

revoke all on function public.register_fleet(text) from public, anon, authenticated;
grant execute on function public.register_fleet(text) to authenticated;

create schema if not exists fleet_internal;
revoke all on schema fleet_internal from public, anon, authenticated;

-- Create membership in the same transaction as the Auth account. Only a
-- trusted Admin API caller can set the Auth app metadata used here.
create function fleet_internal.add_employee_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  employee_fleet_id text := new.raw_app_meta_data ->> 'fleet_id';
  employee_number text := new.raw_app_meta_data ->> 'employee_id';
begin
  if new.raw_app_meta_data ->> 'account_type' = 'fleet_employee' then
    if employee_fleet_id is null or employee_fleet_id !~ '^[a-z0-9]{1,20}$'
      or employee_number is null or employee_number !~ '^[0-9]{1,6}$'
      or new.email is distinct from lower(employee_fleet_id || '-' || employee_number) || '@fleet-login.rigtrackerpro.com' then
      raise exception 'Invalid fleet employee account.';
    end if;
    insert into public.fleet_employees (user_id, fleet_id, employee_id)
      values (new.id, employee_fleet_id, employee_number);
  elsif lower(coalesce(new.email, '')) like '%@fleet-login.rigtrackerpro.com' then
    raise exception 'Fleet employee accounts must be created by the Fleet Admin.';
  end if;
  return new;
end;
$$;

create function fleet_internal.keep_employee_alias()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.email is distinct from old.email and (
    lower(coalesce(old.email, '')) like '%@fleet-login.rigtrackerpro.com'
    or lower(coalesce(new.email, '')) like '%@fleet-login.rigtrackerpro.com'
  ) then
    raise exception 'Fleet employee sign-in names cannot be changed through email settings.';
  end if;
  return new;
end;
$$;

revoke all on function fleet_internal.add_employee_membership() from public, anon, authenticated;
revoke all on function fleet_internal.keep_employee_alias() from public, anon, authenticated;

create trigger rigtracker_add_fleet_employee
  after insert on auth.users
  for each row execute function fleet_internal.add_employee_membership();

create trigger rigtracker_keep_fleet_employee_alias
  before update of email on auth.users
  for each row execute function fleet_internal.keep_employee_alias();
