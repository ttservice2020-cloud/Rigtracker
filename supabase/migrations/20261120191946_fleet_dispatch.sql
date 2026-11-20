create table fleet_internal.dispatch_pro_reservations (
  fleet_id text not null references public.fleets(id) on delete cascade,
  load_id uuid not null,
  pro_number bigint not null check (pro_number > 0),
  primary key (fleet_id, load_id, pro_number),
  unique (fleet_id, load_id),
  unique (fleet_id, pro_number)
);

revoke all on fleet_internal.dispatch_pro_reservations from public, anon, authenticated;

create function fleet_internal.reserve_dispatch_pro(requested_fleet_id text, requested_load_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_pro bigint;
begin
  if requested_load_id is null then
    raise exception 'A load reference is required.' using errcode = '22023';
  end if;

  -- The fleet row serializes allocation for this fleet, including retries.
  perform 1 from public.fleets
  where id = requested_fleet_id and admin_user_id = (select auth.uid())
  for update;
  if not found then
    raise exception 'Only this Fleet Admin can reserve a PRO number.' using errcode = '42501';
  end if;

  select pro_number into next_pro
  from fleet_internal.dispatch_pro_reservations
  where fleet_id = requested_fleet_id and load_id = requested_load_id;
  if found then
    return next_pro;
  end if;

  select coalesce(max(pro_number), 10000) + 1 into next_pro
  from fleet_internal.dispatch_pro_reservations
  where fleet_id = requested_fleet_id;

  insert into fleet_internal.dispatch_pro_reservations (fleet_id, load_id, pro_number)
  values (requested_fleet_id, requested_load_id, next_pro);
  return next_pro;
end;
$$;

create function public.reserve_dispatch_pro(requested_fleet_id text, requested_load_id uuid)
returns bigint
language sql
security invoker
set search_path = ''
as $$
  select fleet_internal.reserve_dispatch_pro(requested_fleet_id, requested_load_id);
$$;

revoke all on function fleet_internal.reserve_dispatch_pro(text, uuid) from public, anon, authenticated;
revoke all on function public.reserve_dispatch_pro(text, uuid) from public, anon, authenticated;
grant execute on function fleet_internal.reserve_dispatch_pro(text, uuid) to authenticated;
grant execute on function public.reserve_dispatch_pro(text, uuid) to authenticated;

create table public.fleet_dispatch_drivers (
  id uuid primary key default gen_random_uuid(),
  fleet_id text not null references public.fleets(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 100),
  equipment text not null default '' check (char_length(equipment) <= 100),
  availability text not null default 'available' check (availability in ('available','off-duty')),
  created_at timestamptz not null default now(),
  unique (fleet_id, id)
);

create table public.fleet_dispatch_loads (
  id uuid primary key,
  fleet_id text not null references public.fleets(id) on delete cascade,
  pro_number bigint not null,
  contract_load_id uuid,
  status text not null check (status in ('draft','current','completed','contract')),
  driver_id uuid,
  second_driver_id uuid,
  details jsonb not null check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 65536),
  created_at timestamptz not null default now(),
  assigned_at timestamptz,
  updated_at timestamptz not null default now(),
  check (second_driver_id is null or (driver_id is not null and second_driver_id <> driver_id)),
  check (status in ('draft','contract') or (
    driver_id is not null and
    (nullif(trim(details #>> '{pickups,0,company}'), '') is not null) and
    (nullif(trim(details #>> '{receivers,0,company}'), '') is not null)
  )),
  check (contract_load_id is null or (contract_load_id <> id and status <> 'contract')),
  unique (fleet_id, pro_number),
  unique (fleet_id, id),
  foreign key (fleet_id, contract_load_id) references public.fleet_dispatch_loads (fleet_id, id),
  foreign key (fleet_id, id, pro_number)
    references fleet_internal.dispatch_pro_reservations (fleet_id, load_id, pro_number),
  foreign key (fleet_id, driver_id) references public.fleet_dispatch_drivers (fleet_id, id),
  foreign key (fleet_id, second_driver_id) references public.fleet_dispatch_drivers (fleet_id, id)
);

create index fleet_dispatch_loads_recent_idx
  on public.fleet_dispatch_loads (fleet_id, updated_at desc, id);
create index fleet_dispatch_loads_contract_idx
  on public.fleet_dispatch_loads (fleet_id, contract_load_id) where contract_load_id is not null;
create index fleet_dispatch_loads_driver_idx
  on public.fleet_dispatch_loads (fleet_id, driver_id) where driver_id is not null;
create index fleet_dispatch_loads_second_driver_idx
  on public.fleet_dispatch_loads (fleet_id, second_driver_id) where second_driver_id is not null;

alter table public.fleet_dispatch_drivers enable row level security;
alter table public.fleet_dispatch_loads enable row level security;

revoke all on public.fleet_dispatch_drivers, public.fleet_dispatch_loads from public, anon, authenticated;
grant select on public.fleet_dispatch_drivers, public.fleet_dispatch_loads to authenticated;
grant insert (id, fleet_id, name, equipment, availability) on public.fleet_dispatch_drivers to authenticated;
grant update (availability) on public.fleet_dispatch_drivers to authenticated;
grant insert (id, fleet_id, pro_number, status, driver_id, second_driver_id, details, contract_load_id)
  on public.fleet_dispatch_loads to authenticated;
grant update (status, driver_id, second_driver_id, details, contract_load_id) on public.fleet_dispatch_loads to authenticated;

create policy fleet_dispatch_driver_owner on public.fleet_dispatch_drivers
  for all to authenticated
  using (fleet_id in (select id from public.fleets where admin_user_id = (select auth.uid())))
  with check (fleet_id in (select id from public.fleets where admin_user_id = (select auth.uid())));

create policy fleet_dispatch_load_owner on public.fleet_dispatch_loads
  for all to authenticated
  using (fleet_id in (select id from public.fleets where admin_user_id = (select auth.uid())))
  with check (fleet_id in (select id from public.fleets where admin_user_id = (select auth.uid())));

create function fleet_internal.stamp_dispatch_load_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  if new.status = 'current' then
    if tg_op = 'INSERT' then
      new.assigned_at := new.updated_at;
    elsif old.status is distinct from 'current' then
      new.assigned_at := new.updated_at;
    end if;
  end if;
  return new;
end;
$$;

revoke all on function fleet_internal.stamp_dispatch_load_update() from public, anon, authenticated;

create trigger fleet_dispatch_stamp_load_update
  before insert or update on public.fleet_dispatch_loads
  for each row execute function fleet_internal.stamp_dispatch_load_update();
