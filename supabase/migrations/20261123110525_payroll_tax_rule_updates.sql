create table fleet_internal.payroll_tax_rule_releases (
  release_key text primary key,
  tax_year integer not null check (tax_year between 2020 and 2100),
  released_on date not null default current_date,
  title text not null,
  changes text[] not null
);

create table fleet_internal.payroll_tax_rule_acceptances (
  fleet_id text not null references public.fleets(id) on delete cascade,
  release_key text not null references fleet_internal.payroll_tax_rule_releases(release_key),
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz not null default clock_timestamp(),
  primary key (fleet_id, release_key)
);
create index payroll_tax_rule_acceptances_user_idx on fleet_internal.payroll_tax_rule_acceptances(accepted_by);
create index payroll_tax_rule_acceptances_release_idx on fleet_internal.payroll_tax_rule_acceptances(release_key);

alter table fleet_internal.payroll_tax_rule_releases enable row level security;
alter table fleet_internal.payroll_tax_rule_acceptances enable row level security;
revoke all on table fleet_internal.payroll_tax_rule_releases,
  fleet_internal.payroll_tax_rule_acceptances from public, anon, authenticated;

insert into fleet_internal.payroll_tax_rule_releases(release_key, tax_year, title, changes)
values ('2026-nationwide-regular-wages', 2026, 'Nationwide withholding for regular wages', array[
  'All 50 states and Washington, D.C. are available for regular wage estimates.',
  'Added Maryland counties, Baltimore City, Ohio school districts, Yonkers, and Philadelphia Wage Tax. Payroll can also save verified city, county, and school district rates.',
  'Georgia (May 11), Utah (pay periods starting June 1), Idaho (July 31), and Ohio (August 1) use the withholding schedules applicable to each pay date or pay period.',
  'Employer unemployment estimates apply annual wage caps to confirmed rates and wages. Payroll can check ordinary debt and family support deductions against federal garnishment limits.',
  'Earlier West Virginia checks and special withholding cases may still require an amount verified by payroll.'
]);

create function fleet_internal.payroll_tax_rule_updates(target_fleet text, accept_release text)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  can_accept boolean := fleet_internal.office_has_permission(target_fleet,'official');
begin
  if not (
    fleet_internal.office_has_permission(target_fleet,'payroll')
    or (fleet_internal.office_has_permission(target_fleet,'settlements')
      and fleet_internal.office_has_permission(target_fleet,'driver_tax'))
  ) then
    raise exception 'Payroll access is required.' using errcode='42501';
  end if;
  if accept_release is not null then
    if not can_accept then
      raise exception 'A Fleet Admin or Official must accept tax rule updates.' using errcode='42501';
    end if;
    insert into fleet_internal.payroll_tax_rule_acceptances(fleet_id,release_key,accepted_by)
    select target_fleet,r.release_key,auth.uid() from fleet_internal.payroll_tax_rule_releases r
    where r.release_key=accept_release and r.released_on<=current_date
    on conflict (fleet_id,release_key) do nothing;
    if not found and not exists (
      select 1 from fleet_internal.payroll_tax_rule_acceptances a
      where a.fleet_id=target_fleet and a.release_key=accept_release
    ) then
      raise exception 'This tax rule update is unavailable.' using errcode='22023';
    end if;
  end if;
  return jsonb_build_object('can_accept',can_accept,'releases',coalesce((
    select jsonb_agg(jsonb_build_object(
      'key',r.release_key,'tax_year',r.tax_year,'released_on',r.released_on,
      'title',r.title,'changes',r.changes,'accepted_at',a.accepted_at
    ) order by r.released_on desc,r.release_key)
    from fleet_internal.payroll_tax_rule_releases r
    left join fleet_internal.payroll_tax_rule_acceptances a
      on a.fleet_id=target_fleet and a.release_key=r.release_key
    where r.released_on<=current_date
  ),'[]'::jsonb));
end;
$$;

create function public.payroll_tax_rule_updates(target_fleet text, accept_release text default null)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.payroll_tax_rule_updates(target_fleet,accept_release);
$$;

revoke all on function fleet_internal.payroll_tax_rule_updates(text,text),
  public.payroll_tax_rule_updates(text,text) from public, anon, authenticated;
grant execute on function fleet_internal.payroll_tax_rule_updates(text,text),
  public.payroll_tax_rule_updates(text,text) to authenticated;
