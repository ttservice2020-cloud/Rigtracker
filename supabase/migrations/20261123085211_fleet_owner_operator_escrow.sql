create table fleet_internal.owner_operator_escrow_accounts (
  fleet_id text not null,
  owner_id uuid not null,
  operator_type text not null default 'owner_operator' check (operator_type in ('owner_operator','lease_operator')),
  primary key (fleet_id, owner_id),
  foreign key (fleet_id, owner_id) references public.rigtracker_fleet_links(fleet_id, profile_user_id) on delete cascade
);

create table fleet_internal.owner_operator_escrow_entries (
  id uuid primary key,
  fleet_id text not null,
  owner_id uuid not null,
  kind text not null check (kind in ('opening','deposit','interest','withdrawal','refund')),
  posted_on date not null,
  amount numeric(14,2) not null check (
    (kind in ('opening','deposit','interest') and amount > 0)
    or (kind in ('withdrawal','refund') and amount < 0)
  ),
  description text not null check (length(trim(description)) between 1 and 500),
  settlement_reference text check (length(settlement_reference) <= 80),
  recorded_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key (fleet_id, owner_id) references fleet_internal.owner_operator_escrow_accounts(fleet_id, owner_id) on delete cascade
);
create index owner_operator_escrow_entries_by_account
on fleet_internal.owner_operator_escrow_entries(fleet_id,owner_id,posted_on,created_at,id);

alter table fleet_internal.owner_operator_escrow_accounts enable row level security;
alter table fleet_internal.owner_operator_escrow_entries enable row level security;
revoke all on table fleet_internal.owner_operator_escrow_accounts,fleet_internal.owner_operator_escrow_entries
from public, anon, authenticated;

create function fleet_internal.escrow_targets(actor uuid, fleet_filter text)
returns table (fleet_id text, owner_id uuid, roster_id uuid, driver_name text, operator_type text,
  active boolean, can_manage boolean)
language sql stable set search_path = ''
as $$
  select link.fleet_id,link.profile_user_id,d.id,d.name,
    coalesce(account.operator_type,'owner_operator'),link.unlinked_at is null,
    fleet_internal.company_pay_staff(actor,link.fleet_id)
  from public.rigtracker_fleet_links link
  join public.rigtracker_profiles p on p.user_id=link.profile_user_id
  join public.fleet_dispatch_drivers d on d.id=link.dispatch_driver_id and d.fleet_id=link.fleet_id
  left join fleet_internal.owner_operator_escrow_accounts account
    on account.fleet_id=link.fleet_id and account.owner_id=link.profile_user_id
  where (fleet_filter is null or link.fleet_id=fleet_filter)
    and (
      (p.profile_type='driver' and d.driver_type='owner_op')
      or account.owner_id is not null
    )
    and (
      fleet_internal.company_pay_staff(actor,link.fleet_id)
      or (p.user_id=actor and p.profile_type='driver' and not p.password_required)
    );
$$;
revoke all on function fleet_internal.escrow_targets(uuid,text) from public,anon,authenticated;

