create table fleet_internal.driver_push_devices (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  enabled_at timestamptz not null default clock_timestamp()
);
create index driver_push_devices_user_idx on fleet_internal.driver_push_devices(user_id);

create table fleet_internal.driver_push_deliveries (
  id bigint generated always as identity primary key,
  device_id bigint not null references fleet_internal.driver_push_devices(id) on delete cascade,
  kind text not null check (kind in ('loads','messages')),
  source_id uuid not null,
  queued_at timestamptz not null default clock_timestamp(),
  next_attempt timestamptz not null default clock_timestamp(),
  attempts integer not null default 0,
  lease uuid
);
create index driver_push_deliveries_device_idx on fleet_internal.driver_push_deliveries(device_id);
create index driver_push_deliveries_due_idx on fleet_internal.driver_push_deliveries(next_attempt,id);

alter table fleet_internal.driver_push_devices enable row level security;
alter table fleet_internal.driver_push_deliveries enable row level security;
revoke all on fleet_internal.driver_push_devices,fleet_internal.driver_push_deliveries from public,anon,authenticated;

create function fleet_internal.driver_push_device(action text,device jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  address text := device->>'endpoint';
  public_key text;
  enabled boolean;
begin
  if actor is null then raise exception 'Sign in to manage notifications.' using errcode='42501'; end if;
  if action='disable' then
    delete from fleet_internal.driver_push_devices d where d.user_id=actor and d.endpoint=address;
    return '{}'::jsonb;
  end if;
  if not exists(select 1 from public.rigtracker_profiles p where p.user_id=actor
    and p.profile_type in ('company_driver','driver') and not p.password_required) then
    raise exception 'A driver account is required.' using errcode='42501';
  end if;
  if action='enable' then
    if char_length(address) not between 25 and 1800
      or coalesce(address,'') !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9-]+[.]push[.]apple[.]com|[a-z0-9-]+[.]notify[.]windows[.]com)/[^[:space:]#]+$'
      or coalesce(device#>>'{keys,p256dh}','') !~ '^[A-Za-z0-9_-]{87}$'
      or coalesce(device#>>'{keys,auth}','') !~ '^[A-Za-z0-9_-]{22}$' then
      raise exception 'This browser push subscription is unavailable.' using errcode='22023';
    end if;
    insert into fleet_internal.driver_push_devices as d(user_id,endpoint,p256dh,auth_key)
    values(actor,address,device#>>'{keys,p256dh}',device#>>'{keys,auth}')
    on conflict(endpoint) do update set p256dh=excluded.p256dh,auth_key=excluded.auth_key
    where d.user_id=actor;
    if not found then raise exception 'Turn on notifications again for this account.' using errcode='42501'; end if;
  elsif action is distinct from 'status' then
    raise exception 'Choose a notification action.' using errcode='22023';
  end if;
  select decrypted_secret::jsonb->>'publicKey' into public_key
  from vault.decrypted_secrets where name='rigtracker_driver_push_vapid';
  select exists(select 1 from fleet_internal.driver_push_devices d where d.user_id=actor and d.endpoint=address)
    into enabled;
  return jsonb_build_object('enabled',enabled,'publicKey',public_key);
end;
$$;

create function public.driver_push_device(action text,device jsonb default null)
returns jsonb language sql security invoker set search_path = ''
as $$select fleet_internal.driver_push_device(action,device)$$;
revoke all on function fleet_internal.driver_push_device(text,jsonb),public.driver_push_device(text,jsonb)
  from public,anon,authenticated;
grant execute on function fleet_internal.driver_push_device(text,jsonb),public.driver_push_device(text,jsonb)
  to authenticated;

create function fleet_internal.queue_driver_push()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name='company_messages' then
    insert into fleet_internal.driver_push_deliveries(device_id,kind,source_id)
    select d.id,'messages',new.id
    from fleet_internal.company_message_threads t
    join fleet_internal.driver_push_devices d on d.user_id=t.driver_id
    where t.id=new.thread_id and t.driver_id<>new.sender_id
      and fleet_internal.company_driver_is_linked(t.driver_id,t.fleet_id);
  elsif new.status='current' then
    insert into fleet_internal.driver_push_deliveries(device_id,kind,source_id)
    select distinct d.id,'loads',new.id
    from public.rigtracker_fleet_links l
    join fleet_internal.driver_push_devices d on d.user_id=l.profile_user_id
    where l.fleet_id=new.fleet_id and l.unlinked_at is null
      and l.dispatch_driver_id in (new.driver_id,new.second_driver_id)
      and fleet_internal.workflow_driver(d.user_id,new.fleet_id)=l.dispatch_driver_id
      and new.progress#>>array['driverResponses',l.dispatch_driver_id::text,'decision'] is null
      and case when tg_op='INSERT' then true else old.status<>'current' or
        (l.dispatch_driver_id is distinct from old.driver_id and l.dispatch_driver_id is distinct from old.second_driver_id) end;
  end if;
  return new;
end;
$$;
revoke all on function fleet_internal.queue_driver_push() from public,anon,authenticated;
create trigger driver_push_new_message after insert on fleet_internal.company_messages
  for each row execute function fleet_internal.queue_driver_push();
create trigger driver_push_new_assignment after insert or update of status,driver_id,second_driver_id
  on public.fleet_dispatch_loads for each row execute function fleet_internal.queue_driver_push();

-- The worker is called by the database. The caller token and signing key live in Vault.
create function fleet_internal.driver_push_worker_key(worker_token text, candidate jsonb)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  secret text;
  vapid jsonb;
begin
  select decrypted_secret into secret from vault.decrypted_secrets where name='rigtracker_driver_push_worker';
  if secret is null or worker_token is null or length(worker_token)<>64
    or extensions.digest(worker_token,'sha256')<>extensions.digest(secret,'sha256') then
    return null;
  end if;
  select decrypted_secret::jsonb into vapid from vault.decrypted_secrets where name='rigtracker_driver_push_vapid';
  if vapid is null and candidate is not null then
    perform pg_advisory_xact_lock(hashtextextended('rigtracker:driver-push-vapid',0));
    select decrypted_secret::jsonb into vapid from vault.decrypted_secrets where name='rigtracker_driver_push_vapid';
    if vapid is null then
      if coalesce(candidate->>'publicKey','') !~ '^[A-Za-z0-9_-]{87}$'
        or coalesce(candidate->>'privateKey','') !~ '^[A-Za-z0-9_-]{43}$' then
        raise exception 'Invalid signing keys.' using errcode='22023';
      end if;
      perform vault.create_secret(candidate::text,'rigtracker_driver_push_vapid','Driver Web Push signing key.');
      vapid := candidate;
    end if;
  end if;
  return vapid;
end;
$$;
create function public.driver_push_worker_key(worker_token text,candidate jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$select fleet_internal.driver_push_worker_key(worker_token,candidate)$$;

create function fleet_internal.claim_driver_push()
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  jobs jsonb;
begin
  delete from fleet_internal.driver_push_deliveries q where q.queued_at<now()-interval '1 hour';
  with due as (
    select q.id from fleet_internal.driver_push_deliveries q where q.next_attempt<=now()
    order by q.next_attempt,q.id limit 25 for update skip locked
  ), leased as (
    update fleet_internal.driver_push_deliveries q set
      next_attempt=now()+interval '2 minutes',attempts=q.attempts+1,lease=gen_random_uuid()
    from due where q.id=due.id returning q.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'lease',q.lease,'kind',q.kind,
    'attempts',q.attempts,'endpoint',d.endpoint,'p256dh',d.p256dh,'auth',d.auth_key,
    'deliver',case when q.kind='messages' then exists(
      select 1 from fleet_internal.company_messages m
      join fleet_internal.company_message_threads t on t.id=m.thread_id
      where m.id=q.source_id and t.driver_id=d.user_id and m.sender_id<>d.user_id
        and fleet_internal.company_driver_is_linked(d.user_id,t.fleet_id)
        and not exists(select 1 from fleet_internal.company_message_reads r
          where r.thread_id=t.id and r.viewer_id=d.user_id and r.read_at>=m.created_at)
    ) else exists(
      select 1 from public.fleet_dispatch_loads l
      cross join lateral (select fleet_internal.workflow_driver(d.user_id,l.fleet_id) as id) assigned
      where l.id=q.source_id and l.status='current' and assigned.id in (l.driver_id,l.second_driver_id)
        and l.progress#>>array['driverResponses',assigned.id::text,'decision'] is null
    ) end
  )),'[]'::jsonb) into jobs
  from leased q join fleet_internal.driver_push_devices d on d.id=q.device_id;
  return jobs;
end;
$$;
create function public.claim_driver_push()
returns jsonb language sql security invoker set search_path = ''
as $$select fleet_internal.claim_driver_push()$$;

create function fleet_internal.finish_driver_push(job_id bigint,job_lease uuid,outcome text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
  if outcome='gone' then
    delete from fleet_internal.driver_push_devices d
    using fleet_internal.driver_push_deliveries q where q.id=job_id and q.lease=job_lease and d.id=q.device_id;
  elsif outcome='done' then
    delete from fleet_internal.driver_push_deliveries q where q.id=job_id and q.lease=job_lease;
  elsif outcome='retry' then
    update fleet_internal.driver_push_deliveries q set lease=null,
      next_attempt=now()+make_interval(secs=>30*power(2,least(q.attempts,5)))
    where q.id=job_id and q.lease=job_lease;
  end if;
end;
$$;
create function public.finish_driver_push(job_id bigint,job_lease uuid,outcome text)
returns void language sql security invoker set search_path = ''
as $$select fleet_internal.finish_driver_push(job_id,job_lease,outcome)$$;

revoke all on function fleet_internal.driver_push_worker_key(text,jsonb),public.driver_push_worker_key(text,jsonb),
  fleet_internal.claim_driver_push(),public.claim_driver_push(),
  fleet_internal.finish_driver_push(bigint,uuid,text),public.finish_driver_push(bigint,uuid,text)
  from public,anon,authenticated;
grant usage on schema fleet_internal to service_role;
grant execute on function fleet_internal.driver_push_worker_key(text,jsonb),public.driver_push_worker_key(text,jsonb),
  fleet_internal.claim_driver_push(),public.claim_driver_push(),
  fleet_internal.finish_driver_push(bigint,uuid,text),public.finish_driver_push(bigint,uuid,text)
  to service_role;

create function fleet_internal.message_yard_trailer_offer()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  driver_account uuid;
  conversation uuid;
  message_time timestamptz := clock_timestamp();
begin
  if actor is null or new.offered_driver is null or new.picked_up_at is not null
    or not fleet_internal.office_has_permission(new.fleet_id,'dispatch') then return new; end if;
  if tg_op='UPDATE' and (new.offered_driver,new.trailer,new.yard)
    is not distinct from (old.offered_driver,old.trailer,old.yard) then return new; end if;
  select l.profile_user_id into driver_account from public.rigtracker_fleet_links l
  where l.dispatch_driver_id=new.offered_driver and l.fleet_id=new.fleet_id and l.unlinked_at is null
    and fleet_internal.company_driver_is_linked(l.profile_user_id,new.fleet_id);
  if driver_account is null or driver_account=actor then return new; end if;
  insert into fleet_internal.company_message_threads as t(fleet_id,driver_id,kind,updated_at)
  values (new.fleet_id,driver_account,'dispatch',message_time)
  on conflict (fleet_id,driver_id,kind,staff_id) do update
    set updated_at=greatest(t.updated_at,excluded.updated_at)
  returning id into conversation;
  insert into fleet_internal.company_messages(id,thread_id,sender_id,sender_name,body,created_at)
  values(gen_random_uuid(),conversation,actor,'Dispatch',
    'Yard trailer ' || new.trailer || ' is ready for pickup at ' || new.yard ||
    '. Confirm pickup in the Yard trailers section of Messages.',message_time);
  return new;
end;
$$;
revoke all on function fleet_internal.message_yard_trailer_offer() from public,anon,authenticated;
create trigger dispatch_message_yard_trailer after insert or update of offered_driver,trailer,yard
  on fleet_internal.driver_yard_handoffs for each row execute function fleet_internal.message_yard_trailer_offer();

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'rigtracker_driver_push_worker',
  'Authenticates the scheduled driver push worker.')
where not exists(select 1 from vault.secrets where name='rigtracker_driver_push_worker');

select cron.schedule('rigtracker-driver-push','30 seconds',$job$
  select net.http_post(
    url:='https://pxxikzzfrcncwufpzdfp.supabase.co/functions/v1/driver-push',
    headers:=jsonb_build_object('Content-Type','application/json','x-rigtracker-worker',token.decrypted_secret),
    body:='{}'::jsonb,timeout_milliseconds:=5000)
  from vault.decrypted_secrets token
  where token.name='rigtracker_driver_push_worker' and (
    exists(select 1 from fleet_internal.driver_push_deliveries q where q.next_attempt<=now())
    or not exists(select 1 from vault.secrets where name='rigtracker_driver_push_vapid')
  );
$job$);
