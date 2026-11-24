alter table fleet_internal.company_driver_settlements
  drop constraint company_driver_settlements_load_count_check,
  add constraint company_driver_settlements_load_count_check check (load_count >= 0),
  add column load_revision integer not null default 0;

create function fleet_internal.remove_company_statement_load(target_fleet text,target_statement uuid,target_load uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  driver_user uuid;
  draft fleet_internal.company_driver_settlements%rowtype;
  remaining_count integer;
  remaining_pay numeric;
begin
  if actor is null or not fleet_internal.company_pay_staff(actor,target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode='42501';
  end if;
  select d.driver_user_id into driver_user from fleet_internal.company_driver_settlements d
  where d.id=target_statement and d.fleet_id=target_fleet;
  if not found then raise exception 'Settlement draft unavailable.' using errcode='42501'; end if;

  -- Match the lock order used by Add Loads and Record Paid Check.
  perform pg_advisory_xact_lock(hashtextextended(target_fleet || ':' || driver_user::text,0));
  select * into draft from fleet_internal.company_driver_settlements d
  where d.id=target_statement and d.fleet_id=target_fleet for update;
  if not found then raise exception 'Settlement draft unavailable.' using errcode='42501'; end if;
  if draft.status<>'draft'
    or exists(select 1 from fleet_internal.payroll_paid_checks c where c.settlement_id=draft.id)
    or exists(select 1 from fleet_internal.company_driver_pay_files f
      where f.fleet_id=draft.fleet_id and f.driver_id=draft.driver_user_id
        and (f.settlement_id=draft.id or lower(btrim(f.title))=lower(draft.settlement_number))) then
    raise exception 'Loads can only be removed before a statement is sent or paid.' using errcode='55000';
  end if;

  delete from fleet_internal.company_driver_settlement_lines line
  where line.fleet_id=draft.fleet_id and line.settlement_id=draft.id and line.load_id=target_load;
  if found then
    select count(*),coalesce(sum(line.total_pay),0) into remaining_count,remaining_pay
    from fleet_internal.company_driver_settlement_lines line where line.settlement_id=draft.id;
    update fleet_internal.company_driver_settlements d
    set load_count=remaining_count,total_pay=remaining_pay,load_revision=d.load_revision+1,
      period_start=case when remaining_count>0 then d.period_start end,
      period_end=case when remaining_count>0 then d.period_end end
    where d.id=draft.id returning * into draft;
  end if;
  return jsonb_build_object('id',draft.id,'load_count',draft.load_count,'total_pay',draft.total_pay);
end;
$$;

create function public.remove_company_statement_load(target_fleet text,target_statement uuid,target_load uuid)
returns jsonb language sql security invoker set search_path = ''
as $$
  select fleet_internal.remove_company_statement_load(target_fleet,target_statement,target_load);
$$;

revoke all on function fleet_internal.remove_company_statement_load(text,uuid,uuid),
  public.remove_company_statement_load(text,uuid,uuid) from public,anon,authenticated;
grant execute on function fleet_internal.remove_company_statement_load(text,uuid,uuid),
  public.remove_company_statement_load(text,uuid,uuid) to authenticated;

create or replace function fleet_internal.company_payroll_saved_settlements(target_fleet text, requested_settlement_id uuid)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null or not fleet_internal.company_pay_staff(actor,target_fleet) then
    raise exception 'Payroll or settlements access is required.' using errcode='42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',draft.id,'driver_profile_id',draft.driver_profile_id,
      'paid',exists(select 1 from fleet_internal.payroll_paid_checks c where c.settlement_id=draft.id),
      'settlement_number',draft.settlement_number,'created_at',draft.created_at,
      'period_start',draft.period_start,'period_end',draft.period_end,
      'load_count',draft.load_count,'load_revision',draft.load_revision,'total_pay',draft.total_pay,
      'driver',concat_ws(' ',profile.first_name,profile.last_name),'sent_for_review',publication.sent,
      'lines',case when requested_settlement_id is not null then (
        select coalesce(jsonb_agg(jsonb_build_object(
          'load_id',line.load_id,'pro_number',line.pro_number,'is_return',load.return_of is not null,
          'pickup',coalesce(line.load_snapshot->'pickup',load.details#>'{pickups,0}'),
          'receiver',coalesce(line.load_snapshot->'receiver',load.details#>'{receivers,0}'),
          'delivered_on',coalesce(line.delivered_on,fleet_internal.statement_delivery_day(load)),
          'total_pay',line.total_pay,
          'lumper_reimbursement',fleet_internal.load_lumper_reimbursement(load,
            fleet_internal.workflow_driver(draft.driver_user_id,draft.fleet_id)),
          'has_signed_bol',fleet_internal.load_has_driver_bol(load),
          'loaded_miles',line.loaded_miles,'empty_miles',line.empty_miles,
          'pay_scale',line.pay_scale,'base_pay',line.base_pay,'base_pay_entered',line.base_pay_entered,
          'empty_mile_pay',line.empty_mile_pay,'stop_pay',line.stop_pay,'additional_pay',line.additional_pay
        ) order by line.created_at,line.pro_number),'[]'::jsonb)
        from fleet_internal.company_driver_settlement_lines line
        join public.fleet_dispatch_loads load on load.fleet_id=line.fleet_id and load.id=line.load_id
        where line.fleet_id=draft.fleet_id and line.settlement_id=draft.id
      ) end
    ) order by draft.created_at desc,draft.id)
    from fleet_internal.company_driver_settlements draft
    join public.rigtracker_profiles profile on profile.user_id=draft.driver_user_id
    cross join lateral (select exists (
      select 1 from fleet_internal.company_driver_pay_files f
      where f.fleet_id=draft.fleet_id and f.driver_id=draft.driver_user_id
        and (f.settlement_id=draft.id or lower(btrim(f.title))=lower(draft.settlement_number))
    ) as sent) publication
    where draft.fleet_id=target_fleet
      and case when requested_settlement_id is null then not publication.sent else draft.id=requested_settlement_id end
  ),'[]'::jsonb);
