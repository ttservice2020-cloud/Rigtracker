create table fleet_internal.load_customer_payments (
  fleet_id text not null,
  load_id uuid not null,
  paid_on date not null check (isfinite(paid_on)),
  recorded_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references auth.users(id) on delete set null,
  primary key (fleet_id, load_id),
  foreign key (fleet_id, load_id)
    references public.fleet_dispatch_loads(fleet_id, id) on delete cascade
);

alter table fleet_internal.load_customer_payments enable row level security;
revoke all on table fleet_internal.load_customer_payments from public, anon, authenticated;

create index load_customer_payments_recent_idx
  on fleet_internal.load_customer_payments (fleet_id, paid_on desc, recorded_at desc, load_id desc);

create index fleet_dispatch_bol_completed_idx
  on public.fleet_dispatch_loads (fleet_id, updated_at desc, id desc)
  where status = 'completed';

create function fleet_internal.list_fleet_bol_payments(
  target_fleet text,
  paid boolean,
  target_pro text,
  pro_prefix text,
  before_date date,
  before_time timestamptz,
  before_load uuid
)
returns table (
  load_id uuid,
  pro_number text,
  return_load boolean,
  delivered_at text,
  paid_on date,
  sort_at timestamptz,
  destination text,
  paperwork jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  requested_number bigint;
begin
  if not fleet_internal.office_has_permission(target_fleet, 'bol_payments') then
    raise exception 'BOLs & Payments access is required.' using errcode = '42501';
  end if;

  if target_pro is not null then
    if target_pro !~ '^[0-9]{1,19}$' then
      return;
    end if;
    if target_pro::numeric > 9223372036854775807 then
      return;
    end if;
    requested_number := target_pro::bigint;
  end if;

  return query
  with candidate_loads as (
    (
      select l.id, null::date as payment_date, l.updated_at as sort_time
      from public.fleet_dispatch_loads l
      where not paid
        and l.fleet_id = target_fleet
        and l.status = 'completed'
        and (requested_number is null or l.pro_number = requested_number)
        and (pro_prefix is null or pro_prefix = case when l.return_of is null then 'A' else 'B' end)
        and (before_load is null or (l.updated_at, l.id) < (before_time, before_load))
        and not exists (
          select 1 from fleet_internal.load_customer_payments p
          where p.fleet_id = target_fleet and p.load_id = l.id
        )
      order by l.updated_at desc, l.id desc
      limit 31
    )
    union all
    (
      select l.id, p.paid_on, p.recorded_at
      from fleet_internal.load_customer_payments p
      join public.fleet_dispatch_loads l on l.fleet_id = p.fleet_id and l.id = p.load_id
      where paid
        and p.fleet_id = target_fleet
        and l.status = 'completed'
        and (requested_number is null or l.pro_number = requested_number)
        and (pro_prefix is null or pro_prefix = case when l.return_of is null then 'A' else 'B' end)
        and (before_load is null or (p.paid_on, p.recorded_at, p.load_id) < (before_date, before_time, before_load))
      order by p.paid_on desc, p.recorded_at desc, p.load_id desc
      limit 31
    )
  )
  select l.id, l.pro_number::text, l.return_of is not null,
    coalesce(nullif(l.progress ->> 'completedAt', ''), l.updated_at::text),
    c.payment_date, c.sort_time,
    concat_ws(', ',
      nullif(l.details #>> '{receivers,-1,company}', ''),
      nullif(l.details #>> '{receivers,-1,city}', ''),
      nullif(l.details #>> '{receivers,-1,state}', '')
    ),
    coalesce(d.documents, '[]'::jsonb)
  from candidate_loads c
  join public.fleet_dispatch_loads l on l.fleet_id = target_fleet and l.id = c.id
  left join lateral (
    select jsonb_agg(jsonb_build_object(
      'kind', s.kind,
      'company', s.info ->> 'company',
      'bol', r.report ->> 'bol',
      'path', r.report ->> 'document'
    ) order by s.sequence_no) as documents
    from fleet_internal.workflow_stops(l.details) s
    cross join lateral (select l.progress #> array['stops', s.stop_key, 'driverReport'] as report) r
    where split_part(r.report ->> 'document', '/', 1) = l.id::text
  ) d on true
  order by c.payment_date desc, c.sort_time desc, c.id desc;
end;
$$;

create function fleet_internal.mark_fleet_load_paid(target_fleet text, target_load uuid, received_on date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not fleet_internal.office_has_permission(target_fleet, 'bol_payments') then
    raise exception 'BOLs & Payments access is required.' using errcode = '42501';
  end if;
  if received_on is null or not isfinite(received_on)
    or received_on > (clock_timestamp() at time zone 'UTC')::date + 1 then
    raise exception 'Enter a valid payment date.' using errcode = '22023';
  end if;

  perform 1 from public.fleet_dispatch_loads l
  where l.fleet_id = target_fleet and l.id = target_load and l.status = 'completed'
  for share;
  if not found then
    raise exception 'A completed load is required.' using errcode = '22023';
  end if;

  insert into fleet_internal.load_customer_payments (fleet_id, load_id, paid_on, recorded_by)
    values (target_fleet, target_load, received_on, auth.uid())
    on conflict (fleet_id, load_id) do nothing;
end;
$$;

create function public.list_fleet_bol_payments(
  target_fleet text,
  paid boolean,
  target_pro text,
  pro_prefix text,
  before_date date,
  before_time timestamptz,
  before_load uuid
)
returns table (
  load_id uuid,
  pro_number text,
  return_load boolean,
  delivered_at text,
  paid_on date,
  sort_at timestamptz,
  destination text,
  paperwork jsonb
)
language sql
stable
set search_path = ''
as $$
  select * from fleet_internal.list_fleet_bol_payments(
    target_fleet, paid, target_pro, pro_prefix, before_date, before_time, before_load
  );
$$;

create function public.mark_fleet_load_paid(target_fleet text, target_load uuid, received_on date)
returns void
language sql
set search_path = ''
as $$
  select fleet_internal.mark_fleet_load_paid(target_fleet, target_load, received_on);
$$;

revoke all on function fleet_internal.list_fleet_bol_payments(text, boolean, text, text, date, timestamptz, uuid),
  fleet_internal.mark_fleet_load_paid(text, uuid, date),
  public.list_fleet_bol_payments(text, boolean, text, text, date, timestamptz, uuid),
  public.mark_fleet_load_paid(text, uuid, date)
  from public, anon, authenticated;

grant execute on function fleet_internal.list_fleet_bol_payments(text, boolean, text, text, date, timestamptz, uuid),
  fleet_internal.mark_fleet_load_paid(text, uuid, date),
  public.list_fleet_bol_payments(text, boolean, text, text, date, timestamptz, uuid),
  public.mark_fleet_load_paid(text, uuid, date)
  to authenticated;
