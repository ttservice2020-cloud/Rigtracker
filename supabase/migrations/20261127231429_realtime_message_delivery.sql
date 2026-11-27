create policy receive_rigtracker_message_updates on realtime.messages for select to authenticated
  using (extension = 'broadcast' and topic = (select realtime.topic())
    and topic = 'rigtracker:message-updates:' || (select auth.uid())::text);

-- Broadcast a refresh signal only. Message bodies and previews still use the existing authorized queries.
create function fleet_internal.broadcast_message_update(recipient uuid, event_name text)
returns void language plpgsql set search_path = ''
as $$
begin
  perform realtime.send('{}'::jsonb, event_name, 'rigtracker:message-updates:' || recipient::text, true);
exception when others then
  -- A Realtime outage should never prevent the message from being saved.
  raise log 'RigTracker message refresh broadcast could not be sent (SQLSTATE %)', sqlstate;
end;
$$;
revoke all on function fleet_internal.broadcast_message_update(uuid,text) from public, anon, authenticated;

create function fleet_internal.notify_office_message_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  recipient uuid;
begin
  for recipient in
    select fleet.admin_user_id from public.fleets fleet
    where new.peer_employee_id is null and fleet.id = new.fleet_id
    union
    select employee.user_id from public.fleet_employees employee
    where employee.fleet_id = new.fleet_id and not employee.password_required
      and employee.employee_id in (new.employee_id, new.peer_employee_id)
  loop
    perform fleet_internal.broadcast_message_update(recipient, 'office_message');
  end loop;
  return new;
end;
$$;
revoke all on function fleet_internal.notify_office_message_update() from public, anon, authenticated;

create function fleet_internal.notify_driver_message_update()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  chat fleet_internal.company_message_threads%rowtype;
  recipient uuid;
begin
  select * into chat from fleet_internal.company_message_threads where id = new.thread_id;
  for recipient in
    select candidate.user_id from (
      select chat.driver_id as user_id
      union
      select fleet.admin_user_id from public.fleets fleet where fleet.id = chat.fleet_id
      union
      select employee.user_id from public.fleet_employees employee
      where employee.fleet_id = chat.fleet_id and not employee.password_required
      union
      select link.profile_user_id from public.rigtracker_fleet_links link
      join public.rigtracker_profiles profile on profile.user_id = link.profile_user_id
      where link.fleet_id = chat.fleet_id and link.unlinked_at is null
        and profile.profile_type = 'mechanic' and not profile.password_required
    ) candidate
    where fleet_internal.message_thread_visible(chat, candidate.user_id)
  loop
    perform fleet_internal.broadcast_message_update(recipient, 'driver_message');
  end loop;
  return new;
end;
$$;
revoke all on function fleet_internal.notify_driver_message_update() from public, anon, authenticated;

create trigger fleet_office_message_realtime after insert on public.fleet_office_messages
for each row execute function fleet_internal.notify_office_message_update();

create trigger company_message_realtime after insert on fleet_internal.company_messages
for each row execute function fleet_internal.notify_driver_message_update();
