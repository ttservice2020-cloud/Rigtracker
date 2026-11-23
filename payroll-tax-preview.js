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

  function unemploymentFields(state,year) {
    const details = element('details','','payroll-tax-group');
    const selector = field('sutaState','State where unemployment wages are reported',{
      value:state,choices:Object.entries(payrollTaxRules.states).sort((a,b) => a[1][0].localeCompare(b[1][0]))
        .map(([code,[name]]) => [code,name])
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
      grid(field('futaWages','FUTA covered wages this check (defaults to gross)',{required:false}),
        field('futaYtd','YTD FUTA covered wages before this check',{required:false}),
        field('futaRate','Effective FUTA rate (%)',{step:'0.0001',max:6,required:false})),
      grid(selector,wageBase),note,
      grid(field('sutaWages','State UI covered wages this check (defaults to gross)',{required:false}),
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

  function estimateUnemployment(form,gross,year) {
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
      if ([wages,ytd,rate,override].every(Number.isNaN)) continue;
      const base = Number.isFinite(override) ? override : publishedBase;
      if (!Number.isFinite(base)) throw new Error('Choose the confirmed unemployment wage base for this pay date and employer account.');
      deductions.push({name,amount:payrollTaxDeductions.unemployment(Number.isNaN(wages) ? gross : wages,ytd,base,rate),source});
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
    const amount = field('grossPay','Gross cash pay',{ value:context.gross });
    const wageDetails = element('details', '', 'payroll-tax-group');
    const wages = wageBases.map(([key,label]) => field(key,label + ' (optional override)', { required:false }));
    const savedLocalTaxes = saved.settings.localTaxes || [];
    const localWages = savedLocalTaxes.flatMap((tax,index) => tax.method === 'rate'
      ? [field('localTaxWages' + index,tax.name + ' taxable wages (optional)',{ required:false })] : []);
    wageDetails.append(element('summary','Adjust taxable wages by jurisdiction'),
      element('p','Wage bases default to gross cash pay. Each saved local rate uses local income tax wages unless its own wage amount is entered.','muted'),
      grid(...wages,...localWages));
    const periodStart = ['UT','IN'].includes(saved.settings.state) ? field('periodStartsOn','Pay period starts on',{
      type:'date',required:false
    }) : null;
    const massachusettsDeduction = saved.settings.state === 'MA' ? field('maContributions',
      'Massachusetts eligible payroll contributions this check (after $2,000 annual limit)',{
        max:2000,required:false
      }) : null;
    const reviewedTaxes = element('details', '', 'payroll-tax-group');
    reviewedTaxes.append(element('summary','Enter reviewed state and local amounts'),
      element('p','Use amounts verified by payroll for the pay date. A reviewed amount replaces a row that needs review. Enter 0 only when payroll has confirmed that none applies.','muted'),
      grid(field('reviewedState','State withholding (if state needs review)',{required:false}),
        field('reviewedLocal','Local withholding (if city or county needs review)',{required:false}),
        field('additionalLocal','Additional city, county or school district withholding',{required:false}),
        field('localDescription','Additional local jurisdiction (optional)',{type:'text',required:false})));
    const result = element('section');
    result.setAttribute('aria-live','polite');
    const calculate = button('Calculate Estimate',null,'primary-btn');
    calculate.type = 'submit';
    const offset = field('cashAdjustment','Other reviewed employee deductions (optional)',{ required:false });
    const year = Number(date.slice(0,4));
    form.append(element('p','Estimate for regular W-2 wages. Enter only confirmed deductions and applicable wages.', 'muted'),
      grid(amount,...(periodStart ? [periodStart] : []),...(massachusettsDeduction ? [massachusettsDeduction] : []),field('socialSecurityYtd','YTD Social Security wages before this check'),
        field('medicareYtd','YTD Medicare wages before this check')),wageDetails,
      reviewedTaxes,offset,garnishmentFields(),unemploymentFields(saved.settings.state,year),calculate,result);
    body.append(form);
    form.addEventListener('input',() => {
      context.gross = form.elements.grossPay.value;
      result.replaceChildren();
      message('');
    });
    form.addEventListener('submit',event => {
      event.preventDefault();
      if (!active(context)) return;
      if (payDateInput.value !== date) {
        message('Choose a valid pay date before calculating.',true);
        return;
      }
      const value = key => form.elements[key].valueAsNumber;
      const grossPay = value('grossPay');
      const input = { date, periodStartsOn:form.elements.periodStartsOn?.value, maContributions:form.elements.maContributions?.valueAsNumber, grossPay, socialSecurityYtd:value('socialSecurityYtd'), medicareYtd:value('medicareYtd') };
      for (const [key] of wageBases) input[key] = Number.isFinite(value(key)) ? value(key) : grossPay;
      input.localTaxWages = savedLocalTaxes.map((tax,index) => tax.method === 'rate' ? value('localTaxWages' + index) : undefined);
      try {
        const { employee, employer } = payrollTaxRules.calculate(saved.settings,input);
        for (const [type,key] of [['state','reviewedState'],['local','reviewedLocal']]) {
          if (Number.isNaN(value(key))) continue;
          const row = employee.find(row => row.type === type);
          if (!row || row.amount !== null) throw new Error('Use a reviewed state or local amount only for a row marked Needs review.');
          row.name += ' (entered by payroll)';
          row.amount = value(key);
        }
        if (Number.isFinite(value('additionalLocal'))) {
          const name = form.elements.localDescription.value.trim() || 'Additional local withholding';
          employee.push({ name:name + ' (entered by payroll)',amount:value('additionalLocal') });
        }
        employer.push(...estimateUnemployment(form,grossPay,year));
        if (Number.isFinite(value('cashAdjustment'))) {
          employee.push({name:'Other reviewed employee deductions',amount:value('cashAdjustment')});
        }
        const garnishment = estimateGarnishment(form,saved.settings.periods);
        if (garnishment) employee.push(garnishment);
        const subtotal = employee.reduce((sum, row) => sum + (row.amount ?? 0),0);
        const complete = employee.every(row => row.amount !== null);
        const employeeList = element('dl','', 'payroll-tax-results');
        employeeList.append(...estimateRows(employee));
        const employerList = element('dl','', 'payroll-tax-results');
        employerList.append(...estimateRows(employer));
        result.replaceChildren(element('h3','Employee deductions'),employeeList,
          complete ? element('strong','Estimated take-home from entered amounts ' + currency.format(grossPay - subtotal))
            : element('p','Take-home estimate is unavailable until the rows marked Needs review are resolved.','muted'),
          element('h3','Employer taxes'),employerList);
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
  return { open,reset };
})();
