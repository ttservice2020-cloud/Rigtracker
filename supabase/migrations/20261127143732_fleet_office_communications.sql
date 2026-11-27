create function public.fleet_online_employees(requested_fleet_id text)
returns table (employee_id text, first_name text, last_name text, office_role text)
language sql stable security invoker set search_path = ''
as $$
  select employee.employee_id, employee.first_name, employee.last_name, employee.office_role
  from public.fleet_employees employee
  join public.fleets fleet on fleet.id = employee.fleet_id
  where fleet.id = requested_fleet_id
    and fleet.admin_user_id = (select auth.uid())
    and employee.last_seen_at >= statement_timestamp() - interval '2 minutes'
  order by employee.last_name, employee.first_name, employee.employee_id;
$$;

revoke all on function public.fleet_online_employees(text) from public, anon, authenticated;
grant execute on function public.fleet_online_employees(text) to authenticated;

create table public.fleet_office_messages (
  id uuid primary key,
  fleet_id text not null,
  employee_id text not null,
  -- A null peer is the existing Fleet Admin and employee conversation.
  peer_employee_id text,
  sender_id uuid default auth.uid() references auth.users(id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default clock_timestamp(),
  check (peer_employee_id is null or employee_id collate "C" < peer_employee_id collate "C"),
  foreign key (fleet_id, employee_id) references public.fleet_employees(fleet_id, employee_id) on delete cascade,
  foreign key (fleet_id, peer_employee_id) references public.fleet_employees(fleet_id, employee_id) on delete cascade
);

create index fleet_office_messages_thread on public.fleet_office_messages (fleet_id, employee_id, peer_employee_id, created_at desc, id desc);
create index fleet_office_messages_peer on public.fleet_office_messages (fleet_id, peer_employee_id) where peer_employee_id is not null;

create function fleet_internal.office_message_participant(target_fleet text, target_employee text, target_peer text)
returns boolean language sql stable security definer set search_path = ''
as $$
  select (target_peer is null and exists (
    select 1 from public.fleets
    where id = target_fleet and admin_user_id = (select auth.uid())
  )) or exists (
    select 1 from public.fleet_employees
    where fleet_id = target_fleet and employee_id in (target_employee, target_peer)
      and user_id = (select auth.uid()) and not password_required
  );
$$;

revoke all on function fleet_internal.office_message_participant(text,text,text) from public, anon, authenticated;
grant execute on function fleet_internal.office_message_participant(text,text,text) to authenticated;
alter table public.fleet_office_messages enable row level security;
revoke all on public.fleet_office_messages from public, anon, authenticated;
grant select on public.fleet_office_messages to authenticated;
grant insert (id, fleet_id, employee_id, peer_employee_id, body) on public.fleet_office_messages to authenticated;

create policy fleet_office_messages_read on public.fleet_office_messages for select to authenticated
  using (fleet_internal.office_message_participant(fleet_id, employee_id, peer_employee_id));

create policy fleet_office_messages_send on public.fleet_office_messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and fleet_internal.office_message_participant(fleet_id, employee_id, peer_employee_id));

create function fleet_internal.office_message_contacts(requested_fleet_id text)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  target_fleet text;
  caller_employee_id text;
begin
  if requested_fleet_id is null then
    select employee.fleet_id, employee.employee_id into target_fleet, caller_employee_id
    from public.fleet_employees employee where employee.user_id = actor and not employee.password_required;
  else
    select fleet.id into target_fleet from public.fleets fleet
    where fleet.id = requested_fleet_id and fleet.admin_user_id = actor;
  end if;

  if target_fleet is null then
    raise exception 'An active Office or Fleet Admin profile is required.' using errcode = '42501';
  end if;

  return jsonb_build_object('fleet_id', target_fleet, 'employee_id', caller_employee_id, 'contacts', coalesce((
    select jsonb_agg(jsonb_build_object('employee_id', employee.employee_id, 'first_name', employee.first_name,
      'last_name', employee.last_name, 'office_role', employee.office_role)
      order by employee.last_name, employee.first_name, employee.employee_id)
    from public.fleet_employees employee
    where employee.fleet_id = target_fleet and not employee.password_required
      and employee.employee_id is distinct from caller_employee_id
  ), '[]'::jsonb));
end;
$$;

create function public.fleet_office_message_contacts(requested_fleet_id text default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$ select fleet_internal.office_message_contacts(requested_fleet_id); $$;

revoke all on function fleet_internal.office_message_contacts(text) from public, anon, authenticated;
revoke all on function public.fleet_office_message_contacts(text) from public, anon, authenticated;
grant execute on function fleet_internal.office_message_contacts(text) to authenticated;
grant execute on function public.fleet_office_message_contacts(text) to authenticated;
