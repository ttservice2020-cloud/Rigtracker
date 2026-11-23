alter table public.fleet_dispatch_locations add column wait_alert_hours numeric
  check (wait_alert_hours >= 0 and wait_alert_hours < 'Infinity'::numeric);
grant update (wait_alert_hours) on public.fleet_dispatch_locations to authenticated;

create function fleet_internal.review_dispatch_departure(
  target_load uuid, expected_updated_at timestamptz, editing_session uuid, target_stop text
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  load public.fleet_dispatch_loads%rowtype;
  reviewed_progress jsonb;
  pending_stop text;
  pending_count integer;
  remaining_count integer;
  stop_count integer;
  now_at timestamptz := clock_timestamp();
begin
  select * into load from public.fleet_dispatch_loads
  where id=target_load and actor is not null and fleet_internal.office_has_permission(fleet_id,'dispatch')
  for update;
  if not found then raise exception 'Load unavailable in this fleet.' using errcode='42501'; end if;
  if not exists(select 1 from fleet_internal.dispatch_load_leases lease
      where lease.load_id=target_load and lease.holder=actor and lease.session_id=editing_session
        and lease.expires_at>clock_timestamp()) then
    raise exception 'Open this load for editing before reviewing the departure.' using errcode='55P03';
  end if;
  if load.status<>'current' or load.updated_at is distinct from expected_updated_at then
    raise exception 'This load changed. Review the latest update before accepting it.' using errcode='40001';
  end if;

  select count(*), count(*) filter (where stop.completed is null),
    count(*) filter (where stop.pending),
    (array_agg(keys.stop_key order by keys.stop_order) filter (where stop.pending))[1]
  into stop_count, remaining_count, pending_count, pending_stop
  from fleet_internal.dispatch_stop_keys(load.details) keys
  cross join lateral (
    select load.progress #>> array['stops',keys.stop_key,'completedAt'] as completed,
      load.progress #>> array['stops',keys.stop_key,'completedAt'] is not null
      and load.progress #>> array['stops',keys.stop_key,'driverReport','at'] is not null
      and load.progress #>> array['stops',keys.stop_key,'boardReviewedAt'] is null as pending
  ) stop;

  if target_stop is distinct from pending_stop or stop_count=0
      or (pending_stop is null and remaining_count>0) then
    raise exception 'Choose the next departure waiting for review.' using errcode='22023';
  end if;
  reviewed_progress := load.progress;
  if pending_stop is not null then
    reviewed_progress := jsonb_set(reviewed_progress,array['stops',pending_stop,'boardReviewedAt'],to_jsonb(now_at));
  end if;

  if remaining_count=0 and pending_count<=1 then
    if load.progress #>> '{relay,droppedAt}' is not null
        and load.progress #>> '{relay,departedAt}' is null and load.progress->>'yardPickedUpAt' is null then
      raise exception 'Record the relay departure before completing this load.' using errcode='22023';
    end if;
    update public.fleet_dispatch_loads set status='completed', progress=reviewed_progress
    where id=target_load returning * into load;
  else
    update public.fleet_dispatch_loads set progress=reviewed_progress
    where id=target_load returning * into load;
  end if;
  return to_jsonb(load);
end;
$$;

create function public.review_dispatch_departure(
  target_load uuid, expected_updated_at timestamptz, editing_session uuid, target_stop text
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.review_dispatch_departure(target_load,expected_updated_at,editing_session,target_stop);
$$;

revoke all on function fleet_internal.review_dispatch_departure(uuid,timestamptz,uuid,text),
  public.review_dispatch_departure(uuid,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function fleet_internal.review_dispatch_departure(uuid,timestamptz,uuid,text),
  public.review_dispatch_departure(uuid,timestamptz,uuid,text) to authenticated;
