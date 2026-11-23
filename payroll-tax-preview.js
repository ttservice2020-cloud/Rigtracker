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
      if (input.type === 'text') input.maxLength = 100;
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
      localityName:'', localExtra:0, elections:{}
    };
  }

  function electionFields(state, elections) {
    return (payrollTaxRules.baseFields[state] || []).map(([key, label, choices, format]) => field(key, label, {
      choices, value:elections[key] ?? (key === 'azRate' ? 2 : choices ? choices[0][0] : 0), step:format === 'money' ? '0.01' : 1, max:format === 'money' ? 100000000 : 99
    }));
  }

  function localityOptions(state) {
    const options = [['unverified','Needs review'], ['none','No local income tax applies']];
    if (state === 'KY') options.push(...Object.entries(payrollTaxRules.kentuckyLocalities).map(([key,[label]]) => [key,label]));
    if (state === 'NY') options.push(['newYorkCity','New York City · resident']);
    if (state === 'IN') options.push(...payrollTaxRules.indianaCounties.map(([code, name]) => ['in:' + code, name + ' County']));
    return options;
  }

  function visible(row, show) {
    row.hidden = !show;
    row.querySelector('input, select').disabled = !show;
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
    const local = field('locality','Applicable city or county', { choices:localityOptions(settings.state),value:settings.locality });
    const localLabel = field('localityName','City or county to review (optional)', {
      value:settings.localityName, type:'text', required:false
    });
    const localExtra = field('localExtra','Additional local withholding per check', { value:settings.localExtra });

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
        element('p','Confirm the withholding jurisdiction from payroll records. For Indiana, use the applicable January 1 county.','muted')),
      actions
    );
    body.replaceChildren(
      element('p',context.name,'payroll-tax-person'),
      element('p',saved ? 'Loaded elections effective ' + saved.effective_on + '. Choose the date these settings take effect.'
        : 'Copy the withholding elections from the employee’s current forms.', 'muted'),
      form
    );
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
      visible(localExtra,inputs.locality.value.startsWith('in:') || inputs.locality.value === 'newYorkCity');
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
      stateNotice.textContent = '';
      if (code && !payrollTaxRules.covers(code)) {
        const link = element('a','Open the official state tax agency');
        link.href = payrollTaxRules.states[code][1];
        link.target = '_blank';
        link.rel = 'noopener';
        stateNotice.append('Automatic calculation needs review for this state. ',link);
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
      const elections = Object.fromEntries((payrollTaxRules.baseFields[inputs.state.value] || []).map(([key]) => [
        key, ['ncStatus','coStatus','moStatus','utStatus','nyStatus','gaStatus','iaStatus'].includes(key) ? inputs[key].value : Number(inputs[key].value)
      ]));
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
        localExtra:number('localExtra',0), elections
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
    body.replaceChildren(element('p',context.name,'payroll-tax-person'),grid(payDate),element('p',summary,'muted'),edit);
    payDateInput.addEventListener('change', event => {
      if (event.target.value && event.target.checkValidity()) void loadPreview(context,event.target.value);
    });
    if (!saved) return;

    const form = element('form');
    const amount = field('grossPay','Gross cash pay',{ value:context.gross });
    const wageDetails = element('details', '', 'payroll-tax-group');
    const wages = wageBases.map(([key,label]) => field(key,label + ' (optional override)', { required:false }));
    wageDetails.append(element('summary','Adjust taxable wages by jurisdiction'), element('p','Each wage base defaults to gross cash pay. Use the appropriate taxable wages for pretax deductions, reimbursements, or taxable benefits.', 'muted'),grid(...wages));
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
    const garnishment = field('garnishment','Reviewed garnishment amount (optional)',{ required:false });
    const employerDetails = element('details', '', 'payroll-tax-group');
    employerDetails.append(element('summary','Employer unemployment (optional)'),
      element('p','Use the fleet’s verified employer rate and the taxable wages after the applicable annual cap. These amounts stay outside employee deductions.','muted'),
      grid(field('futaWages','FUTA taxable wages (after cap)',{ required:false }),
        field('futaRate','Effective FUTA rate (%)',{ step:'0.0001',max:100,required:false }),
        field('sutaWages','State UI taxable wages (after cap)',{ required:false }),
        field('sutaRate','Assigned state UI rate (%)',{ step:'0.0001',max:100,required:false })));
    form.append(element('p','Estimate for regular W-2 wages. Enter only confirmed deductions and applicable wages.', 'muted'),
      grid(amount,...(periodStart ? [periodStart] : []),...(massachusettsDeduction ? [massachusettsDeduction] : []),field('socialSecurityYtd','YTD Social Security wages before this check'),
        field('medicareYtd','YTD Medicare wages before this check')),wageDetails,
      reviewedTaxes,grid(offset,garnishment),employerDetails,calculate,result);
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
      try {
        const { employee, employer } = payrollTaxRules.calculate(saved.settings,input);
        for (const [index,key] of [[1,'reviewedState'],[2,'reviewedLocal']]) {
          if (Number.isNaN(value(key))) continue;
          if (employee[index].amount !== null) throw new Error('Use a reviewed state or local amount only for a row marked Needs review.');
          employee[index].name += ' (entered by payroll)';
          employee[index].amount = value(key);
        }
        if (Number.isFinite(value('additionalLocal'))) {
          const name = form.elements.localDescription.value.trim() || 'Additional local withholding';
          employee.push({ name:name + ' (entered by payroll)',amount:value('additionalLocal') });
        }
        for (const [key,name] of [['futa','Federal unemployment (entered rate)'],['suta','State unemployment (entered rate)']]) {
          const wages = value(key + 'Wages');
          const rate = value(key + 'Rate');
          if (Number.isNaN(wages) && Number.isNaN(rate)) continue;
          if (!Number.isFinite(wages) || !Number.isFinite(rate)) throw new Error('Enter both taxable wages and the unemployment rate.');
          employer.push({ name, amount:Math.round(wages * rate) / 100 });
        }
        for (const [key,name] of [['cashAdjustment','Other reviewed employee deductions'],['garnishment','Reviewed garnishment']]) {
          if (Number.isFinite(value(key))) employee.push({ name,amount:value(key) });
        }
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
