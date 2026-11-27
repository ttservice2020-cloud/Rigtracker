alter table public.fleet_dispatch_locations
  add column gate_code text check (char_length(gate_code) between 1 and 80);

grant update (gate_code) on public.fleet_dispatch_locations to authenticated;
grant delete on public.fleet_dispatch_locations to authenticated;

create policy fleet_dispatch_locations_remove on public.fleet_dispatch_locations
  for delete to authenticated
  using (fleet_internal.office_has_permission(fleet_id, 'dispatch'));
