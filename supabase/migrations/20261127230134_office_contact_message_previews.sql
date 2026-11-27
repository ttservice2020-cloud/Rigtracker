create table public.fleet_office_message_reads (
  fleet_id text not null,
  employee_id text not null,
  peer_employee_id text,
  viewer_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  seen_at timestamptz not null,
  seen_id uuid not null,
  unique nulls not distinct (fleet_id, employee_id, peer_employee_id, viewer_id),
  foreign key (fleet_id, employee_id) references public.fleet_employees(fleet_id, employee_id) on delete cascade,
  foreign key (fleet_id, peer_employee_id) references public.fleet_employees(fleet_id, employee_id) on delete cascade
);
create index fleet_office_message_reads_viewer on public.fleet_office_message_reads (viewer_id);
create index fleet_office_message_reads_peer on public.fleet_office_message_reads (fleet_id, peer_employee_id) where peer_employee_id is not null;
alter table public.fleet_office_message_reads enable row level security;
revoke all on public.fleet_office_message_reads from public, anon, authenticated;
grant select on public.fleet_office_message_reads to authenticated;
grant insert (fleet_id, employee_id, peer_employee_id, seen_at, seen_id), update (seen_at, seen_id)
  on public.fleet_office_message_reads to authenticated;
create policy fleet_office_message_reads_own on public.fleet_office_message_reads for all to authenticated
  using (viewer_id = (select auth.uid()) and fleet_internal.office_message_participant(fleet_id, employee_id, peer_employee_id))
  with check (viewer_id = (select auth.uid()) and fleet_internal.office_message_participant(fleet_id, employee_id, peer_employee_id));

create function public.mark_fleet_office_message_read(displayed_message_id uuid)
returns void language sql security invoker set search_path = ''
as $$
  insert into public.fleet_office_message_reads as seen (fleet_id, employee_id, peer_employee_id, seen_at, seen_id)
  select message.fleet_id, message.employee_id, message.peer_employee_id, message.created_at, message.id
  from public.fleet_office_messages message where message.id = displayed_message_id
  on conflict (fleet_id, employee_id, peer_employee_id, viewer_id) do update
    set seen_at = excluded.seen_at, seen_id = excluded.seen_id
    where (seen.seen_at, seen.seen_id) < (excluded.seen_at, excluded.seen_id);
$$;
revoke all on function public.mark_fleet_office_message_read(uuid) from public, anon, authenticated;
grant execute on function public.mark_fleet_office_message_read(uuid) to authenticated;

-- Use the existing roster checks and keep message lookups under the caller's RLS policies.
create or replace function public.fleet_office_message_contacts(requested_fleet_id text default null)
returns jsonb language sql stable security invoker set search_path = ''
as $$
  with roster as materialized (
    select fleet_internal.office_message_contacts(requested_fleet_id) as data
  ), caller as (
    select data, data ->> 'fleet_id' as fleet_id, data ->> 'employee_id' as employee_id
    from roster
  )
  select caller.data || jsonb_build_object(
    'contacts', coalesce(previews.contacts, '[]'::jsonb),
    'admin_last_message', previews.admin_last_message,
    'admin_unread_message_id', previews.admin_unread_message_id
  )
  from caller
  cross join lateral (
    select jsonb_agg(contact.data || jsonb_build_object('last_message', latest.preview, 'unread_message_id', unread.id)
        order by contact.position) filter (where contact.employee_id is not null) as contacts,
      (jsonb_agg(latest.preview) filter (where contact.employee_id is null)) -> 0 as admin_last_message,
      (jsonb_agg(unread.id) filter (where contact.employee_id is null)) -> 0 as admin_unread_message_id
    from (
      select entry.data, entry.position, entry.data ->> 'employee_id' as employee_id
      from jsonb_array_elements(caller.data -> 'contacts') with ordinality entry(data, position)
      union all
      select '{}'::jsonb, 0, null where caller.employee_id is not null
    ) contact
    cross join lateral (
      select least(caller.employee_id collate "C", contact.employee_id collate "C") as employee_id,
        case when caller.employee_id is not null and contact.employee_id is not null
             then greatest(caller.employee_id collate "C", contact.employee_id collate "C") end as peer_employee_id
    ) thread
    left join lateral (
      select jsonb_build_object('body', left(message.body, 160), 'created_at', message.created_at,
        'own', coalesce(message.sender_id = (select auth.uid()), false)) as preview
      from public.fleet_office_messages message
      where message.fleet_id = caller.fleet_id
        and message.employee_id = thread.employee_id
        and (message.peer_employee_id = thread.peer_employee_id or
             (thread.peer_employee_id is null and message.peer_employee_id is null))
      order by message.created_at desc, message.id desc
      limit 1
    ) latest on true
    left join public.fleet_office_message_reads seen
      on seen.viewer_id = (select auth.uid()) and seen.fleet_id = caller.fleet_id
      and seen.employee_id = thread.employee_id and seen.peer_employee_id is not distinct from thread.peer_employee_id
    left join lateral (
      select message.id
      from public.fleet_office_messages message
      where message.fleet_id = caller.fleet_id
        and message.employee_id = thread.employee_id
        and (message.peer_employee_id = thread.peer_employee_id or
             (thread.peer_employee_id is null and message.peer_employee_id is null))
        and message.sender_id <> (select auth.uid())
        and (seen.seen_at is null or (message.created_at, message.id) > (seen.seen_at, seen.seen_id))
      order by message.created_at desc, message.id desc
      limit 1
    ) unread on true
  ) previews;
$$;
