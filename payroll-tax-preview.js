const payrollTaxPreview = (() => {
  'use strict';
  const dialog = document.getElementById('payrollTaxDialog');
  const title = document.getElementById('payrollTaxTitle');
  const body = document.getElementById('payrollTaxBody');
  const status = document.getElementById('payrollTaxStatus');
  const currency = new Intl.NumberFormat('en-US', { style:'currency', currency:'USD' });
  const wageBases = [
    ['federalWages', 'Federal income tax wages'],
    ['stateWages', 'State income tax wages'],
    ['localWages', 'Local income tax wages'],
    ['socialSecurityWages', 'Social Security wages'],
    ['medicareWages', 'Medicare wages']
  ];
  const historyFields = [
    ['gross','Gross pay'],
    ['deductions','Total taxes and deductions'],
    ['federalWages','Federal taxable wages'],
    ['socialSecurityYtd','Social Security wages'],
    ['medicareYtd','Medicare wages'],
    ['supplementalYtd','Federal taxable supplemental pay'],
    ['futaYtd','FUTA covered wages'],
    ['sutaYtd','State UI covered wages']
  ];
  const money = amount => Math.round((amount + Number.EPSILON) * 100) / 100;
  const hasAmount = amount => Number.isFinite(amount);
  let session;

  function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content != null) node.textContent = content;
    if (className) node.className = className;
    return node;
  }

  function button(label, handler, variant = 'outline') {
    const node = element('button', label, variant);
    node.type = 'button';
    if (handler) node.addEventListener('click', handler);
    return node;
  }

  function field(name, label, options = {}) {
    const wrapper = element('div', '', 'field payroll-tax-field');
    const caption = element('label', label);
    const input = element(options.choices ? 'select' : 'input');
    input.name = name;
    input.id = 'payroll-tax-' + name;
    caption.htmlFor = input.id;
    if (options.choices) {
      input.replaceChildren(...options.choices.map(([value, text]) => new Option(text, value)));
    } else {
      input.type = options.type || 'number';
      if (input.type === 'number') {
        input.min = options.min ?? 0;
        input.max = options.max ?? 100000000;
        input.step = options.step ?? '0.01';
      }
      if (input.type === 'text') input.maxLength = options.maxLength ?? 100;
      if (input.type === 'url') {
        input.maxLength = 400;
        input.pattern = 'https://[^\\s]+';
      }
      if (input.type === 'date') {
        input.min = '2020-01-01';
        input.max = '2100-12-31';
      }
    }
    input.required = options.required ?? input.type !== 'checkbox';
    if (input.type === 'checkbox') input.checked = Boolean(options.value);
    else input.value = options.value ?? '';
    wrapper.append(caption, input);
    return wrapper;
  }

  function grid(...fields) {
    const node = element('div', '', 'payroll-tax-grid');
    node.append(...fields);
    return node;
  }

  function fieldset(label, ...children) {
    const node = element('fieldset', '', 'payroll-tax-group');
    node.append(element('legend', label), ...children);
    return node;
  }

  function message(content, error = false) {
    status.textContent = content;
    status.classList.toggle('dispatch-form-issues', error);
  }

  function today() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0,10);
  }

  function active(context) {
    return session === context && dialog.open && currentUser === context.user;
  }

  async function request(context, action, date, options = {}) {
    const { data, error } = await supabaseClient.rpc('payroll_tax_profile', {
      action, target_fleet:context.fleet, target_kind:context.kind, target_reference:context.reference,
      as_of:date, ...options
    });
    if (error) throw error;
    return data;
  }

  async function checkHistory(context, date, parameters = {}) {
    const { data, error } = await supabaseClient.rpc('payroll_paid_check_history', {
      action:'read', target_fleet:context.fleet, target_kind:context.kind, target_reference:context.reference,
      pay_date:date, ...parameters
    });
    if (error) throw error;
    return data;
  }

  function defaults(date) {
    const year = Number(date.slice(0,4));
    return {
      state:'', periods:52, federalForm:'current', filingStatus:'single', multipleJobs:false, legacyAllowances:0,
      credits:0, otherIncome:0, deductions:0, federalExtra:0, federalExemptYear:year,
      stateTreatment:'regular', stateExemptYear:year, stateExtra:0, locality:'unverified',
      localityName:'', localExtra:0, localTaxes:[], elections:{}
    };
  }

  function electionFields(state, elections) {
    return (payrollTaxRules.baseFields[state] || []).map(([key, label, choices, format]) => field(key, label, {
      choices, value:elections[key] ?? (key === 'azRate' ? 2 : choices ? choices[0][0] : 0),
      step:format === 'percent' ? '0.0001' : format === 'money' ? '0.01' : 1,
      max:format === 'percent' ? 100 : format === 'money' ? 100000000 : 99
    }));
  }

  function localityOptions(state) {
    const options = [['unverified','Needs review'], ['none','No local income tax applies'],
      ['configured','Use saved local taxes']];
    if (state === 'KY') options.push(...Object.entries(payrollTaxRules.kentuckyLocalities).map(([key,[label]]) => [key,label]));
    if (state === 'NY') options.push(['newYorkCity','New York City · resident'],
      ['yonkersResident','Yonkers · resident'], ['yonkersNonresident','Yonkers · nonresident']);
    if (state === 'MD') options.push(...Object.entries(payrollTaxRules.marylandLocalities)
      .map(([key,[name]]) => [key,name]));
    if (state === 'IN') options.push(...payrollTaxRules.indianaCounties.map(([code, name]) => ['in:' + code, name + ' County']));
    if (state === 'OH') options.push(...Object.entries(payrollTaxRules.ohioDistricts)
      .sort(([first],[second]) => first.localeCompare(second))
      .map(([code,[name]]) => ['oh:' + code, code + ' · ' + name]));
    if (state === 'PA') options.push(['philadelphiaResident','Philadelphia · resident'],
      ['philadelphiaNonresident','Philadelphia · nonresident']);
    return options;
  }

  function visible(row, show) {
    row.hidden = !show;
    row.querySelector('input, select').disabled = !show;
  }

  function localTaxFields(onChange) {
    const container = element('div');
    const list = element('div', '', 'payroll-tax-local-list');
    const add = button('Add Local Tax', () => addRow({}));
    let nextId = 0;

    function addRow(tax) {
      const id = 'localTax' + nextId++;
      const name = field(id + 'Name','Local tax name',{ type:'text',value:tax.name });
      const method = field(id + 'Method','Calculation method',{
        choices:[['rate','Percent of local taxable wages'],['fixed','Fixed amount per check']],value:tax.method || 'rate'
      });
      const amount = field(id + 'Amount','Rate (%)',{
        step:'0.0001',max:100,value:tax.value
      });
      const source = field(id + 'Source','Source URL (optional)',{
        type:'url',required:false,value:tax.source
      });
      const remove = button('Remove',() => {
        row.remove();
        add.disabled = false;
        onChange();
      });
      remove.setAttribute('aria-label','Remove local tax');
      const row = element('div', '', 'payroll-tax-local-item');
      row.append(grid(name,method,amount,source),remove);
      const inputs = Object.fromEntries([name,method,amount,source].map(field => {
        const input = field.querySelector('input,select');
        return [input.name.slice(id.length).toLowerCase(),input];
      }));
      row.read = () => ({
        name:inputs.name.value.trim(), method:inputs.method.value,
        value:inputs.amount.valueAsNumber, source:inputs.source.value.trim()
      });
      function configureAmount() {
        const fixed = inputs.method.value === 'fixed';
        amount.querySelector('label').textContent = fixed ? 'Amount per check ($)' : 'Rate (%)';
        inputs.amount.max = fixed ? '100000000' : '100';
        inputs.amount.step = fixed ? '0.01' : '0.0001';
      }
      inputs.method.addEventListener('change',configureAmount);
      configureAmount();
      list.append(row);
      add.disabled = list.children.length >= 12;
      onChange();
    }

    function set(taxes) {
      list.replaceChildren();
      add.disabled = false;
      taxes.forEach(addRow);
      onChange();
    }
    container.append(list,add);
    return { container, set, read:() => Array.from(list.children,row => row.read()) };
  }

  function showSettings(context, date, saved) {
    const settings = { ...defaults(date), ...saved?.settings };
    title.textContent = 'Tax Information';
    const form = element('form');
    const formMode = field('federalForm', 'Federal withholding form', {
      value:settings.federalForm, choices:[
        ['current','Form W-4 (2020 or later)'], ['legacy','Form W-4 (2019 or earlier)'],
        ['exempt','Exempt from federal income tax withholding'], ['special','Special federal treatment · review required']
      ]
    });
    const federalStatus = field('filingStatus', 'Federal filing status', { value:settings.filingStatus, choices:[
      ['single','Single or married filing separately'], ['married','Married filing jointly'], ['head','Head of household']
    ] });
    const multipleJobs = field('multipleJobs','W-4 Step 2(c) multiple jobs box is checked', { type:'checkbox',value:settings.multipleJobs });
    const federalNumbers = [
      ['credits','W-4 Step 3 annual credits'],
      ['otherIncome','W-4 Step 4(a) other income'],
      ['deductions','W-4 Step 4(b) deductions']
    ].map(([key,label]) => field(key,label,{ value:settings[key] }));
    const legacy = field('legacyAllowances', 'Number of allowances (older W-4)', { value:settings.legacyAllowances, step:1,max:99 });
    const federalExtra = field('federalExtra','Federal extra withholding per check', { value:settings.federalExtra });
    const federalYear = field('federalExemptYear','Federal exemption tax year', { value:settings.federalExemptYear,step:1,min:2020,max:2100 });
    const state = field('state','Withholding state', {
      value:settings.state, choices:[['','Select state'], ...Object.entries(payrollTaxRules.states).map(([code,[name]]) => [code,name])]
    });
    const treatment = field('stateTreatment','State withholding treatment', { value:settings.stateTreatment, choices:[
      ['regular','Regular withholding'], ['exempt','Verified state exemption'], ['review','Special state treatment · review required']
    ] });
    const stateYear = field('stateExemptYear','State exemption tax year', { value:settings.stateExemptYear,step:1,min:2020,max:2100 });
    const stateExtra = field('stateExtra','State extra withholding per check', { value:settings.stateExtra });
    const dynamic = grid();
    const stateNotice = element('p', '', 'muted');
    const local = field('locality','Applicable local tax', { choices:localityOptions(settings.state),value:settings.locality });
    const localLabel = field('localityName','Local jurisdiction to review (optional)', {
      value:settings.localityName, type:'text', required:false
    });
    const localExtra = field('localExtra','Additional local withholding per check', { value:settings.localExtra });

    const localLookup = element('p','','muted');
    const localTaxes = localTaxFields(() => {
      if (inputs.locality.value === 'none' && localTaxes.read().length) inputs.locality.value = 'configured';
    });
    const save = button('Save Tax Information', null, 'primary-btn');
    save.type = 'submit';
    const actions = element('div', '', 'dispatch-actions');
    actions.append(save);
    if (context.mode === 'preview') actions.append(button('Back to Estimate', () => showPreview(context,date,saved)));
    const forms = element('section', '', 'payroll-tax-group withholding-forms');

    form.append(
      grid(field('effective','Elections effective on',{ type:'date',value:date }),
        field('periods','Pay frequency',{ choices:Object.entries(payrollTaxRules.periods),value:settings.periods })),
      fieldset('Federal', grid(formMode,federalStatus), multipleJobs, grid(...federalNumbers,legacy,federalExtra,federalYear)),
      fieldset('State', grid(state,treatment,stateYear,stateExtra), dynamic, stateNotice),
      fieldset('County and city', grid(local,localLabel,localExtra),
        localLookup,
        localTaxes.container),
      actions
    );
    body.replaceChildren(
      element('p',context.name,'payroll-tax-person'),
      element('p',saved ? 'Loaded elections effective ' + saved.effective_on + '. Choose the date these settings take effect.'
        : 'Copy the withholding elections from the employee’s current forms.', 'muted'),
      forms,
      form
    );
    if (context.kind !== 'office') {
      const note = element('p','Use the residence jurisdiction for drivers covered by the interstate motor-carrier withholding rule. ','muted');
      const link = element('a','49 U.S.C. § 14503');
      link.href = 'https://uscode.house.gov/us/usc/t49/s14503/';
      link.target = '_blank';
      link.rel = 'noopener';
      note.append(link);
      form.before(note);
    }
    const inputs = form.elements;
    const number = (field, fallback) => inputs[field].disabled ? fallback : inputs[field].valueAsNumber;

    function syncFederal() {
      const mode = inputs.federalForm.value;
      const isCurrent = mode === 'current';
      const isLegacy = mode === 'legacy';
      visible(federalStatus,isCurrent || isLegacy);
      const head = inputs.filingStatus.querySelector('[value="head"]');
      head.disabled = isLegacy;
      if (isLegacy && head.selected) inputs.filingStatus.value = 'single';
      visible(multipleJobs,isCurrent);
      federalNumbers.forEach(row => visible(row,isCurrent));
      visible(legacy,isLegacy);
      visible(federalExtra,isCurrent || isLegacy);
      visible(federalYear,mode === 'exempt');
    }

    void payrollWithholdingForms.mount(forms, () => active(context) && forms.isConnected, context, elections => {
      const exempt = elections.filingStatus === 'exempt';
      inputs.federalForm.value = exempt ? 'exempt' : 'current';
      syncFederal();
      if (exempt) inputs.federalExemptYear.value = elections.exemptYear;
      else {
        inputs.filingStatus.value = elections.filingStatus;
        inputs.multipleJobs.checked = elections.multipleJobs;
        for (const name of ['credits','otherIncome','deductions','federalExtra']) inputs[name].value = elections[name];
      }
      message('Federal elections loaded. Verify them against the signed form and save with the correct effective date.');
      form.scrollIntoView({block:'start'});
    });

    function syncLocal() {
      visible(localLabel,inputs.locality.value === 'unverified');
      const code = inputs.locality.value;
      visible(localExtra,code.startsWith('in:') || code.startsWith('md:') || ['newYorkCity','yonkersResident'].includes(code));
    }

    function syncTreatment() {
      const code = inputs.state.value;
      const hasFormula = Object.hasOwn(payrollTaxRules.sources,code) && code !== 'NH';
      const allowsExempt = hasFormula && code !== 'AZ';
      if (!allowsExempt && inputs.stateTreatment.value === 'exempt') inputs.stateTreatment.value = 'regular';
      const regular = inputs.stateTreatment.value === 'regular';
      visible(stateYear,inputs.stateTreatment.value === 'exempt');
      visible(stateExtra,hasFormula && regular);
      treatment.querySelector('[value="exempt"]').disabled = !allowsExempt;
      const coAllowance = inputs.coAllowance;
      if (coAllowance) visible(coAllowance.parentElement,inputs.coStatus.value === 'certificate');
      if (inputs.iaStatus) {
        const legacy = inputs.iaStatus.value.startsWith('old');
        visible(inputs.iaAllowance.parentElement,!legacy);
        visible(inputs.iaLegacyCount.parentElement,legacy);
      }
      if (inputs.arMethod) {
        const lowIncome = inputs.arMethod.value === 'lowIncome';
        visible(inputs.arExemptions.parentElement,!lowIncome);
        visible(inputs.arLowStatus.parentElement,lowIncome);
        visible(inputs.arLowDependents.parentElement,lowIncome);
      }
    }

    function syncState(reset) {
      const code = inputs.state.value;
      dynamic.replaceChildren(...electionFields(code,reset ? {} : settings.elections));
      inputs.stateTreatment.value = reset ? 'regular' : settings.stateTreatment;
      inputs.stateExtra.value = reset ? '0' : settings.stateExtra;
      inputs.locality.replaceChildren(...localityOptions(code).map(([key,label]) => new Option(label,key)));
      inputs.locality.value = reset ? 'unverified' : settings.locality;
      inputs.localityName.value = reset ? '' : settings.localityName;
      inputs.localExtra.value = reset ? '0' : settings.localExtra;
      localTaxes.set(reset ? [] : settings.localTaxes);
      localLookup.replaceChildren();
      if (code === 'IN') localLookup.textContent = 'Use the applicable Indiana county as of January 1.';
      if (code === 'OH') {
        const finder = element('a','Ohio school district lookup');
        finder.href = payrollTaxRules.sources.ohioFinder;
        finder.target = '_blank';
        finder.rel = 'noopener';
        localLookup.append(finder);
      }
      stateNotice.textContent = '';
      if (code) {
        const link = element('a','Official withholding guidance');
        link.href = payrollTaxRules.sources[code] || payrollTaxRules.states[code][1];
        link.target = '_blank';
        link.rel = 'noopener';
        if (!payrollTaxRules.covers(code)) stateNotice.append('Automatic calculation needs review for this state. ');
        stateNotice.append(link);
      }
      syncLocal();
      syncTreatment();
    }

    inputs.federalForm.addEventListener('change',syncFederal);
    inputs.state.addEventListener('change',() => syncState(true));
    inputs.stateTreatment.addEventListener('change',syncTreatment);
    dynamic.addEventListener('change',syncTreatment);
    inputs.locality.addEventListener('change',syncLocal);
    syncFederal();
    syncState(false);
    form.addEventListener('submit',async event => {
      event.preventDefault();
      if (!active(context) || save.disabled) return;
      const effective = inputs.effective.value;
      const federalForm = inputs.federalForm.value;
      const elections = Object.fromEntries((payrollTaxRules.baseFields[inputs.state.value] || []).map(([key,,choices]) => [
        key, typeof choices?.[0]?.[0] === 'string' ? inputs[key].value : Number(inputs[key].value)
      ]));
      const savedLocalTaxes = localTaxes.read();
      if (inputs.locality.value === 'configured' && !savedLocalTaxes.length ||
        inputs.locality.value === 'none' && savedLocalTaxes.length) {
        message('Choose a local tax option that matches the saved local taxes.',true);
        return;
      }
      const payload = {
        state:inputs.state.value, periods:Number(inputs.periods.value), federalForm,
        filingStatus:inputs.filingStatus.disabled ? 'single' : inputs.filingStatus.value,
        multipleJobs:!inputs.multipleJobs.disabled && inputs.multipleJobs.checked,
        legacyAllowances:number('legacyAllowances',0),
        credits:number('credits',0), otherIncome:number('otherIncome',0), deductions:number('deductions',0),
        federalExtra:number('federalExtra',0), federalExemptYear:number('federalExemptYear',Number(effective.slice(0,4))),
        stateTreatment:inputs.stateTreatment.value, stateExemptYear:number('stateExemptYear',Number(effective.slice(0,4))),
        stateExtra:number('stateExtra',0), locality:inputs.locality.value,
        localityName:inputs.localityName.disabled ? '' : inputs.localityName.value.trim(),
        localExtra:number('localExtra',0), localTaxes:savedLocalTaxes, elections
      };
      save.disabled = true;
      message('Saving…');
      try {
        const record = await request(context,'save',effective,{
          settings:payload, expected_revision:saved?.effective_on === effective ? saved.revision : null
        });
        if (!active(context)) return;
        context.saved = record;
        if (context.mode === 'preview') {
          await loadPreview(context,date);
          if (active(context)) message('Tax information saved effective ' + effective + '.');
        } else {
          showSettings(context,effective,record);
          message('Tax information saved effective ' + effective + '.');
        }
      } catch (error) {
        if (active(context)) message(error.message || 'Could not save tax information.',true);
      } finally {
        save.disabled = false;
      }
    });
  }

  function estimateRows(rows) {
    return rows.map(({ name, amount, source }) => {
      const term = element('dt', name);
      if (source) {
        const link = element('a','Source');
        link.href = source;
        link.target = '_blank';
        link.rel = 'noopener';
        link.setAttribute('aria-label',name + ' source');
        term.append(' ',link);
      }
      return [term,element('dd',amount === null ? 'Needs review' : currency.format(amount))];
    }).flat();
  }

  function estimateSection(label,rows) {
    const list = element('dl','','payroll-tax-results');
    list.append(...estimateRows(rows));
    return [element('h3',label),list];
  }

  function ytdSection(totals, year, state) {
    const rows = historyFields.filter(([key]) => hasAmount(totals[key])).map(([key,name]) => ({
      name:key === 'sutaYtd' && state ? name + ' · ' + state : name, amount:totals[key]
    }));
    if (hasAmount(totals.gross) && hasAmount(totals.deductions)) {
      rows.splice(2,0,{name:'Net pay',amount:money(totals.gross - totals.deductions)});
    }
    const section = element('section');
    if (rows.length) section.append(...estimateSection('Year to Date · ' + year,rows));
    else section.append(element('h3','Year to Date · ' + year),
      element('p','No verified payroll totals are available for this pay year.'));
    return section;
  }

  function statementLoadTable(loads) {
    const table = element('table','','payroll-statement-loads');
    const labels = ['PRO','Delivered','Origin','Destination','Load pay'];
    table.setAttribute('role','table');
    const header = table.createTHead();
    header.setAttribute('role','rowgroup');
    const head = header.insertRow();
    head.setAttribute('role','row');
    for (const caption of labels) {
      const cell = element('th',caption);
      cell.scope = 'col';
      cell.setAttribute('role','columnheader');
      head.append(cell);
    }
    const body = table.createTBody();
    body.setAttribute('role','rowgroup');
    for (const load of loads) {
      const row = body.insertRow();
      row.setAttribute('role','row');
      const values = [load.pro,load.delivered || '—',load.origin,load.destination,
        hasAmount(load.pay) ? currency.format(load.pay) : '—'];
      values.forEach((value,index) => {
        const cell = row.insertCell();
        cell.setAttribute('role','cell');
        if (index) {
          const label = element('span',labels[index],'payroll-load-label');
          label.setAttribute('aria-hidden','true');
          cell.append(label);
        }
        cell.append(element('span',value));
      });
      if (load.hasBol === false) {
        row.dataset.missingBol = 'true';
        row.cells[0].append(element('strong','Signed BOL missing','settlement-missing-bol'));
      }
    }
    return table;
  }

  function statementPages(name, date, details, amounts, totals, state, paid) {
    const statement = element('section','','payroll-statement');
    const loads = Array.isArray(details.loads) ? details.loads : [];
    const firstPageLimit = 8;
    const continuationLimit = 16;
    const continuationPages = [];
    for (let index = firstPageLimit; index < loads.length; index += continuationLimit) {
      continuationPages.push(loads.slice(index,index+continuationLimit));
    }
    const pageCount = 2 + continuationPages.length;
    function sheet(page, heading) {
      const section = element('article','','payroll-statement-page');
      const label = paid ? 'Paid settlement' : details.draft ? 'Draft settlement' : 'Settlement estimate';
      section.append(element('p','RigTracker Pro · ' + label + ' · Page ' + page + ' of ' + pageCount,'payroll-statement-kicker'),element('h2',heading),
        element('p',[name,date].join(' · '),'payroll-statement-identity'));
      if (details.payPeriod) section.append(element('p','Pay period ' + details.payPeriod,'payroll-statement-identity'));
      return section;
    }
    const pay = sheet(1,'Pay Information');
    const hours = element('dl','','payroll-tax-results');
    for (const [label,value] of [
      ['Hours worked',hasAmount(details.hours) ? details.hours.toLocaleString('en-US') : ''],
      ['Hourly rate',hasAmount(details.hourlyRate) ? currency.format(details.hourlyRate) : '']
    ]) {
      if (value) hours.append(element('dt',label),element('dd',value));
    }
    if (hours.children.length) pay.append(hours);
    if (loads.length) {
      pay.append(element('h3','Loads in this statement'),statementLoadTable(loads.slice(0,firstPageLimit)));
    }
    const additionalLoadPay = new Map();
    for (const load of loads) {
      for (const item of load.otherPay || []) {
        additionalLoadPay.set(item.name,money((additionalLoadPay.get(item.name) || 0) + item.amount));
      }
    }
    if (additionalLoadPay.size) pay.append(...estimateSection('Included in load pay',
      [...additionalLoadPay].map(([name,amount]) => ({name,amount}))));
    if (details.draft && details.lumperTotal>0) pay.append(...estimateSection('Reimbursement to review',[
      {name:'Driver-paid lumper fee',amount:details.lumperTotal}
    ]));
    pay.append(...estimateSection('Earnings and reimbursements',[
      ...(details.earnings || []),{name:'Gross pay',amount:amounts.gross}
    ]),...estimateSection('Deductions',[
      ...(details.deductions || []),{name:'Employee taxes',amount:details.taxTotal},
      {name:'Total taxes and deductions',amount:amounts.deductions}
    ]));

    const taxes = sheet(pageCount,'Taxes and Net Pay');
    taxes.append(...estimateSection('Taxable wages',[
      {name:'Federal taxable wages',amount:amounts.federalWages},
      {name:'Social Security wages',amount:amounts.socialSecurityYtd},
      {name:'Medicare wages',amount:amounts.medicareYtd}
    ]),...estimateSection('Employee taxes',details.taxes || []));
    taxes.append(hasAmount(amounts.deductions)
      ? element('strong','Net pay ' + currency.format(money(amounts.gross - amounts.deductions)),'payroll-statement-net')
      : element('p',details.draft ? 'Estimate payroll taxes to calculate net pay.'
        : 'Net pay requires a confirmed amount for each tax marked Needs review.','muted'));
    const ytd = ytdSection(totals,date.slice(0,4),state);
    if (!paid) ytd.append(element('p',details.draft ? 'Confirmed payroll before this draft.'
      : 'Projected totals through this check.','muted'));
    taxes.append(ytd);
    statement.append(pay,...continuationPages.map((loads,index) => {
      const page = sheet(index+2,'Loads in this Statement');
      page.append(statementLoadTable(loads));
      return page;
    }),taxes);
    return statement;
  }

  function printStatement(statement) {
    const copy = statement.cloneNode(true);
    copy.id = 'payrollStatementPrint';
    document.body.append(copy);
    document.body.classList.add('printing-payroll-statement');
    function cleanup() {
      copy.remove();
      document.body.classList.remove('printing-payroll-statement');
    }
    window.addEventListener('afterprint',cleanup,{once:true});
    window.print();
  }

  async function showSettlementYtd(container,context) {
    const date = today();
    try {
      const history = await checkHistory(context,date);
      if (!container.isConnected || context.user !== currentUser) return;
      if (history.paid_on) {
        const statement = statementPages(context.name,history.paid_on,{...history.statement,payPeriod:context.payPeriod,loads:context.loads ?? history.statement.loads},
          history.amounts,history.through,history.ui_state,true);
        container.replaceChildren(statement,button('Print / Save as PDF',() => printStatement(statement)));
        return;
      }
      const draft = statementPages(context.name,date,{
        draft:true,loads:context.loads,taxTotal:null,lumperTotal:context.lumperReimbursement,payPeriod:context.payPeriod
      },{
        gross:context.gross == null ? null : Number(context.gross),deductions:null,
        federalWages:null,socialSecurityYtd:null,medicareYtd:null
      },history.before,null,false);
      container.replaceChildren(draft);
    } catch {
      if (container.isConnected && context.user === currentUser) {
        container.textContent = 'Year-to-date payroll is temporarily unavailable.';
      }
    }
  }

  function estimateEntries(label,addLabel,idPrefix,createEntry,onChange) {
    const details = element('details','','payroll-tax-group');
    const list = element('div','','payroll-tax-local-list');
    const entries = new Map();
    let nextId = 0;
    const add = button('Add ' + addLabel,() => {
      const entry = createEntry(idPrefix + nextId++);
      const row = element('div','','payroll-tax-local-item');
      const remove = button('Remove',() => {
        entries.delete(row);
        row.remove();
        add.focus();
        onChange();
      });
      remove.setAttribute('aria-label','Remove ' + addLabel.toLowerCase());
      entries.set(row,entry.read);
      row.append(entry.content,remove);
      list.append(row);
      row.querySelector('select,input').focus();
      onChange();
    });
    details.addEventListener('invalid',() => { details.open = true; },true);
    details.append(element('summary',label),list,add);
    return { details, read:() => [...entries.values()].map(read => read()) };
  }

  function estimateAmount(id,wagesLabel) {
    const method = field(id + 'Method','Calculation method',{
      value:'fixed',choices:[['fixed','Dollar amount'],['rate','Percentage']]
    });
    const fixed = field(id + 'Fixed','Amount for this check ($)');
    const rate = field(id + 'Rate','Rate (%)',{max:100,step:'0.0001'});
    const wages = field(id + 'Wages',wagesLabel);
    const methodInput = method.querySelector('select');
    const value = field => field.querySelector('input').valueAsNumber;
    function sync() {
      const percent = methodInput.value === 'rate';
      visible(fixed,!percent);
      visible(rate,percent);
      visible(wages,percent);
    }
    methodInput.addEventListener('change',sync);
    sync();
    return {fields:[method,fixed,rate,wages], read:() => methodInput.value === 'rate'
      ? payrollTaxRules.percentOfWages(value(wages),value(rate)) : value(fixed)};
  }

  function otherTaxFields(onChange) {
    const choices = [
      'City tax','County tax','School district tax','State disability insurance',
      'Paid family or medical leave','Employee unemployment insurance','Transit tax','Other tax'
    ].map(name => [name,name]);
    choices.unshift(['','Choose a tax']);
    const entries = estimateEntries('Other taxes (optional)','Tax','otherTax',id => {
      const category = field(id + 'Category','Tax type',{choices});
      const name = field(id + 'Name','Name or jurisdiction (optional)',{type:'text',required:false});
      const amount = estimateAmount(id,'Taxable wages after any cap ($)');
      const categoryInput = category.querySelector('select');
      const nameInput = name.querySelector('input');
      categoryInput.addEventListener('change',() => {
        nameInput.required = categoryInput.value === 'Other tax';
        name.querySelector('label').textContent = nameInput.required ? 'Tax name' : 'Name or jurisdiction (optional)';
      });
      return {content:grid(category,name,...amount.fields),read:() => {
        const description = nameInput.value.trim();
        if (nameInput.required && !description) throw new Error('Enter a name for the other tax.');
        return {name:description || categoryInput.value,amount:amount.read()};
      }};
    },onChange);
    entries.details.querySelector('summary').after(
      field('reviewedLocal','Local withholding (if marked Needs review)',{required:false}));
    return entries;
  }

  function payrollDeductionFields(onChange) {
    const bases = [
      ['Federal income tax',['federalWages']], ['Social Security and Medicare',['socialSecurityWages','medicareWages']],
      ['State income tax',['stateWages']], ['Local income tax',['localWages']],
      ['Federal unemployment',['futaWages']], ['State unemployment',['sutaWages']]
    ];
    return estimateEntries('Payroll deductions (optional)','Deduction','payDeduction',id => {
      const name = field(id + 'Name','Deduction name',{type:'text'});
      const amount = estimateAmount(id,'Wages for this percentage ($)');
      const preTax = field(id + 'PreTax','Pre-tax deduction',{type:'checkbox'});
      const toggle = preTax.querySelector('input');
      const choices = bases.map(([label],index) => field(id + 'Base' + index,label,{type:'checkbox'}));
      const eligible = fieldset('Wage bases reduced by this deduction',grid(...choices));
      const refresh = () => {
        eligible.hidden = !toggle.checked;
        eligible.disabled = !toggle.checked;
      };
      toggle.addEventListener('change',refresh);
      refresh();
      return {content:grid(name,...amount.fields,preTax,eligible),read:() => {
        const description = name.querySelector('input').value.trim();
        if (!description) throw new Error('Enter a name for each payroll deduction.');
        const reduces = toggle.checked ? bases.flatMap(([,keys],index) => choices[index].querySelector('input').checked ? keys : []) : [];
        if (toggle.checked && !reduces.length) throw new Error('Choose the wage bases reduced by ' + description + '.');
        return {name:description,amount:amount.read(),reduces};
      }};
    },onChange);
  }

  function payItemFields(onChange,importedSupplemental) {
    const choices = [['','Choose a pay type'],['bonus','Bonus'],['commission','Commission'],
      ['overtimeRegular','Overtime pay (regular withholding)'],['overtime','Overtime pay (supplemental withholding)'],
      ['taxableReimbursement','Taxable reimbursement'],['accountableReimbursement','Qualified accountable-plan reimbursement'],
      ['otherRegular','Other regular taxable pay'],['otherSupplemental','Other supplemental pay']];
    const setup = element('div');
    const method = field('supplementalMethod','Federal withholding on supplemental pay',{
      value:'aggregate',choices:[['aggregate','Regular withholding tables'],['flat','Federal supplemental rates (22% / 37%)'],
        ['review','Enter verified federal withholding']]
    });
    const separate = field('supplementalSeparate','Supplemental pay issued on a separate check',{type:'checkbox'});
    const confirmed = field('supplementalConfirmed','Federal income tax was withheld from regular wages this year or last year',{type:'checkbox'});
    const ytd = field('supplementalYtd','YTD federal taxable supplemental pay before this check ($)');
    const taxable = field('supplementalTaxable','Federal taxable supplemental pay on this check (optional)',{required:false});
    const priorWages = field('supplementalPriorWages','Previously paid federal taxable wages used in this calculation ($)',{required:false});
    const priorWithheld = field('supplementalPriorWithheld','Federal income tax already withheld on those wages ($)',{required:false});
    const methodInput = method.querySelector('select');
    const separateInput = separate.querySelector('input');
    function sync() {
      setup.hidden = !importedSupplemental() && !entries.read().some(item => payrollTaxDeductions.isSupplemental(item.type));
      const manual = methodInput.value === 'review';
      visible(method,!setup.hidden);
      visible(separate,!setup.hidden);
      visible(ytd,!setup.hidden && !manual);
      visible(taxable,!setup.hidden);
      visible(confirmed,!setup.hidden && methodInput.value === 'flat');
      const prior = !setup.hidden && separateInput.checked && methodInput.value === 'aggregate';
      visible(priorWages,prior);
      visible(priorWithheld,prior);
    }
    const entries = estimateEntries('Pay items (optional)','Pay Item','payItem',id => {
      const type = field(id + 'Type','Pay type',{choices});
      const amount = field(id + 'Amount','Pay amount ($)');
      const select = type.querySelector('select');
      select.addEventListener('change',sync);
      return {content:grid(type,amount),read:() => ({type:select.value,name:select.selectedOptions[0].textContent,
        amount:amount.querySelector('input').valueAsNumber})};
    },() => {
      sync();
      onChange();
    });
    methodInput.addEventListener('change',sync);
    separateInput.addEventListener('change',sync);
    setup.append(grid(method,separate,ytd,taxable,confirmed,priorWages,priorWithheld));
    entries.details.append(setup);
    sync();
    return {...entries,sync,supplemental:pay => pay.supplementalGross ? {
      gross:pay.supplementalGross,taxableGross:pay.taxableGross,method:methodInput.value,separate:separateInput.checked,
      ytd:ytd.querySelector('input').valueAsNumber,taxable:taxable.querySelector('input').valueAsNumber,
      priorWages:priorWages.querySelector('input').valueAsNumber,priorWithheld:priorWithheld.querySelector('input').valueAsNumber,
      regularWithholding:confirmed.querySelector('input').checked
    } : null};
  }

  function unemploymentFields(state,year) {
    const details = element('details','','payroll-tax-group');
    const selector = field('sutaState','State where unemployment wages are reported',{
      value:state,required:false,choices:[['','Select state'],...Object.entries(payrollTaxRules.states)
        .sort((a,b) => a[1][0].localeCompare(b[1][0])).map(([code,[name]]) => [code,name])]
    });
    const wageBase = field('sutaWageBase','Confirmed state annual wage base (if different or required)',{required:false});
    const note = element('p','','muted');
    const select = selector.querySelector('select');
    function syncBase() {
      const base = payrollTaxDeductions.stateWageBase(select.value,year);
      const input = wageBase.querySelector('input');
      input.value = '';
      if (Number.isFinite(base)) note.textContent = 'Published state wage base ' + currency.format(base) + '.';
      else if (Array.isArray(base)) note.textContent = 'The state uses different wage bases by employer account (' +
        base.map(amount => currency.format(amount)).join(' or ') + '). Enter the base that applies.';
      else note.textContent = 'Enter the confirmed state wage base for this pay year.';
    }
    select.addEventListener('change',syncBase);
    syncBase();
    details.append(element('summary','Employer unemployment (optional)'),
      element('p','Enter confirmed employer rates and year-to-date covered wages. Amounts stay outside employee deductions.','muted'),
      grid(field('futaWages','FUTA covered wages this check (optional override)',{required:false}),
        field('futaYtd','YTD FUTA covered wages before this check',{required:false}),
        field('futaRate','Effective FUTA rate (%)',{step:'0.0001',max:6,required:false})),
      grid(selector,wageBase),note,
      grid(field('sutaWages','State UI covered wages this check (optional override)',{required:false}),
        field('sutaYtd','YTD state UI covered wages before this check',{required:false}),
        field('sutaRate','Assigned state UI rate (%)',{step:'0.0001',max:100,required:false})));
    return details;
  }

  function garnishmentFields() {
    const details = element('details','','payroll-tax-group');
    const category = field('garnishmentCategory','Garnishment calculation',{
      value:'reviewed',choices:[['reviewed','Amount verified by payroll'],['ordinary','Ordinary debt · check federal limit'],
        ['support','Child support or alimony · check federal limit']]
    });
    const disposable = field('disposablePay','Disposable earnings after deductions required by law',{required:false});
    const stateMax = field('stateGarnishmentMax','Stricter verified state limit (if applicable)',{required:false});
    const otherFamily = field('garnishmentOtherFamily','Employee supports another spouse or child',{type:'checkbox'});
    const overdue = field('garnishmentOverdue','This support is more than 12 weeks in arrears',{type:'checkbox'});
    const select = category.querySelector('select');
    function syncCategory() {
      const compare = select.value !== 'reviewed';
      visible(disposable,compare);
      visible(stateMax,compare);
      visible(otherFamily,select.value === 'support');
      visible(overdue,select.value === 'support');
    }
    select.addEventListener('change',syncCategory);
    syncCategory();
    details.append(element('summary','Garnishment (optional)'),
      element('p','Enter the ordered deduction that applies to this check. For a federal limit check, use disposable earnings and confirm any lower state limit.','muted'),
      grid(field('garnishment','Reviewed garnishment amount',{required:false}),category,disposable,stateMax,otherFamily,overdue));
    return details;
  }

  function estimateUnemployment(form,wageBases,year) {
    const value = key => form.elements[key].valueAsNumber;
    const state = form.elements.sutaState.value;
    const deductions = [];
    const groups = [
      ['futa','Federal unemployment',year === 2026 ? 7000 : undefined,payrollTaxDeductions.sources.federalUnemployment],
      ['suta','State unemployment · ' + state,payrollTaxDeductions.stateWageBase(state,year),payrollTaxDeductions.sources.stateUnemployment]
    ];
    for (const [prefix,name,publishedBase,source] of groups) {
      const wages = value(prefix + 'Wages');
      const ytd = value(prefix + 'Ytd');
      const rate = value(prefix + 'Rate');
      const override = prefix === 'suta' ? value('sutaWageBase') : NaN;
      if ([wages,rate,override].every(Number.isNaN)) continue;
      if (prefix === 'suta' && !state) throw new Error('Select the state where unemployment wages are reported.');
      const base = Number.isFinite(override) ? override : publishedBase;
      if (!Number.isFinite(base)) throw new Error('Choose the confirmed unemployment wage base for this pay date and employer account.');
      const covered = Number.isNaN(wages) ? wageBases[prefix + 'Wages'] : wages;
      deductions.push({name,amount:payrollTaxDeductions.unemployment(covered,ytd,base,rate),source});
    }
    return deductions;
  }

  function estimateGarnishment(form,periods) {
    const inputs = form.elements;
    const amount = inputs.garnishment.valueAsNumber;
    if (!Number.isFinite(amount)) return null;
    const category = inputs.garnishmentCategory.value;
    if (category === 'reviewed') return {name:'Reviewed garnishment',amount};
    const limit = payrollTaxDeductions.federalGarnishmentLimit(periods,inputs.disposablePay.valueAsNumber,category,
      inputs.garnishmentOtherFamily.checked,inputs.garnishmentOverdue.checked);
    const stateMax = inputs.stateGarnishmentMax.valueAsNumber;
    const maximum = Number.isNaN(stateMax) ? limit : Math.min(limit,stateMax);
    if (amount > maximum) throw new Error('The entered garnishment exceeds the limit for this check (' + currency.format(maximum) + ').');
    return {name:'Reviewed garnishment',amount,source:payrollTaxDeductions.sources.garnishment};
  }

  function showPreview(context,date,saved) {
    title.textContent = 'Payroll Tax Estimate';
    const payDate = field('payDate','Pay date',{ type:'date',value:date });
    const payDateInput = payDate.querySelector('input');
    const summary = saved ? [payrollTaxRules.states[saved.settings.state][0],
      payrollTaxRules.periods[saved.settings.periods],'Elections effective ' + saved.effective_on].join(' · ')
      : 'No tax elections are saved for this pay date.';
    const edit = button(saved ? 'Edit Tax Information' : 'Set Up Tax Information',() => {
      message('');
      showSettings(context,date,saved);
    });
    const actions = element('div','','office-payroll-actions');
    actions.append(edit,payrollTaxUpdates.buttonFor(context.fleet));
    body.replaceChildren(element('p',context.name,'payroll-tax-person'),grid(payDate),element('p',summary,'muted'),actions);
    payDateInput.addEventListener('change', event => {
      if (event.target.value && event.target.checkValidity()) void loadPreview(context,event.target.value);
    });
    if (!saved) return;
    if (saved.settings.stateTreatment === 'regular' &&
      !payrollTaxRules.hasStateElections(saved.settings.state,saved.settings.elections)) {
      body.append(element('p','Open Tax Information to save the state withholding elections.','muted'));
    }

    const form = element('form');
    const amount = field('grossPay','Regular gross pay',{ value:context.gross });
    const lumperTotal = context.lumperReimbursement || 0;
    const lumperTreatment = lumperTotal > 0 ? field('lumperTreatment',
      'Tax treatment for ' + currency.format(lumperTotal) + ' lumper reimbursement',{
      choices:[['','Choose tax treatment'],['accountableReimbursement','Qualified accountable-plan reimbursement'],
        ['taxableReimbursement','Taxable reimbursement']]
    }) : null;
    const hours = field('workedHours','Hours worked (optional)',{required:false,max:1000});
    const rate = field('hourlyRate','Hourly rate (optional)',{required:false});
    const useHours = button('Use Hours × Rate',() => {
      if (!form.elements.workedHours.reportValidity() || !form.elements.hourlyRate.reportValidity()) return;
      const payHours = form.elements.workedHours.valueAsNumber;
      const hourlyRate = form.elements.hourlyRate.valueAsNumber;
      if (!hasAmount(payHours) || !hasAmount(hourlyRate)) {
        message('Enter hours worked and the hourly rate.',true);
        return;
      }
      form.elements.grossPay.value = money(payHours * hourlyRate).toFixed(2);
      context.gross = form.elements.grossPay.value;
      clearResult();
    });
    const checkFields = fieldset('Hours and rate (optional)',grid(hours,rate),useHours);
    const reference = context.kind === 'office'
      ? field('paymentReference','Payment reference',{type:'text',required:false}) : null;
    const historyNote = element('p','','muted');
    historyNote.setAttribute('role','status');
    const historyControls = fieldset('Paid check history',...(reference ? [reference] : []),historyNote);
    const foundingTotals = element('details','','payroll-tax-group');
    foundingTotals.append(element('summary','Year-to-date pay before this check'),
      element('p','Enter verified totals from earlier payroll. Use zero if this is the first check of the calendar year.','muted'),
      grid(...historyFields.slice(0,3).map(([key,label]) => field(key + 'Prior','Prior YTD ' + label.toLowerCase(),
        {required:false}))));
    let history;
    let historyRequest;
    let recording = false;
    const automatic = new Map();
    const tracked = historyFields.map(([key]) => [key,key === 'gross' || key === 'deductions' ||
      key === 'federalWages' ? key + 'Prior' : key]);
    const paymentRef = () => reference?.querySelector('input').value.trim() || null;
    const wageDetails = element('details', '', 'payroll-tax-group');
    const wages = wageBases.map(([key,label]) => field(key,label + ' (optional override)', { required:false }));
    const savedLocalTaxes = saved.settings.localTaxes || [];
    const localWages = savedLocalTaxes.flatMap((tax,index) => tax.method === 'rate'
      ? [field('localTaxWages' + index,tax.name + ' taxable wages (optional)',{ required:false })] : []);
    wageDetails.append(element('summary','Adjust taxable wages by jurisdiction'),
      element('p','Enter final taxable wages after any pre-tax deductions to override the calculated amounts.','muted'),
      grid(...wages,...localWages));
    const periodStart = ['UT','IN'].includes(saved.settings.state) ? field('periodStartsOn','Pay period starts on',{
      type:'date',required:false
    }) : null;
    const massachusettsDeduction = saved.settings.state === 'MA' ? field('maContributions',
      'Massachusetts eligible payroll contributions this check (after $2,000 annual limit)',{
        max:2000,required:false
      }) : null;
    const reviewedIncome = element('details','','payroll-tax-group');
    reviewedIncome.append(element('summary','Enter reviewed income tax'),
      grid(field('reviewedFederal','Federal withholding (if marked Needs review)',{required:false}),
        field('reviewedState','State withholding (if marked Needs review)',{required:false})));
    const result = element('section');
    result.setAttribute('aria-live','polite');
    const calculate = button('Calculate Estimate',null,'primary-btn');
    calculate.type = 'submit';
    function clearResult() {
      result.replaceChildren();
      message('');
    }
    const lumperSelect = lumperTreatment?.querySelector('select');
    const payItems = payItemFields(clearResult,() => lumperSelect?.value === 'taxableReimbursement');
    lumperSelect?.addEventListener('change',payItems.sync);
    const payrollDeductions = payrollDeductionFields(clearResult);
    const otherTaxes = otherTaxFields(clearResult);
    const year = Number(date.slice(0,4));
    form.append(element('p','Estimate for W-2 pay. Enter only confirmed deductions and taxable wages.', 'muted'),
      ...(context.kind === 'settlement' ? [element('p',context.gross != null
        ? 'The settlement total is prefilled. If you itemize pay below, enter just the regular portion in Regular gross pay.'
        : 'Enter verified regular gross pay or use the hours and rate for an hourly driver.','muted')] : []),
      grid(amount,...(periodStart ? [periodStart] : []),...(massachusettsDeduction ? [massachusettsDeduction] : []),field('socialSecurityYtd','YTD Social Security wages before this check'),
        field('medicareYtd','YTD Medicare wages before this check')),
      checkFields,...(lumperTreatment ? [lumperTreatment] : []),foundingTotals,payItems.details,payrollDeductions.details,wageDetails,reviewedIncome,otherTaxes.details,
      garnishmentFields(),unemploymentFields(saved.settings.state,year),calculate);
    body.append(historyControls,form,result);

    function showPaid(record) {
      form.hidden = true;
      payDateInput.value = record.paid_on;
      payDateInput.disabled = context.kind === 'settlement';
      historyNote.textContent = 'Paid check recorded on ' + record.paid_on + '.';
      const statement = statementPages(context.name,record.paid_on,{...record.statement,payPeriod:context.payPeriod,loads:context.loads ?? record.statement.loads},
        record.amounts,record.through,record.ui_state,true);
      result.replaceChildren(statement,button('Print / Save as PDF',() => printStatement(statement)));
    }

    async function refreshHistory({resetState=false} = {}) {
      const token = {};
      historyRequest = token;
      history = null;
      const state = form.elements.sutaState.value || null;
      const ref = paymentRef();
      if (resetState) {
        form.elements.sutaYtd.value = '';
        form.elements.sutaWages.value = '';
        form.elements.sutaRate.value = '';
        automatic.delete('sutaYtd');
      }
      historyNote.textContent = 'Loading paid-check totals…';
      try {
        const record = await checkHistory(context,date,{state_ui:state,payment_reference:ref});
        if (!active(context) || !form.isConnected || historyRequest !== token) return;
        history = { ...record, ref, state };
        if (record.paid_on) {
          showPaid(record);
          return;
        }
        form.hidden = false;
        payDateInput.value = date;
        let filled = false;
        for (const [key,name] of tracked) {
          const input = form.elements[name];
          if (input.value && input.value !== automatic.get(key)) continue;
          input.value = hasAmount(record.before[key]) ? record.before[key].toFixed(2) : '';
          automatic.set(key,input.value);
          filled ||= Boolean(input.value);
        }
        historyNote.textContent = filled ? 'Year-to-date amounts loaded from paid checks.'
          : 'Enter verified year-to-date amounts to start tracking this pay year.';
      } catch {
        if (active(context) && form.isConnected && historyRequest === token) {
          historyNote.textContent = 'Paid-check history is unavailable. You can still enter verified amounts for an estimate.';
        }
      }
    }

    reference?.addEventListener('change',() => {
      clearResult();
      void refreshHistory();
    });
    form.elements.sutaState.addEventListener('change',() => void refreshHistory({resetState:true}));
    void refreshHistory();
    form.addEventListener('input',() => {
      context.gross = form.elements.grossPay.value;
      clearResult();
    });
    form.addEventListener('submit',event => {
      event.preventDefault();
      if (!active(context) || recording || form.hidden) return;
      if (payDateInput.value !== date) {
        message('Choose a valid pay date before calculating.',true);
        return;
      }
      const value = key => form.elements[key].valueAsNumber;
      try {
        const earnings = payItems.read();
        if (lumperTreatment) earnings.push({
          type:form.elements.lumperTreatment.value,name:'Lumper reimbursement',amount:lumperTotal
        });
        const deductions = payrollDeductions.read();
        const pay = payrollTaxDeductions.payAmounts(value('grossPay'),earnings,deductions);
        const {grossPay} = pay;
        const input = {date,grossPay,periodStartsOn:form.elements.periodStartsOn?.value,
          maContributions:form.elements.maContributions?.valueAsNumber,
          socialSecurityYtd:value('socialSecurityYtd'),medicareYtd:value('medicareYtd'),
          supplemental:payItems.supplemental(pay),reimbursementOnly:grossPay > 0 && pay.taxableGross === 0};
        for (const [key] of wageBases) input[key] = Number.isFinite(value(key)) ? value(key) : pay.wageBases[key];
        input.localTaxWages = savedLocalTaxes.map((tax,index) => tax.method === 'rate' ? value('localTaxWages' + index) : undefined);
        const { employee, employer } = payrollTaxRules.calculate(saved.settings,input);
        for (const [type,key] of [['federal','reviewedFederal'],['state','reviewedState'],['local','reviewedLocal']]) {
          if (Number.isNaN(value(key))) continue;
          const row = employee.find(row => row.type === type);
          if (!row || row.amount !== null) throw new Error('Use a reviewed amount only for a tax marked Needs review.');
          row.name += ' (entered by payroll)';
          row.amount = value(key);
        }
        employee.push(...otherTaxes.read());
        employer.push(...estimateUnemployment(form,pay.wageBases,year));
        const garnishment = estimateGarnishment(form,saved.settings.periods);
        const deductionsForStatement = garnishment ? [...deductions,garnishment] : deductions;
        const taxTotal = employee.every(row => row.amount !== null)
          ? money(employee.reduce((sum,row) => sum + row.amount,0)) : null;
        const subtotal = taxTotal === null ? null
          : money(taxTotal + deductionsForStatement.reduce((sum,row) => sum + row.amount,0));
        const complete = subtotal !== null;
        const statement = {
          ...(Number.isInteger(context.loadCount) ? {loadCount:context.loadCount,lumperTotal} : {}),
          hours:hasAmount(value('workedHours')) ? value('workedHours') : null,
          hourlyRate:hasAmount(value('hourlyRate')) ? value('hourlyRate') : null,
          earnings:[{name:'Regular pay',amount:value('grossPay')},...earnings],
          deductions:deductionsForStatement.map(({name,amount}) => ({name,amount})),
          taxes:employee.filter(row => row.amount !== 0 || row.type !== 'local').map(({name,amount}) => ({name,amount})),
          taxTotal
        };
        const prior = Object.fromEntries(tracked.map(([key,name]) => [key,hasAmount(value(name)) ? value(name) : null]));
        const supplementalTaxable = input.supplemental?.taxable;
        const selectedState = form.elements.sutaState.value || null;
        const state = ['sutaYtd','sutaWages','sutaRate'].some(name => hasAmount(value(name))) ? selectedState : null;
        const current = {
          gross:grossPay,deductions:subtotal,federalWages:input.federalWages,
          socialSecurityYtd:input.socialSecurityWages,medicareYtd:input.medicareWages,
          supplementalYtd:hasAmount(supplementalTaxable) ? supplementalTaxable
            : input.federalWages === pay.taxableGross || !pay.supplementalGross ? pay.supplementalGross : null,
          futaYtd:hasAmount(value('futaWages')) ? value('futaWages') : pay.wageBases.futaWages,
          sutaYtd:state ? (hasAmount(value('sutaWages')) ? value('sutaWages') : pay.wageBases.sutaWages) : null
        };
        const projected = Object.fromEntries(historyFields.map(([key]) => [key,
          hasAmount(prior[key]) && hasAmount(current[key]) ? money(prior[key] + current[key]) : null]));
        const report = statementPages(context.name,date,{...statement,payPeriod:context.payPeriod,loads:context.loads},current,projected,state,false);
        const statementPreview = element('details','','payroll-tax-group');
        statementPreview.append(element('summary','Statement preview'),report,
          button('Print / Save as PDF',() => printStatement(report)));
        employee.push(...deductionsForStatement);
        const isMainTax = row => ['federal','fica','state'].includes(row.type);
        const additional = employee.filter(row => !isMainTax(row) &&
          !(row.type === 'local' && saved.settings.locality === 'none' && row.amount === 0));
        result.replaceChildren(
          ...(earnings.length ? [element('p','Gross cash pay ' + currency.format(grossPay))] : []),
          ...estimateSection('Main taxes',employee.filter(isMainTax)),
          ...(additional.length ? estimateSection('Other taxes and deductions',additional) : []),
          complete ? element('strong','Estimated take-home from entered amounts ' + currency.format(grossPay - subtotal))
            : element('p','Take-home estimate is unavailable until the rows marked Needs review are resolved.','muted'),
          ...estimateSection('Employer taxes',employer),statementPreview);
        if (complete && subtotal <= grossPay && date <= today() && history && history.ref === paymentRef() && history.state === selectedState) {
          const confirm = field('confirmIssued','This payment has been issued and I verified the amounts shown.',{type:'checkbox'});
          const record = button('Record Paid Check',async () => {
            if (recording || !active(context) || !form.isConnected) return;
            if (reference && !paymentRef()) {
              message('Enter the reference for this payment, then calculate again.',true);
              reference.querySelector('input').focus();
              return;
            }
            if (!hasAmount(prior.gross) || !hasAmount(prior.deductions)) {
              foundingTotals.open = true;
              message('Enter verified prior YTD gross pay and total taxes and deductions, then calculate again.',true);
              form.elements.grossPrior.focus();
              return;
            }
            if (prior.deductions > prior.gross) {
              message('Prior YTD taxes and deductions cannot exceed prior YTD gross pay.',true);
              return;
            }
            if (input.supplemental && current.supplementalYtd === null) {
              payItems.details.open = true;
              message('Enter the verified federal taxable supplemental pay for this check, then calculate again.',true);
              form.elements.supplementalTaxable.focus();
              return;
            }
            recording = true;
            record.disabled = true;
            calculate.disabled = true;
            message('Recording paid check…');
            try {
              const savedCheck = await checkHistory(context,date,{
                action:'record',state_ui:state,payment_reference:paymentRef(),expected_revision:history.revision,
                check_data:{prior,amounts:current,statement}
              });
              if (!active(context) || !form.isConnected) return;
              showPaid(savedCheck);
              context.onRecorded?.();
              message('Paid check recorded.');
            } catch (error) {
              if (active(context) && form.isConnected) {
                const notice = error.message || 'Could not record this check.';
                clearResult();
                await refreshHistory();
                if (active(context) && form.isConnected) message(notice,true);
              }
            } finally {
              recording = false;
              record.disabled = !confirm.querySelector('input').checked;
              calculate.disabled = false;
            }
          },'primary-btn');
          const verify = confirm.querySelector('input');
          record.disabled = true;
          verify.addEventListener('change',() => { record.disabled = !verify.checked; });
          result.append(fieldset('Record payment',confirm,record));
        }
        message('');
      } catch (error) {
        result.replaceChildren();
        message(error.message || 'Could not calculate the estimate.',true);
      }
    });
  }

  async function loadPreview(context,date) {
    const token = {};
    context.request = token;
    body.replaceChildren();
    message('Loading tax elections…');
    try {
      const saved = await request(context,'read',date);
      if (!active(context) || context.request !== token) return;
      showPreview(context,date,saved);
      message('');
    } catch (error) {
      if (!active(context) || context.request !== token) return;
      body.replaceChildren(button('Try Again',() => loadPreview(context,date)));
      message(error.message || 'Could not load tax elections.',true);
    }
  }

  async function open(options) {
    if (!currentUser || !options.fleet || !options.reference) return;
    const context = { ...options,user:currentUser };
    session = context;
    const date = today();
    body.replaceChildren();
    title.textContent = options.mode === 'preview' ? 'Payroll Tax Estimate' : 'Tax Information';
    if (!dialog.open) dialog.showModal();
    if (options.mode === 'preview') return loadPreview(context,date);
    message('Loading tax elections…');
    try {
      const saved = await request(context,'read',date);
      if (!active(context)) return;
      showSettings(context,saved?.effective_on || date,saved);
      message('');
    } catch (error) {
      if (active(context)) message(error.message || 'Could not load tax elections.',true);
    }
  }

  function reset() {
    session = null;
    if (dialog.open) dialog.close();
    body.replaceChildren();
    message('');
  }

  dialog.addEventListener('close',() => { if (!dialog.open) reset(); });
  return { open,reset,showSettlementYtd };
})();
