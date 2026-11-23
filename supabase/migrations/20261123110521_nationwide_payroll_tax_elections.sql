-- Only structured payroll elections are accepted. Attachments and tax ID numbers
-- are handled outside this calculation settings table.
create or replace function fleet_internal.validate_payroll_tax_settings(settings jsonb)
returns void language plpgsql immutable set search_path = ''
as $$
declare
  state_code text := settings->>'state';
  local_code text := settings->>'locality';
  field text;
  amount numeric;
  spec jsonb;
  state_fields jsonb;
  tax jsonb;
  local_taxes jsonb := coalesce(settings->'localTaxes','[]'::jsonb);
  elections jsonb := settings->'elections';
begin
  if jsonb_typeof(settings) is distinct from 'object'
    or octet_length(settings::text) > 10000
    or settings - array['state','periods','federalForm','filingStatus','multipleJobs','legacyAllowances',
      'credits','otherIncome','deductions','federalExtra','federalExemptYear','stateTreatment','stateExemptYear',
      'stateExtra','locality','localityName','localExtra','localTaxes','elections'] <> '{}'::jsonb
    or not coalesce(state_code = any(string_to_array(
      'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY',' ')),false)
    or jsonb_typeof(settings->'periods') is distinct from 'number'
    or coalesce(settings->>'periods','') not in ('12','24','26','52')
    or coalesce(settings->>'federalForm','') not in ('current','legacy','exempt','special')
    or coalesce(settings->>'filingStatus','') not in ('single','married','head')
    or (settings->>'federalForm'='legacy' and settings->>'filingStatus'='head')
    or jsonb_typeof(settings->'multipleJobs') is distinct from 'boolean'
    or coalesce(settings->>'stateTreatment','') not in ('regular','exempt','review')
    or (settings ? 'localityName' and jsonb_typeof(settings->'localityName') is distinct from 'string')
    or length(coalesce(settings->>'localityName','')) > 100
    or jsonb_typeof(elections) is distinct from 'object'
    or not coalesce(
      local_code in ('none','unverified','configured')
      or (state_code='IN' and local_code ~ '^in:(0[1-9]|[1-8][0-9]|9[012])$')
      or (state_code='NY' and local_code in ('newYorkCity','yonkersResident','yonkersNonresident'))
      or (state_code='MD' and local_code ~ '^md:(0[1-9]|1[0-9]|2[0-4]|nonresident)$')
      or (state_code='OH' and local_code ~ '^oh:[0-9]{4}$')
      or (state_code='PA' and local_code in ('philadelphiaResident','philadelphiaNonresident'))
      or (state_code='KY' and local_code in ('louisvilleResident','louisvilleNonresident','lexington','elizabethtown','bardstown')),false) then
    raise exception 'Review the withholding elections and local jurisdiction.' using errcode='22023';
  end if;

  foreach field in array array['legacyAllowances','credits','otherIncome','deductions','federalExtra','stateExtra','localExtra',
    'federalExemptYear','stateExemptYear'] loop
    if jsonb_typeof(settings->field) is distinct from 'number' then
      raise exception 'Enter valid withholding amounts.' using errcode='22023';
    end if;
    amount := (settings->>field)::numeric;
    if amount < 0 or amount > 100000000 or amount <> round(amount,2)
      or (field = 'legacyAllowances' and (amount > 99 or amount <> trunc(amount)))
      or (field in ('federalExemptYear','stateExemptYear') and (amount <> trunc(amount) or amount not between 2020 and 2100)) then
      raise exception 'Enter valid withholding amounts.' using errcode='22023';
    end if;
  end loop;

  -- Match each jurisdiction’s withholding certificate fields and types.
  state_fields := case state_code
    when 'AL' then '{"alStatus":["none","single","separate","married","head"],"alDependents":"integer"}'::jsonb
    when 'AR' then '{"arExemptions":"integer","arMethod":["standard","lowIncome"],"arLowStatus":["single","married","head"],"arLowDependents":"integer"}'::jsonb
    when 'AZ' then '{"azRate":[0,0.5,1,1.5,2,2.5,3,3.5]}'::jsonb
    when 'CA' then '{"caStatus":["single","married","head"],"caRegular":"integer","caDeduction":"integer"}'::jsonb
    when 'CO' then '{"coStatus":["standard","joint","certificate"],"coAllowance":"money"}'::jsonb
    when 'CT' then '{"ctCode":["A","B","C","D","F"],"ctReduction":"money"}'::jsonb
    when 'DC' then '{"dcAllowances":"integer"}'::jsonb
    when 'DE' then '{"deStatus":["single","married"],"deAllowances":"integer"}'::jsonb
    when 'GA' then '{"gaStatus":["standard","joint"],"gaDependents":"integer"}'::jsonb
    when 'HI' then '{"hiStatus":["single","married"],"hiAllowances":"integer"}'::jsonb
    when 'IA' then '{"iaStatus":["standard","head","joint","oldSingle","oldMarried"],"iaAllowance":"money","iaLegacyCount":"integer"}'::jsonb
    when 'ID' then '{"idStatus":["single","married"],"idAllowances":"integer"}'::jsonb
    when 'IL' then '{"ilBase":"integer","ilAdditional":"integer"}'::jsonb
    when 'IN' then '{"inPersonal":"integer","inDependent":"integer","inFirst":"integer","inAdopted":"integer"}'::jsonb
    when 'KS' then '{"ksStatus":["single","married"],"ksPersonal":[0,1,2],"ksAllowances":"integer"}'::jsonb
    when 'LA' then '{"laDeduction":[0,1,2]}'::jsonb
    when 'MA' then '{"maAllowances":"integer","maHead":[0,1],"maBlind":[0,1,2]}'::jsonb
    when 'MD' then '{"mdStatus":["single","married"],"mdExemptions":"integer"}'::jsonb
    when 'ME' then '{"meStatus":["single","married"],"meAllowances":"integer"}'::jsonb
    when 'MI' then '{"miAllowances":"integer"}'::jsonb
    when 'MN' then '{"mnStatus":["single","married"],"mnAllowances":"integer"}'::jsonb
    when 'MO' then '{"moStatus":["single","joint","head"]}'::jsonb
    when 'MS' then '{"msStatus":["none","single","head","married"],"msExemption":"money"}'::jsonb
    when 'MT' then '{"mtStatus":["single","married","head"],"mtPercent":"percent"}'::jsonb
    when 'NC' then '{"ncStatus":["standard","head"],"ncAllowances":"integer"}'::jsonb
    when 'ND' then '{"ndStatus":["single","married","head","oldSingle","oldMarried"],"ndAllowances":"integer"}'::jsonb
    when 'NE' then '{"neStatus":["single","married"],"neAllowances":"integer"}'::jsonb
    when 'NJ' then '{"njRate":["A","B","C","D","E"],"njAllowances":"integer"}'::jsonb
    when 'NM' then '{"nmStatus":["single","married","head"]}'::jsonb
    when 'NY' then '{"nyStatus":["single","married"],"nyAllowances":"integer","nyCityAllowances":"integer"}'::jsonb
    when 'OH' then '{"ohExemptions":"integer"}'::jsonb
    when 'OK' then '{"okStatus":["single","married"],"okAllowances":"integer"}'::jsonb
    when 'OR' then '{"orStatus":["single","married","noCertificate"],"orAllowances":"integer"}'::jsonb
    when 'RI' then '{"riExemptions":"integer"}'::jsonb
    when 'SC' then '{"scAllowances":"integer"}'::jsonb
    when 'UT' then '{"utStatus":["single","married"]}'::jsonb
    when 'VA' then '{"vaPersonal":"integer","vaAgeBlind":"integer"}'::jsonb
    when 'VT' then '{"vtStatus":["single","married"],"vtAllowances":"integer","vtFederalExtra":[0,1]}'::jsonb
    when 'WI' then '{"wiStatus":["single","married"],"wiExemptions":"integer"}'::jsonb
    when 'WV' then '{"wvStatus":["one","two"],"wvExemptions":"integer"}'::jsonb
    else '{}'::jsonb end;

  if elections - array(select jsonb_object_keys(state_fields)) <> '{}'::jsonb then
    raise exception 'Review the state withholding form elections.' using errcode='22023';
  end if;
  for field, spec in select key, value from jsonb_each(state_fields) loop
    if jsonb_typeof(spec) = 'array' then
      if not (elections ? field and spec @> jsonb_build_array(elections->field)) then
        raise exception 'Review the state withholding form elections.' using errcode='22023';
      end if;
    else
      if jsonb_typeof(elections->field) is distinct from 'number' then
        raise exception 'Enter the amount or allowances shown on the state form.' using errcode='22023';
      end if;
      amount := (elections->>field)::numeric;
      if amount < 0
        or (spec = '"integer"'::jsonb and (amount > 99 or amount <> trunc(amount)))
        or (spec = '"money"'::jsonb and (amount > 100000000 or amount <> round(amount,2)))
        or (spec = '"percent"'::jsonb and (amount > 100 or amount <> round(amount,4))) then
        raise exception 'Review the amounts on the state withholding form.' using errcode='22023';
      end if;
    end if;
  end loop;

  if jsonb_typeof(local_taxes) is distinct from 'array' then
    raise exception 'Review the saved local taxes.' using errcode='22023';
  end if;
  if jsonb_array_length(local_taxes) > 12
    or (local_code = 'configured' and jsonb_array_length(local_taxes) = 0)
    or (local_code = 'none' and jsonb_array_length(local_taxes) > 0) then
    raise exception 'Review the saved local taxes.' using errcode='22023';
  end if;
  for tax in select value from jsonb_array_elements(local_taxes) loop
    if jsonb_typeof(tax) is distinct from 'object'
      or tax - array['name','method','value','source'] <> '{}'::jsonb
      or jsonb_typeof(tax->'name') is distinct from 'string'
      or length(btrim(tax->>'name')) not between 1 and 100
      or coalesce(tax->>'method','') not in ('rate','fixed')
      or jsonb_typeof(tax->'value') is distinct from 'number'
      or (tax ? 'source' and (jsonb_typeof(tax->'source') is distinct from 'string'
        or length(tax->>'source') > 400
        or (tax->>'source' <> '' and tax->>'source' !~ '^https://[^[:space:]]+$'))) then
      raise exception 'Enter a local tax name, calculation method, and amount. Source URLs must use HTTPS.' using errcode='22023';
    end if;
    amount := (tax->>'value')::numeric;
    if amount < 0
      or (tax->>'method' = 'rate' and (amount > 100 or amount <> round(amount,4)))
      or (tax->>'method' = 'fixed' and (amount > 100000000 or amount <> round(amount,2))) then
      raise exception 'Review the saved rate or fixed amount for the local tax.' using errcode='22023';
    end if;
  end loop;
end;
$$;
revoke all on function fleet_internal.validate_payroll_tax_settings(jsonb) from public, anon, authenticated;
