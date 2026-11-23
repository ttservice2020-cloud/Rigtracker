create function fleet_internal.payroll_tax_employee(target_fleet text, target_kind text, target_reference text)
returns uuid language plpgsql stable set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee uuid;
begin
  if actor is null or not (
    exists (select 1 from public.fleets f where f.id=target_fleet and f.admin_user_id=actor)
    or exists (select 1 from public.fleet_employees e where e.fleet_id=target_fleet and e.user_id=actor
      and not e.password_required
      and (e.office_is_official or 'payroll'=any(e.office_permissions)
        or e.office_permissions @> array['settlements','driver_tax']))
  ) then
    raise exception 'Payroll access is required.' using errcode='42501';
  end if;

  if target_kind in ('driver','settlement') then
    select link.profile_user_id into employee
    from public.rigtracker_fleet_links link
    join public.rigtracker_profiles p on p.user_id=link.profile_user_id and p.profile_type='company_driver'
    where link.fleet_id=target_fleet and link.unlinked_at is null
      and case when target_kind='driver' then p.profile_id=target_reference else exists (
        select 1 from fleet_internal.company_driver_settlements draft
        where draft.id=target_reference::uuid and draft.driver_user_id=p.user_id and draft.fleet_id=target_fleet
      ) end;
  elsif target_kind='office' then
    select e.user_id into employee from public.fleet_employees e
    where e.user_id=target_reference::uuid and e.fleet_id=target_fleet;
  end if;
  if employee is null then
    raise exception 'This employee is unavailable in the selected fleet.' using errcode='42501';
  end if;
  return employee;
end;
$$;
revoke all on function fleet_internal.payroll_tax_employee(text,text,text) from public, anon, authenticated;

