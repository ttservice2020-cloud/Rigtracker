create table fleet_internal.fleet_employee_payroll_days (
  fleet_id text not null references public.fleets(id) on delete cascade,
  employee_user_id uuid not null references public.fleet_employees(user_id) on delete cascade,
  payroll_date date not null check (isfinite(payroll_date)),
  worked_seconds bigint not null check (worked_seconds >= 0),
  hourly_rate numeric(9,2) check (hourly_rate >= 0),
  gross_pay numeric generated always as (round(worked_seconds::numeric * hourly_rate / 3600, 2)) stored,
  saved_by uuid not null references auth.users(id),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (fleet_id, employee_user_id, payroll_date)
);

alter table fleet_internal.fleet_employee_payroll_days enable row level security;
revoke all on fleet_internal.fleet_employee_payroll_days from public, anon, authenticated;

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
  requested_employee uuid;
  requested_start timestamptz;
  requested_end timestamptz;
  existing fleet_internal.fleet_employee_shifts%rowtype;
  saved_day fleet_internal.fleet_employee_payroll_days%rowtype;
  rate_text text;
  requested_rate numeric;
  day_seconds bigint;
  day_shifts integer;
  has_open_shift boolean;
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

    if action<>'clock_status' then
      perform pg_advisory_xact_lock(hashtextextended('rigtracker:office-time:'||selected_fleet||':'||actor::text,0));
    end if;
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

  if action is null or action not in ('payroll_roster','hourly_roster','set_payroll_date','save_payroll_shift','save_payroll_day') then
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
  if action='save_payroll_day' then
    rate_text := nullif(btrim(params->>'hourly_rate'),'');
    if not coalesce(pg_input_is_valid(params->>'employee_user_id','uuid'),false)
      or coalesce(params->>'payroll_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or not pg_input_is_valid(params->>'payroll_date','date')
      or not coalesce(pg_input_is_valid(params->>'expected_seconds','bigint'),false)
      or (rate_text is not null and rate_text !~ '^[0-9]{1,7}(\.[0-9]{1,2})?$')
      or (params->>'expected_updated_at' is not null
        and not pg_input_is_valid(params->>'expected_updated_at','timestamp with time zone')) then
      raise exception 'Choose a valid payroll date and an hourly rate in dollars and cents.' using errcode='22023';
    end if;
    requested_employee := (params->>'employee_user_id')::uuid;
    requested_date := (params->>'payroll_date')::date;
    requested_rate := rate_text::numeric;
    perform pg_advisory_xact_lock(hashtextextended('rigtracker:office-time:'||selected_fleet||':'||requested_employee::text,0));
    if not exists(select 1 from public.fleet_employees where fleet_id=selected_fleet and user_id=requested_employee) then
      raise exception 'Choose an employee in this fleet.' using errcode='42501';
    end if;
    select count(*),coalesce(sum(extract(epoch from s.ended_at-s.started_at)::bigint),0),coalesce(bool_or(s.ended_at is null),false)
    into day_shifts,day_seconds,has_open_shift
    from fleet_internal.fleet_employee_shifts s
    where s.fleet_id=selected_fleet and s.employee_user_id=requested_employee
      and coalesce(s.payroll_date,(s.started_at at time zone 'UTC')::date)=requested_date;
    if has_open_shift then
      raise exception 'Clock out or enter the missing clock-out time before saving this day.' using errcode='22023';
    end if;
    if day_seconds is distinct from (params->>'expected_seconds')::bigint then
      raise exception 'The hours for this day changed. Refresh Payroll before saving.' using errcode='40001';
    end if;
    select day.* into saved_day from fleet_internal.fleet_employee_payroll_days day
    where day.fleet_id=selected_fleet and day.employee_user_id=requested_employee and day.payroll_date=requested_date;
    if saved_day.updated_at is not null and saved_day.worked_seconds=day_seconds
      and saved_day.hourly_rate is not distinct from requested_rate then
      return to_jsonb(saved_day)-'saved_by'-'fleet_id'-'employee_user_id';
    end if;
    if saved_day.updated_at is distinct from (params->>'expected_updated_at')::timestamptz then
      raise exception 'This payroll day changed. Refresh Payroll before saving.' using errcode='40001';
    end if;
    if day_shifts=0 and saved_day.updated_at is null then
      raise exception 'Add the employee’s shifts before saving this day.' using errcode='22023';
    end if;
    insert into fleet_internal.fleet_employee_payroll_days (fleet_id,employee_user_id,payroll_date,worked_seconds,hourly_rate,saved_by)
    values(selected_fleet,requested_employee,requested_date,day_seconds,requested_rate,actor)
    on conflict (fleet_id,employee_user_id,payroll_date) do update
      set worked_seconds=excluded.worked_seconds,hourly_rate=excluded.hourly_rate,
        saved_by=excluded.saved_by,updated_at=clock_timestamp()
    returning * into saved_day;
    return to_jsonb(saved_day)-'saved_by'-'fleet_id'-'employee_user_id';
  end if;

  if action='save_payroll_shift' then
    if not coalesce(pg_input_is_valid(params->>'shift_id','uuid'),false)
      or not coalesce(pg_input_is_valid(params->>'employee_user_id','uuid'),false)
      or coalesce(params->>'payroll_date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or not pg_input_is_valid(params->>'payroll_date','date')
      or not coalesce(pg_input_is_valid(params->>'started_at','timestamp with time zone'),false)
      or (params->>'ended_at' is not null and not pg_input_is_valid(params->>'ended_at','timestamp with time zone'))
      or (params->>'expected_started_at' is not null and (
        not pg_input_is_valid(params->>'expected_started_at','timestamp with time zone')
        or not coalesce(pg_input_is_valid(params->>'expected_payroll_date','date'),false)))
      or (params->>'expected_ended_at' is not null and not pg_input_is_valid(params->>'expected_ended_at','timestamp with time zone')) then
      raise exception 'Enter a payroll date and valid clock-in and clock-out times.' using errcode='22023';
    end if;
    requested_shift := (params->>'shift_id')::uuid;
    requested_employee := (params->>'employee_user_id')::uuid;
    requested_date := (params->>'payroll_date')::date;
    requested_start := (params->>'started_at')::timestamptz;
    requested_end := (params->>'ended_at')::timestamptz;
    if not isfinite(requested_start) or requested_start>clock_timestamp()
      or (requested_end is not null and (not isfinite(requested_end)
        or requested_end<=requested_start or requested_end>clock_timestamp())) then
      raise exception 'Clock-out must follow clock-in, and times must be in the past.' using errcode='22023';
    end if;

    perform pg_advisory_xact_lock(hashtextextended('rigtracker:office-time:'||selected_fleet||':'||requested_employee::text,0));
    if not exists(select 1 from public.fleet_employees e where e.fleet_id=selected_fleet and e.user_id=requested_employee) then
      raise exception 'Choose an employee in this fleet.' using errcode='42501';
    end if;
    select s.* into existing from fleet_internal.fleet_employee_shifts s
    where s.fleet_id=selected_fleet and s.employee_user_id=requested_employee and s.id=requested_shift
    for update;

    if existing.id is not null and existing.started_at=requested_start
      and existing.ended_at is not distinct from requested_end
      and coalesce(existing.payroll_date,(existing.started_at at time zone 'UTC')::date)=requested_date then
      return jsonb_build_object('id',requested_shift,'payroll_date',requested_date);
    end if;
    if existing.started_at is distinct from (params->>'expected_started_at')::timestamptz
      or existing.ended_at is distinct from (params->>'expected_ended_at')::timestamptz
      or coalesce(existing.payroll_date,(existing.started_at at time zone 'UTC')::date)
        is distinct from (params->>'expected_payroll_date')::date then
      raise exception 'This shift changed. Refresh Payroll before editing it again.' using errcode='40001';
    end if;
    if exists(select 1 from fleet_internal.fleet_employee_shifts s
      where s.fleet_id=selected_fleet and s.employee_user_id=requested_employee and s.id<>requested_shift
        and tstzrange(s.started_at,s.ended_at,'[)') && tstzrange(requested_start,requested_end,'[)')) then
      raise exception 'This shift overlaps another recorded shift for this employee.' using errcode='22023';
    end if;

    if existing.id is null then
      insert into fleet_internal.fleet_employee_shifts(id,fleet_id,employee_user_id,started_at,ended_at,payroll_date)
      values(requested_shift,selected_fleet,requested_employee,requested_start,requested_end,
        nullif(requested_date,(requested_start at time zone 'UTC')::date));
    else
      update fleet_internal.fleet_employee_shifts s
      set started_at=requested_start,ended_at=requested_end,
        payroll_date=nullif(requested_date,(requested_start at time zone 'UTC')::date)
      where s.id=existing.id;
    end if;
    return jsonb_build_object('id',requested_shift,'payroll_date',requested_date);
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
    select s.employee_user_id into requested_employee from fleet_internal.fleet_employee_shifts s
    where s.id=requested_shift and s.fleet_id=selected_fleet;
    if requested_employee is not null then
      perform pg_advisory_xact_lock(hashtextextended('rigtracker:office-time:'||selected_fleet||':'||requested_employee::text,0));
    end if;
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
    'office_role',e.office_role,'seconds',coalesce(period.seconds,0),'shifts',coalesce(period.shifts,'[]'::jsonb),
    'payroll_days',case when action='payroll_roster' then coalesce(saved.days,'[]'::jsonb) end
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
  left join lateral (
    select jsonb_agg(to_jsonb(d)-'saved_by'-'fleet_id'-'employee_user_id' order by d.payroll_date desc) as days
    from fleet_internal.fleet_employee_payroll_days d
    where action='payroll_roster' and d.fleet_id=e.fleet_id and d.employee_user_id=e.user_id
      and d.payroll_date between from_date and to_date
  ) saved on true
  where e.fleet_id=selected_fleet and (period.shifts is not null or saved.days is not null
    or (not e.password_required and (e.office_is_official or 'hourly'=any(e.office_permissions))));

  return jsonb_build_object('fleet_id',selected_fleet,'from',from_date,'to',to_date,'employees',clock_result);
end;
$function$;