create function fleet_internal.owner_operator_escrow(action text, target_fleet text, target_owner uuid, payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  scope record;
  entry_id uuid;
  entry_kind text;
  entry_date date;
  entry_amount numeric;
  entry_description text;
  entry_reference text;
  entry fleet_internal.owner_operator_escrow_entries%rowtype;
  lowest_balance numeric;
  new_type text;
begin
  if actor is null then raise exception 'Sign in to view escrow.' using errcode='42501'; end if;
  if action='targets' then
    return coalesce((
      select jsonb_agg(to_jsonb(t) order by t.active desc,t.fleet_id,t.driver_name,t.owner_id)
      from fleet_internal.escrow_targets(actor,target_fleet) t
    ),'[]'::jsonb);
  end if;

  select * into scope from fleet_internal.escrow_targets(actor,target_fleet) t
    where t.fleet_id=target_fleet and t.owner_id=target_owner;
  if not found then raise exception 'Escrow account unavailable.' using errcode='42501'; end if;
  if action='ledger' then
    return coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', rows.id, 'kind', rows.kind, 'posted_on', rows.posted_on, 'amount', rows.amount,
        'description', rows.description, 'settlement_reference', rows.settlement_reference, 'balance', rows.balance
      ) order by rows.posted_on desc, rows.created_at desc, rows.id desc)
      from (
        select e.*,
          sum(e.amount) over (order by e.posted_on,e.created_at,e.id rows unbounded preceding) as balance
        from fleet_internal.owner_operator_escrow_entries e
        where e.fleet_id=target_fleet and e.owner_id=target_owner
      ) rows
    ),'[]'::jsonb);
  end if;

  if not scope.can_manage then raise exception 'Payroll access is required to record escrow activity.' using errcode='42501'; end if;
  if action is null or action not in ('classify','record') then raise exception 'Choose an escrow action.' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('rigtracker:escrow:'||target_fleet||':'||target_owner,0));

  if action='classify' then
    new_type := payload->>'operator_type';
    if new_type is null or new_type not in ('owner_operator','lease_operator') then
      raise exception 'Select Owner-Operator or Lease Operator.' using errcode='22023';
    end if;
    insert into fleet_internal.owner_operator_escrow_accounts(fleet_id,owner_id,operator_type)
      values(target_fleet,target_owner,new_type)
      on conflict(fleet_id,owner_id) do update set operator_type=excluded.operator_type;
    return jsonb_build_object('operator_type',new_type);
  end if;

  if coalesce(payload->>'id','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
    or coalesce(payload->>'amount','') !~ '^[0-9]{1,12}(\.[0-9]{1,2})?$'
    or coalesce(payload->>'posted_on','') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Enter a valid date and dollar amount.' using errcode='22023';
  end if;
  entry_id := (payload->>'id')::uuid;
  entry_kind := payload->>'kind';
  entry_date := (payload->>'posted_on')::date;
  entry_amount := (payload->>'amount')::numeric;
  entry_description := btrim(payload->>'description');
  entry_reference := nullif(btrim(payload->>'settlement_reference'),'');
  if entry_amount<=0 or entry_date>current_date or entry_kind is null
    or entry_kind not in ('opening','deposit','interest','withdrawal','refund')
    or not coalesce(length(entry_description) between 1 and 500,false)
    or length(entry_reference)>80 then
    raise exception 'Enter a valid transaction type, posted date, amount, and description.' using errcode='22023';
  end if;
  if entry_kind in ('withdrawal','refund') then entry_amount := -entry_amount; end if;

  select * into entry from fleet_internal.owner_operator_escrow_entries e
    where e.id=entry_id and e.fleet_id=target_fleet and e.owner_id=target_owner;
  if found then
    if entry.kind is distinct from entry_kind or entry.amount is distinct from entry_amount or entry.posted_on is distinct from entry_date
      or entry.description is distinct from entry_description or entry.settlement_reference is distinct from entry_reference then
      raise exception 'This transaction was already recorded with different details. Refresh the escrow account.' using errcode='22023';
    end if;
    return jsonb_build_object('id',entry.id);
  end if;

  if entry_kind='opening' and exists (select 1 from fleet_internal.owner_operator_escrow_entries e
      where e.fleet_id=target_fleet and e.owner_id=target_owner) then
    raise exception 'This account already has escrow activity. Record a deposit or withdrawal for an adjustment.' using errcode='22023';
  end if;

  if entry_amount<0 then
    with balances as (
      select e.posted_on,
        sum(e.amount) over (order by e.posted_on,e.created_at,e.id rows unbounded preceding) as balance
      from fleet_internal.owner_operator_escrow_entries e
      where e.fleet_id=target_fleet and e.owner_id=target_owner
    )
    select least(
      coalesce((select sum(e.amount) from fleet_internal.owner_operator_escrow_entries e
        where e.fleet_id=target_fleet and e.owner_id=target_owner and e.posted_on<=entry_date),0),
      (select min(b.balance) from balances b where b.posted_on>entry_date)
    ) into lowest_balance;
    if lowest_balance+entry_amount<0 then
      raise exception 'The withdrawal or refund exceeds the escrow balance for that date.' using errcode='22023';
    end if;
  end if;
  insert into fleet_internal.owner_operator_escrow_accounts(fleet_id,owner_id)
    values(target_fleet,target_owner) on conflict do nothing;
  insert into fleet_internal.owner_operator_escrow_entries(id,fleet_id,owner_id,kind,posted_on,amount,description,settlement_reference,recorded_by)
    values(entry_id,target_fleet,target_owner,entry_kind,entry_date,entry_amount,entry_description,entry_reference,actor);
  return jsonb_build_object('id',entry_id);
end;
$$;

revoke all on function fleet_internal.owner_operator_escrow(text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function fleet_internal.owner_operator_escrow(text,text,uuid,jsonb) to authenticated;

create function public.owner_operator_escrow(action text, target_fleet text default null,
  target_owner uuid default null, payload jsonb default '{}'::jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.owner_operator_escrow(action,target_fleet,target_owner,payload);
$$;
revoke all on function public.owner_operator_escrow(text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.owner_operator_escrow(text,text,uuid,jsonb) to authenticated;
