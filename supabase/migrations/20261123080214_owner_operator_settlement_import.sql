create table public.owner_settlement_import_access (
  user_id uuid primary key references public.rigtracker_profiles(user_id) on delete cascade
);

alter table public.owner_settlement_import_access enable row level security;
revoke all on table public.owner_settlement_import_access from public, anon, authenticated;
grant select on table public.owner_settlement_import_access to authenticated;

create policy "Owner reads their import access"
on public.owner_settlement_import_access for select to authenticated
using (
  user_id = (select auth.uid()) and exists (
    select 1 from public.rigtracker_profiles profile
    where profile.user_id = owner_settlement_import_access.user_id
      and profile.profile_type = 'driver'
      and not profile.password_required
  )
);

create table public.owner_settlement_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid()
    references public.owner_settlement_import_access(user_id) on delete cascade,
  document_hash text not null check (document_hash ~ '^[a-f0-9]{64}$'),
  data jsonb not null check (
    jsonb_typeof(data) = 'object'
    and octet_length(data::text) <= 250000
    and coalesce(jsonb_typeof(data->'loads') = 'array', false)
    and coalesce(jsonb_typeof(data->'charges') = 'array', false)
    and coalesce(jsonb_typeof(data->'summary') = 'object', false)
  ),
  created_at timestamptz not null default now(),
  unique (user_id, document_hash)
);

alter table public.owner_settlement_imports enable row level security;
revoke all on table public.owner_settlement_imports from public, anon, authenticated;
grant select, delete on table public.owner_settlement_imports to authenticated;
grant insert (document_hash, data) on table public.owner_settlement_imports to authenticated;

create policy "Owner reads their imported spreadsheets"
on public.owner_settlement_imports for select to authenticated
using (user_id = (select user_id from public.owner_settlement_import_access));

create policy "Owner saves their imported spreadsheets"
on public.owner_settlement_imports for insert to authenticated
with check (user_id = (select user_id from public.owner_settlement_import_access));

create policy "Owner deletes their imported spreadsheets"
on public.owner_settlement_imports for delete to authenticated
using (user_id = (select user_id from public.owner_settlement_import_access));
