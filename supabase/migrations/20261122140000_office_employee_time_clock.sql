create table if not exists fleet_internal.fleet_employee_shifts (
  id uuid primary key default gen_random_uuid(),
  fleet_id text not null references public.fleets(id) on delete cascade,
  employee_user_id uuid not null references public.fleet_employees(user_id) on delete cascade,
  started_at timestamptz not null default clock_timestamp(),
  ended_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (ended_at is null or ended_at > started_at)
);
create unique index if not exists fleet_employee_one_open_shift
  on fleet_internal.fleet_employee_shifts(fleet_id, employee_user_id) where ended_at is null;
create index if not exists fleet_employee_shifts_period
  on fleet_internal.fleet_employee_shifts(fleet_id, employee_user_id, started_at desc);
alter table fleet_internal.fleet_employee_shifts enable row level security;
revoke all on fleet_internal.fleet_employee_shifts from public, anon, authenticated;

create or replace function fleet_internal.fleet_employee_time_clock(
  action text, target_fleet text default null, params jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  selected_fleet text := target_fleet;
  started timestamptz;
  ended timestamptz;
  clock_result jsonb;
  from_date date := coalesce(nullif(params ->> 'from','')::date, current_date - 30);
  to_date date := coalesce(nullif(params ->> 'to','')::date, current_date);
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;

  if action in ('clock_status','clock_in','clock_out') then
    select e.fleet_id into selected_fleet
    from public.fleet_employees e
    where e.user_id=actor and not e.password_required
      and (selected_fleet is null or e.fleet_id=selected_fleet)
      and fleet_internal.office_has_permission(e.fleet_id,'hourly')
    limit 1;
    if selected_fleet is null then raise exception 'Hourly time clock access is required.' using errcode='42501'; end if;

    if action='clock_status' then
      select s.started_at into started from fleet_internal.fleet_employee_shifts s
      where s.fleet_id=selected_fleet and s.employee_user_id=actor and s.ended_at is null limit 1;
      return jsonb_build_object('fleet_id',selected_fleet,'clocked_in',started is not null,'started_at',started);
    elsif action='clock_in' then
      insert into fleet_internal.fleet_employee_shifts(fleet_id,employee_user_id)
      values(selected_fleet,actor) on conflict (fleet_id,employee_user_id) where ended_at is null do nothing
      returning started_at into started;
      if started is null then raise exception 'You are already clocked in.' using errcode='22023'; end if;
      return jsonb_build_object('fleet_id',selected_fleet,'clocked_in',true,'started_at',started);
    else
      update fleet_internal.fleet_employee_shifts
        set ended_at=clock_timestamp()
      where fleet_id=selected_fleet and employee_user_id=actor and ended_at is null
      returning started_at,ended_at into started,ended;
      if started is null then raise exception 'You are not clocked in.' using errcode='22023'; end if;
      return jsonb_build_object('fleet_id',selected_fleet,'clocked_in',false,'started_at',started,'ended_at',ended);
    end if;
  end if;

  if action not in ('payroll_roster','hourly_roster') then
    raise exception 'Unsupported office time-clock action.' using errcode='22023';
  end if;
  if selected_fleet is null then
    select coalesce(
      (select f.id from public.fleets f where f.admin_user_id=actor limit 1),
      (select e.fleet_id from public.fleet_employees e where e.user_id=actor and not e.password_required limit 1)
    ) into selected_fleet;
  end if;
  if selected_fleet is null
    or not fleet_internal.office_has_permission(selected_fleet,case when action='payroll_roster' then 'payroll' else 'hourly' end) then
    raise exception 'Payroll or hourly time access is required.' using errcode='42501';
  end if;
  if to_date < from_date or to_date - from_date > 366 then
    raise exception 'Choose a valid date range of one year or less.' using errcode='22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',e.user_id,'employee_id',e.employee_id,
    'name',coalesce(nullif(btrim(concat_ws(' ',e.first_name,e.last_name)),''),'Office employee'),
    'office_role',e.office_role,
    'seconds',coalesce((select sum(extract(epoch from coalesce(s.ended_at,clock_timestamp())-s.started_at))::bigint
      from fleet_internal.fleet_employee_shifts s
      where s.fleet_id=e.fleet_id and s.employee_user_id=e.user_id
        and s.started_at >= from_date::timestamptz and s.started_at < (to_date+1)::timestamptz),0),
    'shifts',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'started_at',s.started_at,'ended_at',s.ended_at,
      'seconds',extract(epoch from coalesce(s.ended_at,clock_timestamp())-s.started_at)::bigint
    ) order by s.started_at desc)
      from fleet_internal.fleet_employee_shifts s
      where s.fleet_id=e.fleet_id and s.employee_user_id=e.user_id
        and s.started_at >= from_date::timestamptz and s.started_at < (to_date+1)::timestamptz
      limit 100),'[]'::jsonb)
  ) order by e.last_name,e.first_name),'[]'::jsonb)
  into clock_result
  from public.fleet_employees e
  where e.fleet_id=selected_fleet and not e.password_required
    and e.office_permissions @> array['hourly']::text[];

  return jsonb_build_object('fleet_id',selected_fleet,'from',from_date,'to',to_date,'employees',clock_result);
end;
$function$;

create or replace function public.fleet_employee_time_clock(
  action text, target_fleet text default null, params jsonb default '{}'::jsonb
)
returns jsonb
language sql
security invoker
set search_path = ''
as $function$
  select fleet_internal.fleet_employee_time_clock(action,target_fleet,params);
$function$;

revoke all on function fleet_internal.fleet_employee_time_clock(text,text,jsonb) from public, anon;
grant execute on function fleet_internal.fleet_employee_time_clock(text,text,jsonb) to authenticated;
revoke all on function public.fleet_employee_time_clock(text,text,jsonb) from public, anon;
grant execute on function public.fleet_employee_time_clock(text,text,jsonb) to authenticated;
