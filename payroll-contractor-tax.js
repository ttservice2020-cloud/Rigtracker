const payrollContractorTax = (() => {
  const taxYear = 2026;
  const template = './tax-forms/1099-nec-2026-recipient.pdf';
  const canPrepare = () => Boolean(currentUser && (accountTypeFor(currentUser) === 'fleet' || officeTools.has('payroll')));

  function element(tag, content, className) {
    const node = document.createElement(tag);
    if (content) node.textContent = content;
    if (className) node.className = className;
    return node;
  }

  function field(name, label, options = {}) {
    const wrapper = element('label', label, 'field payroll-tax-field');
    const input = element(options.choices ? 'select' : 'input');
    input.name = name;
    input.required = options.required ?? true;
    if (options.choices) input.replaceChildren(...options.choices.map(([value,text]) => new Option(text,value)));
    else if (options.money) Object.assign(input,{type:'number',inputMode:'decimal',min:'0',max:'999999999.99',step:'0.01'});
    else Object.assign(input,{type:options.type || 'text',maxLength:options.maxLength || 90,autocomplete:'off',
      inputMode:options.inputMode || 'text'});
    wrapper.append(input);
    return wrapper;
  }

  function group(label, ...fields) {
    const group = element('fieldset','','payroll-tax-group');
    const grid = element('div','','payroll-tax-grid');
    grid.append(...fields);
    group.append(element('legend',label),grid);
    return group;
  }

  function address(prefix) {
    return [field(prefix+'Street','Street address'),field(prefix+'Unit','Room, suite or apartment',{required:false,maxLength:12}),
      field(prefix+'City','City'),field(prefix+'State','State or territory abbreviation',{maxLength:2}),
      field(prefix+'Zip','ZIP code',{maxLength:10})];
  }

  const tinKinds = [['ein','EIN'],['ssn','SSN or ITIN']];
  const optionalMoney = {money:true,required:false};

  function validated(form) {
    const values = Object.fromEntries(Array.from(new FormData(form),([key,value]) => [key,value.trim()]));
    const payerTin = values.payerTin.replaceAll('-','');
    if (!/^\d{9}$/.test(payerTin) || !/^\d{4}$/.test(values.recipientTin)) {
      throw new Error('Enter the payer’s nine-digit TIN and the last four digits of the recipient’s TIN.');
    }
    for (const prefix of ['payer','recipient']) {
      values[prefix+'State'] = values[prefix+'State'].toUpperCase();
      if (!values[prefix+'Name'] || !values[prefix+'Street'] || !values[prefix+'City'] ||
        !/^[A-Z]{2}$/.test(values[prefix+'State']) || !/^\d{5}(-\d{4})?$/.test(values[prefix+'Zip'])) {
        throw new Error('Enter a complete U.S. mailing address and legal name for the payer and recipient.');
      }
    }
    if (!values.payerPhone) throw new Error('Enter the payer’s telephone number.');
    if ([values.reportingState,values.stateTax,values.stateAccount,values.stateIncome].some(Boolean) &&
      (!/^[A-Z]{2}$/.test(values.reportingState.toUpperCase()) || !values.stateAccount || !values.stateIncome)) {
      throw new Error('Enter the reporting state, payer’s state account number, and state income to complete the state boxes.');
    }
    values.payerTin = values.payerTinType === 'ein' ? payerTin.slice(0,2)+'-'+payerTin.slice(2)
      : payerTin.slice(0,3)+'-'+payerTin.slice(3,5)+'-'+payerTin.slice(5);
    values.recipientTin = (values.recipientTinType === 'ein' ? 'XX-XXX' : 'XXX-XX-') + values.recipientTin;
    return values;
  }

  async function recipientPdf(values) {
    const [PDFDocument,response] = await Promise.all([driverPaperwork.loadPdfLibrary(),fetch(template)]);
    if (!response.ok) throw new Error('Could not load the IRS recipient form.');
    const pdf = await PDFDocument.load(await response.arrayBuffer());
    const font = await pdf.embedFont(window.PDFLib.StandardFonts.Helvetica);
    const page = pdf.getPage(0);
    // Coordinates match the December 2026 IRS Copy B. The second page contains the IRS recipient instructions.
    const draw = (text,x,y,width,right = false) => {
      if (!text) return;
      let textWidth;
      try { textWidth = font.widthOfTextAtSize(text,1); }
      catch { throw new Error('A name or address contains characters this IRS PDF cannot render.'); }
      const size = Math.min(10,width/textWidth);
      if (size < 6) throw new Error('A name or address is too long to fit in its IRS form box.');
      page.drawText(text,{x:right ? x+width-textWidth*size : x,y,size,font});
    };
    const amount = (key,x,y,width) => {
      if (values[key] !== '') draw(Number(values[key]).toFixed(2),x,y,width,true);
    };
    draw(String(taxYear),419,688,26);
    draw(values.payerName,54,729,238);
    draw(values.payerStreet,54,698,151);
    draw(values.payerUnit,211,698,81);
    draw(values.payerCity,54,674,151);
    draw(values.payerPhone,211,674,81);
    draw(values.payerState,54,651,114);
    draw('US',175,651,31);
    draw(values.payerZip,211,651,81);
    draw(values.payerTin,54,621,114);
    draw(values.recipientTin,176,621,116);
    draw(values.recipientName,54,585,238);
    draw(values.recipientStreet,54,554,186);
    draw(values.recipientUnit,248,554,44);
    draw(values.recipientCity,54,530,238);
    draw(values.recipientState,54,506,114);
    draw('US',175,506,31);
    draw(values.recipientZip,211,506,81);
    draw(values.account,54,441,238);
    amount('compensation',322,651,170);
    amount('federalTax',322,471,170);
    if (values.reportingState) {
      amount('stateTax',322,447,70);
      draw(values.reportingState.toUpperCase()+' / '+values.stateAccount,400,447,92);
      amount('stateIncome',525,447,49);
    }
    return new Blob([await pdf.save()],{type:'application/pdf'});
  }

  function mount(host, active, context) {
    const w9 = element('section','','payroll-tax-group withholding-forms');
    void payrollWithholdingForms.mount(w9,() => active() && w9.isConnected,context);
    const form = element('form');
    const status = element('p','','muted');
    status.setAttribute('role','status');
    const download = element('button','Download Recipient Copy (PDF)','primary-btn');
    download.type = 'submit';
    const confirm = element('label','I verified the contractor classification, signed W-9, and reportable payments.','field payroll-tax-field');
    const check = element('input');
    Object.assign(check,{type:'checkbox',required:true});
    confirm.append(check);
    const instructions = element('a','IRS filing instructions');
    Object.assign(instructions,{href:'https://www.irs.gov/instructions/i1099mec',target:'_blank',rel:'noopener'});
    form.append(
      group('Payer',field('payerName','Legal payer name'),field('payerPhone','Telephone number',{inputMode:'tel',maxLength:20}),
        field('payerTinType','Payer TIN type',{choices:tinKinds}),
        field('payerTin','Payer TIN',{type:'password',inputMode:'numeric',maxLength:11}),...address('payer')),
      group('Recipient',field('recipientName','Legal recipient name from W-9'),...address('recipient'),
        field('recipientTinType','Recipient TIN type',{choices:[...tinKinds].reverse()}),
        field('recipientTin','Last four digits of recipient TIN',{type:'password',inputMode:'numeric',maxLength:4}),
        field('account','Account number (optional)',{required:false,maxLength:30})),
      group('2026 payments',field('compensation','Nonemployee compensation (box 1a)',{money:true}),
        field('federalTax','Federal income tax withheld (box 4)',optionalMoney),
        field('reportingState','Reporting state (optional)',{required:false,maxLength:2}),
        field('stateAccount','Payer’s state account number (box 6)',{required:false,maxLength:21}),
        field('stateTax','State tax withheld (box 5)',optionalMoney),field('stateIncome','State income (box 7)',optionalMoney)),
      confirm,status,download
    );
    host.append(element('p','Use this form for payments made to an independent contractor during 2026. W-2 employee wages stay in payroll.','muted'),
      element('p','Enter the verified calendar-year payments from your records. The PDF is created on your device for the recipient. File separately with the IRS.','muted'),
      instructions,w9,form);
    form.addEventListener('submit',async event => {
      event.preventDefault();
      if (!active() || !canPrepare() || download.disabled) return;
      download.disabled = true;
      status.textContent = 'Preparing recipient copy…';
      try {
        const blob = await recipientPdf(validated(form));
        if (!active() || !canPrepare()) return;
        const url = URL.createObjectURL(blob);
        const link = element('a');
        link.download = '1099-NEC-2026-Copy-B.pdf';
        link.href = url;
        host.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url),60_000);
        status.textContent = 'Recipient copy downloaded.';
      } catch (error) {
        if (active()) status.textContent = error.message || 'Could not generate the recipient copy.';
      } finally {
        download.disabled = false;
      }
    });
  }

  return { canPrepare, mount };
})();
