create or replace function fleet_internal.company_messaging(action text, fleet text, thread uuid, params jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  scope text[];
  target_driver uuid;
  target_staff uuid;
  chat fleet_internal.company_message_threads%rowtype;
  channel text := params ->> 'kind';
  message_body text := btrim(params ->> 'body');
  message_id uuid;
  author_name text;
  history jsonb;
  last_seen_at timestamptz;
begin
  if actor is null then raise exception 'Sign in first.' using errcode='42501'; end if;
  if action='list' then
    return jsonb_build_object(
      'threads',coalesce((select jsonb_agg(
        jsonb_build_object('id',t.id,'fleet_id',t.fleet_id,'kind',t.kind,
         'contact',case when t.driver_id=actor then case when t.kind='private' then coalesce(
              (select nullif(btrim(concat_ws(' ',first_name,last_name)),'') from public.fleet_employees where user_id=t.staff_id),
              'Fleet Official') else initcap(t.kind) end
            else coalesce((select nullif(btrim(concat_ws(' ',first_name,last_name)),'') from public.rigtracker_profiles where user_id=t.driver_id),'Company Driver') end,
         'unread',exists(select 1 from fleet_internal.company_messages pending
            where pending.thread_id=t.id and pending.sender_id<>actor and pending.created_at>coalesce(
              (select r.read_at from fleet_internal.company_message_reads r where r.thread_id=t.id and r.viewer_id=actor),
              '-infinity'::timestamptz)),
         'last_message',(select jsonb_build_object('id',m.id,'sender_id',m.sender_id,'body',left(m.body,140),'created_at',m.created_at)
           from fleet_internal.company_messages m where m.thread_id=t.id order by m.created_at desc,m.id desc limit 1))
          order by t.updated_at desc) from (
            select * from fleet_internal.company_message_threads t
             where fleet_internal.message_thread_visible(t,actor) order by t.updated_at desc limit 150
          ) t),'[]'::jsonb),
      'staff_fleet',(select jsonb_build_object('id',f.id,'scope',fleet_internal.message_staff_scope(actor,f.id))
        from public.fleets f where f.admin_user_id=actor
          or f.id=(select e.fleet_id from public.fleet_employees e where e.user_id=actor and not e.password_required)
        order by (f.admin_user_id=actor) desc limit 1),
      'linked_fleets',coalesce((select jsonb_agg(l.fleet_id order by l.fleet_id) from public.rigtracker_fleet_links l
        where l.profile_user_id=actor and fleet_internal.company_driver_is_linked(actor,l.fleet_id)), '[]'::jsonb)
    );
  end if;
  if action='contacts' then
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if not ('staff'=any(scope)) then raise exception 'Staff access is required.' using errcode='42501'; end if;
    return jsonb_build_object(
      'drivers',coalesce((select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'name',
           coalesce(nullif(btrim(concat_ws(' ',p.first_name,p.last_name)),''),'Company Driver'),
           'private_enabled',exists(select 1 from fleet_internal.driver_private_message_access x
             where x.fleet_id=fleet and x.driver_id=p.user_id and x.staff_id=actor)) order by p.last_name,p.first_name)
        from public.rigtracker_profiles p join public.rigtracker_fleet_links l on l.profile_user_id=p.user_id
        where l.fleet_id=fleet and l.unlinked_at is null and p.profile_type='company_driver'), '[]'::jsonb),
      'staff', case when 'official'=any(scope) then coalesce((
        select jsonb_agg(staff_member order by name) from (
          select 'Fleet Admin' as name, jsonb_build_object('id',admin_user_id,'name','Fleet Admin') as staff_member
          from public.fleets where id=fleet
          union all
          select btrim(concat_ws(' ',first_name,last_name)),jsonb_build_object('id',user_id,'name',
            coalesce(nullif(btrim(concat_ws(' ',first_name,last_name)),''),fleet_id || '-' || employee_id))
          from public.fleet_employees where fleet_id=fleet
        ) staff_rows
      ),'[]'::jsonb) else '[]'::jsonb end,
      'grants',case when 'official'=any(scope) then coalesce((
        select jsonb_agg(jsonb_build_object('profile_id',p.profile_id,'staff_id',x.staff_id))
        from fleet_internal.driver_private_message_access x join public.rigtracker_profiles p on p.user_id=x.driver_id
        where x.fleet_id=fleet
      ),'[]'::jsonb) else '[]'::jsonb end);
  end if;
  if action in ('start','set_private_access') then
    scope := fleet_internal.message_staff_scope(actor,fleet);
    if 'staff'=any(scope) then
      select p.user_id into target_driver from public.rigtracker_profiles p
      where p.profile_id=params ->> 'profile_id' and p.profile_type='company_driver';
    else
      target_driver := actor;
    end if;
    if target_driver is null or not fleet_internal.company_driver_is_linked(target_driver,fleet) then
      raise exception 'Choose an active Company Driver in this fleet.' using errcode='42501';
    end if;
    if action='set_private_access' then
      if not ('official'=any(scope)) or jsonb_typeof(params -> 'enabled') is distinct from 'boolean' then
        raise exception 'Only an Official can change private messaging access.' using errcode='42501';
      end if;
      target_staff := (params ->> 'staff_id')::uuid;
      if not exists(select 1 from public.fleets where id=fleet and admin_user_id=target_staff)
        and not exists(select 1 from public.fleet_employees where fleet_id=fleet and user_id=target_staff) then
        raise exception 'Choose a member of this fleet’s staff.' using errcode='42501';
      end if;
      if (params ->> 'enabled')::boolean then
        insert into fleet_internal.driver_private_message_access(fleet_id,driver_id,staff_id,granted_by)
          values(fleet,target_driver,target_staff,actor) on conflict do nothing;
      else
        delete from fleet_internal.driver_private_message_access
          where fleet_id=fleet and driver_id=target_driver and staff_id=target_staff;
      end if;
      return '{}'::jsonb;
    end if;
    if channel='private' then
      if not ('staff'=any(scope)) or not exists(select 1 from fleet_internal.driver_private_message_access
        where fleet_id=fleet and driver_id=target_driver and staff_id=actor) then
        raise exception 'An Official must grant you private messaging for this driver.' using errcode='42501';
      end if;
      target_staff := actor;
    elsif coalesce(channel,'') not in ('dispatch','maintenance') or ('staff'=any(scope) and not (channel=any(scope))) then
      raise exception 'You do not have access to this team conversation.' using errcode='42501';
    end if;
    insert into fleet_internal.company_message_threads(fleet_id,driver_id,kind,staff_id)
      values(fleet,target_driver,channel,target_staff)
      on conflict(fleet_id,driver_id,kind,staff_id) do nothing returning * into chat;
    if not found then
      select * into chat from fleet_internal.company_message_threads
        where fleet_id=fleet and driver_id=target_driver and kind=channel and staff_id is not distinct from target_staff;
    end if;
    return jsonb_build_object('id',chat.id);
  end if;

  select * into chat from fleet_internal.company_message_threads where id=thread;
  if not found or not fleet_internal.message_thread_visible(chat,actor) then
    raise exception 'Conversation unavailable to this account.' using errcode='42501';
  end if;
  if action='thread' then
    select coalesce(jsonb_agg(to_jsonb(msg) - 'thread_id' order by msg.created_at,msg.id),'[]'::jsonb),
        max(msg.created_at)
      into history,last_seen_at
      from (select * from fleet_internal.company_messages where thread_id=chat.id
        order by created_at desc,id desc limit 150) msg;
    if params -> 'mark_read' = 'true'::jsonb and last_seen_at is not null then
      insert into fleet_internal.company_message_reads(thread_id,viewer_id,read_at)
        values(chat.id,actor,last_seen_at) on conflict(thread_id,viewer_id)
        do update set read_at=greatest(company_message_reads.read_at,excluded.read_at);
    end if;
    return jsonb_build_object(
      'can_send',fleet_internal.company_driver_is_linked(chat.driver_id,chat.fleet_id)
          and (chat.kind<>'private' or exists(select 1 from fleet_internal.driver_private_message_access
            where fleet_id=chat.fleet_id and driver_id=chat.driver_id and staff_id=chat.staff_id)),
      'messages',history);
  end if;
  if action<>'send' then raise exception 'Unsupported messaging action.' using errcode='22023'; end if;
  if not fleet_internal.company_driver_is_linked(chat.driver_id,chat.fleet_id)
    or (chat.kind='private' and not exists(select 1 from fleet_internal.driver_private_message_access
      where fleet_id=chat.fleet_id and driver_id=chat.driver_id and staff_id=chat.staff_id)) then
    raise exception 'This conversation is closed for new messages.' using errcode='42501';
  end if;
  if coalesce(char_length(message_body),0) not between 1 and 4000 then
    raise exception 'Enter a message up to 4,000 characters.' using errcode='22023';
  end if;
  message_id := (params ->> 'message_id')::uuid;
  if message_id is null then raise exception 'Message ID is missing.' using errcode='22023'; end if;
  if actor=chat.driver_id then
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name from public.rigtracker_profiles where user_id=actor;
    author_name := coalesce(author_name,'Company Driver');
  else
    select nullif(btrim(concat_ws(' ',first_name,last_name)),'') into author_name from public.fleet_employees where user_id=actor;
    author_name := coalesce(author_name,'Fleet Admin');
  end if;
  insert into fleet_internal.company_messages(id,thread_id,sender_id,sender_name,body)
    values(message_id,chat.id,actor,author_name,message_body) on conflict(id) do nothing;
  if found then update fleet_internal.company_message_threads set updated_at=clock_timestamp() where id=chat.id; end if;
  return '{}'::jsonb;
end;
$$;