create or replace function fleet_internal.payroll_tax_profile(
  action text, target_fleet text, target_kind text, target_reference text, as_of date,
  settings jsonb, expected_revision uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  employee uuid := fleet_internal.payroll_tax_employee(target_fleet,target_kind,target_reference);
  profile fleet_internal.payroll_tax_profiles%rowtype;
begin
  if as_of is null or as_of not between date '2020-01-01' and date '2100-12-31' then
    raise exception 'Choose a valid effective date.' using errcode='22023';
  end if;

  if action='read' then
    select t.* into profile from fleet_internal.payroll_tax_profiles t
    where t.fleet_id=target_fleet and t.employee_user_id=employee and t.effective_on<=as_of
    order by t.effective_on desc limit 1;
  elsif action='save' then
    perform fleet_internal.validate_payroll_tax_settings(settings);
    if expected_revision is null then
      insert into fleet_internal.payroll_tax_profiles as t(fleet_id,employee_user_id,effective_on,settings,saved_by)
      values(target_fleet,employee,as_of,settings,actor)
      on conflict(fleet_id,employee_user_id,effective_on) do nothing returning t.* into profile;
    else
      update fleet_internal.payroll_tax_profiles t
      set settings=payroll_tax_profile.settings, revision=gen_random_uuid(), saved_by=actor, saved_at=clock_timestamp()
      where t.fleet_id=target_fleet and t.employee_user_id=employee and t.effective_on=as_of
        and t.revision=expected_revision returning t.* into profile;
    end if;
    if not found then
      raise exception 'Tax settings changed for this date. Reopen Tax Information and try again.' using errcode='40001';
    end if;
  else
    raise exception 'Choose a tax profile action.' using errcode='22023';
  end if;

  if profile.revision is null then return null; end if;
  return jsonb_build_object('effective_on',profile.effective_on,'settings',profile.settings,'revision',profile.revision);
end;
$$;

create table fleet_internal.payroll_paid_checks (
  id bigint generated always as identity primary key,
  fleet_id text not null references public.fleets(id) on delete cascade,
  employee_user_id uuid not null references auth.users(id),
  paid_on date not null,
  pay_year integer generated always as (extract(year from paid_on)::integer) stored,
  check_ref text not null,
  settlement_id uuid references fleet_internal.company_driver_settlements(id),
  ui_state text,
  prior_totals jsonb not null,
  amounts jsonb not null,
  statement jsonb not null,
  recorded_by uuid references auth.users(id) on delete set null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (fleet_id,employee_user_id,pay_year,check_ref),
  unique (settlement_id),
  check (paid_on between date '2020-01-01' and date '2100-12-31'),
  check (ui_state is null or ui_state ~ '^[A-Z]{2}$')
);
create index payroll_paid_checks_employee_date_idx
  on fleet_internal.payroll_paid_checks(fleet_id,employee_user_id,paid_on desc,id desc);
create index payroll_paid_checks_employee_fk_idx on fleet_internal.payroll_paid_checks(employee_user_id);
create index payroll_paid_checks_recorder_fk_idx on fleet_internal.payroll_paid_checks(recorded_by);
alter table fleet_internal.payroll_paid_checks enable row level security;
revoke all on table fleet_internal.payroll_paid_checks from public, anon, authenticated;

create function fleet_internal.payroll_paid_check_history(
  action text, target_fleet text, target_kind text, target_reference text, pay_date date,
  state_ui text, payment_reference text, expected_revision text, check_data jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  employee uuid := fleet_internal.payroll_tax_employee(target_fleet,target_kind,target_reference);
  driver_settlement uuid := case when target_kind='settlement' then target_reference::uuid end;
  ref text := lower(nullif(btrim(payment_reference),''));
  pay_year_start date := date_trunc('year',pay_date::timestamp)::date;
  receipt fleet_internal.payroll_paid_checks%rowtype;
  latest fleet_internal.payroll_paid_checks%rowtype;
  totals jsonb;
  line_totals jsonb;
  prior jsonb := check_data->'prior';
  current_amounts jsonb := check_data->'amounts';
  details jsonb := check_data->'statement';
  fields constant text[] := array['gross','deductions','socialSecurityYtd','medicareYtd','supplementalYtd','futaYtd','sutaYtd','federalWages'];
begin
  if target_kind not in ('office','settlement') or pay_date is null
    or pay_date not between date '2020-01-01' and date '2100-12-31'
    or (state_ui is not null and state_ui !~ '^[A-Z]{2}$') then
    raise exception 'Choose a valid pay date and state unemployment jurisdiction.' using errcode='22023';
  end if;

  if action='record' then
    perform pg_advisory_xact_lock(hashtextextended(target_fleet || ':' || employee::text,0));
  elsif action is distinct from 'read' then
    raise exception 'Choose a payroll history action.' using errcode='22023';
  end if;

  if driver_settlement is not null then
    ref := 'settlement:' || driver_settlement::text;
    select c.* into receipt from fleet_internal.payroll_paid_checks c
    where c.settlement_id=driver_settlement and c.fleet_id=target_fleet and c.employee_user_id=employee;
  elsif ref is not null then
    select c.* into receipt from fleet_internal.payroll_paid_checks c
    where c.fleet_id=target_fleet and c.employee_user_id=employee
      and c.pay_year=extract(year from pay_date)::integer and c.check_ref=ref;
  end if;

  select c.* into latest from fleet_internal.payroll_paid_checks c
  where c.fleet_id=target_fleet and c.employee_user_id=employee
    and c.paid_on>=pay_year_start and c.paid_on<pay_year_start+interval '1 year'
  order by c.paid_on desc,c.id desc limit 1;

  if receipt.id is not null then
    if action='record' then
      raise exception 'This payment is already recorded.' using errcode='23505';
    end if;
    select jsonb_object_agg(key,
      case when receipt.prior_totals->>key is not null and receipt.amounts->>key is not null
        then (receipt.prior_totals->>key)::numeric+(receipt.amounts->>key)::numeric end)
      into totals from unnest(fields) as key;
    return jsonb_build_object('before',receipt.prior_totals,'through',totals,
      'paid_on',receipt.paid_on,'statement',receipt.statement,'amounts',receipt.amounts,'ui_state',receipt.ui_state);
  end if;

  -- The latest verified opening balance anchors each category. A missing check amount
  -- after that anchor makes the total unknown until payroll verifies a new balance.
  select jsonb_object_agg(key,
    case when coalesce(balance.missing,0)=0 then balance.total end) into totals
  from unnest(fields) as key
  cross join lateral (
    select count(*) filter (where c.amounts->>key is null) as missing,
      anchor.opening+sum((c.amounts->>key)::numeric) as total
    from (
      select a.paid_on,a.id,(a.prior_totals->>key)::numeric as opening
      from fleet_internal.payroll_paid_checks a
      where a.fleet_id=target_fleet and a.employee_user_id=employee
        and a.paid_on between pay_year_start and pay_date and a.prior_totals->>key is not null
        and (key<>'sutaYtd' or a.ui_state=state_ui)
      order by a.paid_on desc,a.id desc limit 1
    ) anchor
    join fleet_internal.payroll_paid_checks c on c.fleet_id=target_fleet and c.employee_user_id=employee
      and c.paid_on between anchor.paid_on and pay_date and (c.paid_on,c.id)>=(anchor.paid_on,anchor.id)
      and (key<>'sutaYtd' or c.ui_state=state_ui or c.ui_state is null)
    group by anchor.opening
  ) balance;

  if action='record' then
    if expected_revision is distinct from coalesce(latest.id::text,'0') then
      raise exception 'Payroll history changed. Reopen the estimate before recording this payment.' using errcode='40001';
    end if;
    if pay_date>current_date or ref is null or length(ref)>100
      or (driver_settlement is null and ref like 'settlement:%') then
      raise exception 'Enter an issued pay date and a unique payment reference.' using errcode='22023';
    end if;
    if latest.paid_on>pay_date then
      raise exception 'Record payments in pay-date order within each year. Use verified prior totals for earlier payroll.' using errcode='22023';
    end if;
    if jsonb_typeof(prior) is distinct from 'object' or jsonb_typeof(current_amounts) is distinct from 'object'
      or jsonb_typeof(details) is distinct from 'object' or octet_length(check_data::text)>16000
      or array(select jsonb_object_keys(prior)) <@ fields is not true
      or array(select jsonb_object_keys(current_amounts)) <@ fields is not true
      or exists (
        select 1 from (select * from jsonb_each(prior) union all select * from jsonb_each(current_amounts)) item
        where case when jsonb_typeof(value)='null' then false
          when jsonb_typeof(value)='number' then (value::text)::numeric not between 0 and 100000000
            or (value::text)::numeric <> round((value::text)::numeric,2)
          else true end
      )
      or exists (select 1 from unnest(fields[1:4]) key where prior->>key is null or current_amounts->>key is null)
      or (current_amounts->>'deductions')::numeric>(current_amounts->>'gross')::numeric
      or (prior->>'deductions')::numeric>(prior->>'gross')::numeric then
      raise exception 'Enter valid verified year-to-date totals and check amounts.' using errcode='22023';
    end if;
    if exists (
      select 1 from unnest(array['earnings','taxes','deductions']) key
      where jsonb_typeof(details->key) is distinct from 'array'
    ) or jsonb_typeof(details->'taxTotal') is distinct from 'number' then
      raise exception 'The settlement requires an itemized pay and tax breakdown.' using errcode='22023';
    end if;
    if exists (
      select 1 from unnest(array['earnings','taxes','deductions']) as key
      cross join lateral jsonb_array_elements(details->key) line
      where jsonb_typeof(line->'name') is distinct from 'string' or length(btrim(line->>'name')) not between 1 and 180
        or case when jsonb_typeof(line->'amount')='number'
          then (line->>'amount')::numeric not between 0 and 100000000
            or (line->>'amount')::numeric <> round((line->>'amount')::numeric,2)
          else true end
    ) then
      raise exception 'Enter a description and valid amount for each settlement line.' using errcode='22023';
    end if;
    select jsonb_object_agg(key,subtotal) into line_totals
    from unnest(array['earnings','taxes','deductions']) as key
    cross join lateral (select coalesce(sum((line->>'amount')::numeric),0) subtotal
      from jsonb_array_elements(details->key) line) lines;
    if (line_totals->>'earnings')::numeric <> (current_amounts->>'gross')::numeric
      or (line_totals->>'taxes')::numeric <> (details->>'taxTotal')::numeric
      or (line_totals->>'taxes')::numeric+(line_totals->>'deductions')::numeric
        <> (current_amounts->>'deductions')::numeric then
      raise exception 'The settlement line amounts must match the gross pay, taxes and deductions.' using errcode='22023';
    end if;
    insert into fleet_internal.payroll_paid_checks
      (fleet_id,employee_user_id,paid_on,check_ref,settlement_id,ui_state,prior_totals,amounts,statement,recorded_by)
    values (target_fleet,employee,pay_date,ref,driver_settlement,state_ui,prior,current_amounts,details,auth.uid());
    return fleet_internal.payroll_paid_check_history('read',target_fleet,target_kind,target_reference,pay_date,
      state_ui,payment_reference,null,null);
  end if;

  return jsonb_build_object('before',coalesce(totals,'{}'::jsonb),'revision',coalesce(latest.id::text,'0'));
end;
$$;

create function public.payroll_paid_check_history(
  action text, target_fleet text, target_kind text, target_reference text, pay_date date,
  state_ui text default null, payment_reference text default null, expected_revision text default null,
  check_data jsonb default null)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.payroll_paid_check_history(action,target_fleet,target_kind,target_reference,pay_date,
    state_ui,payment_reference,expected_revision,check_data);
$$;
revoke all on function fleet_internal.payroll_paid_check_history(text,text,text,text,date,text,text,text,jsonb),
  public.payroll_paid_check_history(text,text,text,text,date,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function fleet_internal.payroll_paid_check_history(text,text,text,text,date,text,text,text,jsonb),
  public.payroll_paid_check_history(text,text,text,text,date,text,text,text,jsonb) to authenticated;
