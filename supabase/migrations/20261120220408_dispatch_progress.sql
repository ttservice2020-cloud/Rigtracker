alter table public.fleet_dispatch_loads
  add column progress jsonb not null default '{"stops":{}}'
  check (jsonb_typeof(progress) = 'object' and jsonb_typeof(progress -> 'stops') = 'object');

create function fleet_internal.dispatch_stop_keys(load_details jsonb)
returns table(stop_key text, stop_kind text, stop_order bigint)
language sql immutable security invoker set search_path = ''
as $$
  select coalesce(nullif(stop ->> 'stopId', ''), 'pickup-' || (position - 1)), 'pickup'::text, position
  from jsonb_array_elements(coalesce(load_details -> 'pickups', '[]')) with ordinality as pickups(stop, position)
  union all
  select coalesce(nullif(stop ->> 'stopId', ''), 'receiver-' || (position - 1)), 'receiver'::text, position + 100
  from jsonb_array_elements(coalesce(load_details -> 'receivers', '[]')) with ordinality as receivers(stop, position);
$$;

create function fleet_internal.keep_recorded_dispatch_stops()
returns trigger
language plpgsql security invoker set search_path = ''
as $$
begin
  if old.progress -> 'stops' <> '{}'::jsonb and exists (
    select 1 from jsonb_object_keys(old.progress -> 'stops') as recorded(stop_key)
    where not exists (
      select 1 from fleet_internal.dispatch_stop_keys(new.details) as candidate
      where candidate.stop_key = recorded.stop_key
    )
  ) then
    raise exception 'A stop with recorded progress cannot be removed.' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger fleet_dispatch_keep_recorded_stops
  before update of details on public.fleet_dispatch_loads
  for each row execute function fleet_internal.keep_recorded_dispatch_stops();

create function fleet_internal.record_dispatch_progress(
  requested_load_id uuid, expected_updated_at timestamptz, requested_action text,
  requested_stop_key text, requested_arrival_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  load_row public.fleet_dispatch_loads%rowtype;
  next_key text;
  recorded jsonb;
  current_progress jsonb;
  occurred_at timestamptz := clock_timestamp();
  next_status text := 'current';
begin
  select loads.* into load_row
  from public.fleet_dispatch_loads loads
  join public.fleets fleets on fleets.id = loads.fleet_id
  where loads.id = requested_load_id and fleets.admin_user_id = (select auth.uid())
  for update of loads;
  if not found then raise exception 'Load unavailable to this account.' using errcode = '42501'; end if;
  if load_row.status <> 'current' or load_row.updated_at is distinct from expected_updated_at then
    raise exception 'This load changed. Refresh it before recording progress.' using errcode = '40001';
  end if;
  current_progress := load_row.progress;
  select stop_key into next_key
    from fleet_internal.dispatch_stop_keys(load_row.details)
    where current_progress #>> array['stops',stop_key,'completedAt'] is null
    order by stop_order limit 1;
  case requested_action
    when 'en_route' then
      if current_progress ? 'enRouteAt' or current_progress -> 'stops' <> '{}'::jsonb or next_key is null then
        raise exception 'The load has already started.' using errcode = '22023';
      end if;
      current_progress := current_progress || jsonb_build_object('enRouteAt', occurred_at);
    when 'arrive', 'depart' then
      if requested_stop_key is null or not exists (
        select 1 from fleet_internal.dispatch_stop_keys(load_row.details) where stop_key = requested_stop_key
      ) then
        raise exception 'Select a valid stop.' using errcode = '22023';
      end if;
      recorded := coalesce(current_progress #> array['stops', requested_stop_key], '{}'::jsonb);
      if requested_action = 'arrive' then
        if requested_stop_key is distinct from next_key and not (recorded ? 'arrivalAt') then
          raise exception 'Record the next scheduled stop first.' using errcode = '22023';
        end if;
        requested_arrival_at := coalesce(requested_arrival_at, occurred_at);
        if not isfinite(requested_arrival_at) or requested_arrival_at > occurred_at
          or requested_arrival_at > (recorded ->> 'completedAt')::timestamptz then
          raise exception 'Arrival must be at or before the current time and any recorded departure.' using errcode = '22023';
        end if;
        if recorded ? 'arrivalAt' and (recorded ->> 'arrivalAt')::timestamptz <> requested_arrival_at then
          recorded := recorded || jsonb_build_object('previousArrivalAt', recorded -> 'arrivalAt');
        end if;
        recorded := recorded || jsonb_build_object('arrivalAt', requested_arrival_at);
      else
        if requested_stop_key is distinct from next_key or not (recorded ? 'arrivalAt') or recorded ? 'completedAt' then
          raise exception 'Record an arrival for the next scheduled stop before completing it.' using errcode = '22023';
        end if;
        recorded := recorded || jsonb_build_object('completedAt', occurred_at);
      end if;
      current_progress := jsonb_set(current_progress, array['stops', requested_stop_key], recorded);
    when 'complete' then
      current_progress := current_progress || jsonb_build_object('completedAt', occurred_at);
      next_status := 'completed';
    else
      raise exception 'Unsupported progress action.' using errcode = '22023';
  end case;

  update public.fleet_dispatch_loads
  set progress = current_progress, status = next_status
  where id = load_row.id returning * into load_row;
  return to_jsonb(load_row);
end;
$$;

create function public.record_dispatch_progress(
  requested_load_id uuid, expected_updated_at timestamptz, requested_action text,
  requested_stop_key text, requested_arrival_at timestamptz
)
returns jsonb
language sql security invoker set search_path = ''
as $$
  select fleet_internal.record_dispatch_progress(
    requested_load_id, expected_updated_at, requested_action, requested_stop_key, requested_arrival_at
  );
$$;

revoke all on function fleet_internal.dispatch_stop_keys(jsonb) from public, anon, authenticated;
revoke all on function fleet_internal.keep_recorded_dispatch_stops() from public, anon, authenticated;
revoke all on function fleet_internal.record_dispatch_progress(uuid,timestamptz,text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.record_dispatch_progress(uuid,timestamptz,text,text,timestamptz) from public, anon, authenticated;
grant execute on function fleet_internal.dispatch_stop_keys(jsonb) to authenticated;
grant execute on function fleet_internal.record_dispatch_progress(uuid,timestamptz,text,text,timestamptz) to authenticated;
grant execute on function public.record_dispatch_progress(uuid,timestamptz,text,text,timestamptz) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables)
    and not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fleet_dispatch_loads'
    ) then
    alter publication supabase_realtime add table public.fleet_dispatch_loads;
  end if;
end;
$$;
