create table fleet_internal.office_employee_hourly_rates (
  fleet_id text not null references public.fleets(id) on delete cascade,
  employee_user_id uuid not null references public.fleet_employees(user_id) on delete cascade,
  effective_on date not null check (isfinite(effective_on)),
  hourly_rate numeric(9,2) not null check (hourly_rate >= 0),
  revision uuid not null default gen_random_uuid(),
  saved_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (fleet_id,employee_user_id,effective_on)
);
create index office_employee_hourly_rates_employee_idx on fleet_internal.office_employee_hourly_rates(employee_user_id);
alter table fleet_internal.office_employee_hourly_rates enable row level security;
revoke all on fleet_internal.office_employee_hourly_rates from public,anon,authenticated;

create function fleet_internal.manage_office_hourly_rates(
  action text,target_fleet text,employee_number text,rate_date date,rate_amount numeric,expected_revision uuid
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee public.fleet_employees%rowtype;
  saved fleet_internal.office_employee_hourly_rates%rowtype;
begin
  if actor is null or not fleet_internal.office_has_permission(target_fleet,'payroll') then
    raise exception 'Payroll access is required to open hourly rates.' using errcode='42501';
  end if;
  if action='list' then
    return coalesce((select jsonb_agg(jsonb_build_object(
      'employee_id',e.employee_id,'effective_on',r.effective_on,'hourly_rate',r.hourly_rate,'revision',r.revision
    ) order by e.employee_id,r.effective_on desc)
    from fleet_internal.office_employee_hourly_rates r
    join public.fleet_employees e on e.fleet_id=r.fleet_id and e.user_id=r.employee_user_id
    where r.fleet_id=target_fleet and (employee_number is null or e.employee_id=employee_number)),'[]'::jsonb);
  end if;
  if action is distinct from 'save' or rate_date is null or not isfinite(rate_date)
    or rate_amount is null or rate_amount not between 0 and 9999999.99 or rate_amount<>round(rate_amount,2) then
    raise exception 'Enter an effective date and an hourly rate in dollars and cents.' using errcode='22023';
  end if;
  select * into employee from public.fleet_employees e where e.fleet_id=target_fleet and e.employee_id=employee_number;
  if not found or not fleet_internal.office_can_edit_employee(employee,actor) then
    raise exception 'You cannot edit pay for this Office profile.' using errcode='42501';
  end if;

  if expected_revision is null then
    insert into fleet_internal.office_employee_hourly_rates(fleet_id,employee_user_id,effective_on,hourly_rate,saved_by)
    values(target_fleet,employee.user_id,rate_date,rate_amount,actor)
    on conflict do nothing returning * into saved;
  else
    update fleet_internal.office_employee_hourly_rates r
    set hourly_rate=rate_amount,revision=gen_random_uuid(),saved_by=actor,updated_at=clock_timestamp()
    where r.fleet_id=target_fleet and r.employee_user_id=employee.user_id and r.effective_on=rate_date
      and r.revision=expected_revision returning * into saved;
  end if;
  if saved.revision is null then
    select * into saved from fleet_internal.office_employee_hourly_rates r
    where r.fleet_id=target_fleet and r.employee_user_id=employee.user_id and r.effective_on=rate_date;
    if saved.hourly_rate is distinct from rate_amount then
      raise exception 'This hourly rate changed. Review the saved rate and try again.' using errcode='40001';
    end if;
  end if;
  return jsonb_build_object('effective_on',saved.effective_on,'hourly_rate',saved.hourly_rate,'revision',saved.revision);
end;
$$;

create function public.manage_office_hourly_rates(
  action text,target_fleet text,employee_number text default null,rate_date date default null,
  rate_amount numeric default null,expected_revision uuid default null
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.manage_office_hourly_rates(action,target_fleet,employee_number,rate_date,rate_amount,expected_revision);
$$;
revoke all on function fleet_internal.manage_office_hourly_rates(text,text,text,date,numeric,uuid),
  public.manage_office_hourly_rates(text,text,text,date,numeric,uuid) from public,anon,authenticated;
grant execute on function fleet_internal.manage_office_hourly_rates(text,text,text,date,numeric,uuid),
  public.manage_office_hourly_rates(text,text,text,date,numeric,uuid) to authenticated;