end;
$$;


create function fleet_internal.check_paid_statement_load_revision()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  draft fleet_internal.company_driver_settlements%rowtype;
begin
  if new.settlement_id is null then return new; end if;
  select * into draft from fleet_internal.company_driver_settlements d where d.id=new.settlement_id;
  if draft.load_count=0 then
    raise exception 'Add at least one load before recording payment for this statement.' using errcode='22023';
  end if;
  if (draft.load_revision<>0 or new.statement ? 'loadRevision')
    and (new.statement->>'loadRevision') is distinct from draft.load_revision::text then
    raise exception 'Loads changed on this statement. Reopen the statement before recording payment.' using errcode='40001';
  end if;
  return new;
end;
$$;
revoke all on function fleet_internal.check_paid_statement_load_revision() from public,anon,authenticated;
create trigger paid_statement_load_revision before insert on fleet_internal.payroll_paid_checks
  for each row execute function fleet_internal.check_paid_statement_load_revision();

create or replace function fleet_internal.confirm_published_statement_period()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  draft fleet_internal.company_driver_settlements%rowtype;
begin
  if new.settlement_id is null then return new; end if;
  select * into draft from fleet_internal.company_driver_settlements d
    where d.id=new.settlement_id and d.fleet_id=new.fleet_id and d.driver_user_id=new.driver_id for update;
  if draft.load_count=0 then
    raise exception 'Add at least one load before sending this statement.' using errcode='22023';
  end if;
  if draft.period_start is not null and (new.period_start,new.period_end) is distinct from (draft.period_start,draft.period_end) then
    raise exception 'Use the pay period saved on the statement draft.' using errcode='22023';
  end if;
  return new;
end;
$$;
