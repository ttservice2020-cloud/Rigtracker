alter table fleet_internal.fleet_employee_shifts
  add column payroll_date date check (isfinite(payroll_date));

create index fleet_employee_shifts_payroll_period on fleet_internal.fleet_employee_shifts
  (fleet_id, employee_user_id, (coalesce(payroll_date,(started_at at time zone 'UTC')::date)));

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
  requested_shift uuid;
  requested_date date;
  expected_date date;
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

  if action is null or action not in ('payroll_roster','hourly_roster','set_payroll_date') then
    raise exception 'Unsupported office time-clock action.' using errcode='22023';
  end if;
  if selected_fleet is null then
    select coalesce(
      (select f.id from public.fleets f where f.admin_user_id=actor limit 1),
      (select e.fleet_id from public.fleet_employees e where e.user_id=actor and not e.password_required limit 1)
    ) into selected_fleet;
  end if;
  if selected_fleet is null
    or not fleet_internal.office_has_permission(selected_fleet,case when action='hourly_roster' then 'hourly' else 'payroll' end) then
    raise exception 'Payroll or hourly time access is required.' using errcode='42501';
  end if;
  if action='set_payroll_date' then
    if not coalesce(pg_input_is_valid(params ->> 'shift_id','uuid'),false)
      or coalesce(params ->> 'payroll_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or coalesce(params ->> 'expected_payroll_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or not pg_input_is_valid(params ->> 'payroll_date','date')
      or not pg_input_is_valid(params ->> 'expected_payroll_date','date') then
      raise exception 'Choose a valid payroll date.' using errcode='22023';
    end if;
    requested_shift := (params ->> 'shift_id')::uuid;
    requested_date := (params ->> 'payroll_date')::date;
    expected_date := (params ->> 'expected_payroll_date')::date;
    update fleet_internal.fleet_employee_shifts s
      set payroll_date=nullif(requested_date,(s.started_at at time zone 'UTC')::date)
      where s.id=requested_shift and s.fleet_id=selected_fleet
        and coalesce(s.payroll_date,(s.started_at at time zone 'UTC')::date)=expected_date;
    if not found then
      raise exception 'The shift date changed or this shift is unavailable. Refresh payroll and try again.' using errcode='40001';
    end if;
    return jsonb_build_object('id',requested_shift,'payroll_date',requested_date);
  end if;

  if to_date < from_date or to_date - from_date > 366 then
    raise exception 'Choose a valid date range of one year or less.' using errcode='22023';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',e.user_id,'employee_id',e.employee_id,
    'name',coalesce(nullif(btrim(concat_ws(' ',e.first_name,e.last_name)),''),'Office employee'),
    'office_role',e.office_role,'seconds',coalesce(period.seconds,0),'shifts',coalesce(period.shifts,'[]'::jsonb)
  ) order by e.last_name,e.first_name),'[]'::jsonb)
  into clock_result
  from public.fleet_employees e
  cross join lateral (
    select sum(s.seconds)::bigint as seconds,
      jsonb_agg(to_jsonb(s) order by case when action='payroll_roster' then s.payroll_date end desc,s.started_at desc,s.id) as shifts
    from (
      select s.id,s.started_at,s.ended_at,coalesce(s.payroll_date,(s.started_at at time zone 'UTC')::date) as payroll_date,
        extract(epoch from coalesce(s.ended_at,statement_timestamp())-s.started_at)::bigint as seconds
      from fleet_internal.fleet_employee_shifts s
      where s.fleet_id=e.fleet_id and s.employee_user_id=e.user_id
        and (case when action='payroll_roster'
          then coalesce(s.payroll_date,(s.started_at at time zone 'UTC')::date) between from_date and to_date
          else s.started_at >= from_date::timestamptz and s.started_at < (to_date+1)::timestamptz end)
    ) s
  ) period
  where e.fleet_id=selected_fleet and (period.shifts is not null
    or (not e.password_required and (e.office_is_official or 'hourly'=any(e.office_permissions))));

  return jsonb_build_object('fleet_id',selected_fleet,'from',from_date,'to',to_date,'employees',clock_result);
end;
$function$;
