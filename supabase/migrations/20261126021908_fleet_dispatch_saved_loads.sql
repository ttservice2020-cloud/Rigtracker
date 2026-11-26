create table public.fleet_dispatch_saved_loads (
  id uuid primary key default gen_random_uuid(),
  fleet_id text not null,
  source_load_id uuid not null,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  details jsonb not null check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 65536),
  driver_id uuid,
  second_driver_id uuid,
  created_at timestamptz not null default now(),
  unique (fleet_id, source_load_id),
  foreign key (fleet_id, source_load_id) references public.fleet_dispatch_loads (fleet_id, id) on delete cascade,
  foreign key (fleet_id, driver_id) references public.fleet_dispatch_drivers (fleet_id, id) on delete set null (driver_id),
  foreign key (fleet_id, second_driver_id) references public.fleet_dispatch_drivers (fleet_id, id) on delete set null (second_driver_id)
);

create index fleet_dispatch_saved_loads_list_idx on public.fleet_dispatch_saved_loads (fleet_id, name, id);

alter table public.fleet_dispatch_saved_loads enable row level security;
revoke all on public.fleet_dispatch_saved_loads from public, anon, authenticated;
grant select, delete on public.fleet_dispatch_saved_loads to authenticated;
grant insert (fleet_id, source_load_id, name, details, driver_id, second_driver_id)
  on public.fleet_dispatch_saved_loads to authenticated;

create policy fleet_dispatch_saved_loads_access on public.fleet_dispatch_saved_loads
  for all to authenticated
  using (fleet_internal.office_has_permission(fleet_id, 'dispatch'))
  with check (fleet_internal.office_has_permission(fleet_id, 'dispatch'));
