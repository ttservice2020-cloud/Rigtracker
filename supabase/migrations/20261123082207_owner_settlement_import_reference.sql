create unique index owner_settlement_imports_user_carrier_reference_idx
on public.owner_settlement_imports (
  user_id,
  (lower(btrim(data ->> 'carrier'))),
  (upper(btrim(data ->> 'reference')))
)
where nullif(btrim(data ->> 'reference'), '') is not null;
