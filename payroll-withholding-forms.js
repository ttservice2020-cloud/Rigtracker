const payrollWithholdingForms = (() => {
  const bucket = 'payroll-withholding-forms';
  const formLabels = { w4: 'Federal Form W-4', state: 'State withholding form' };
  const extensions = { 'application/pdf':'pdf', 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp' };

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(label, action, style = 'outline') {
    const control = element('button', label, style);
    control.type = 'button';
    control.addEventListener('click', () => void action());
    return control;
  }

  function saveBlob(blob, filename, tab) {
    const url = URL.createObjectURL(blob);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (tab) {
      tab.location.replace(url);
    } else {
      const link = element('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
    }
  }

  async function openFile(storageBucket, path, name, download = false) {
    const user = currentUser;
    const tab = download ? null : window.open('about:blank', '_blank');
    if (!download && !tab) return showToast('Allow a new tab to open the document or use Download.');
    if (tab) tab.opener = null;
    try {
      const { data, error } = await supabaseClient.storage.from(storageBucket).download(path);
      if (currentUser !== user || tab?.closed) { tab?.close(); return; }
      if (error || !data) throw error || new Error();
      saveBlob(data, name, tab);
    } catch {
      tab?.close();
      if (currentUser === user) showToast('Could not open this document. Try again.');
    }
  }

  async function sampleW4() {
    try {
      const PDFDocument = await driverPaperwork.loadPdfLibrary();
      const pdf = await PDFDocument.create();
      const page = pdf.addPage([612,792]);
      const year = new Date().getFullYear();
      page.drawText('SAMPLE W-4 - DO NOT FILE', { x:48, y:734, size:24 });
      page.drawText('Employee Withholding Certificate | Training example | ' + year, { x:48, y:708, size:13 });
      const lines = [
        'Step 1: Jordan Example | Single or married filing separately',
        'Social Security number omitted from this training example.',
        'Step 2(c): Multiple jobs box unchecked',
        'Step 3: Annual credits $0',
        'Step 4(a): Other income $0',
        'Step 4(b): Deductions $0',
        'Step 4(c): Extra withholding per paycheck $25',
        'Step 5: Signature omitted from this training example.',
        'Employer: Example Fleet (fictional)',
        'For real withholding elections, complete and sign the official IRS form.'
      ];
      lines.forEach((line,index) => page.drawText(line, { x:48, y:666-index*26, size:12 }));
      saveBlob(new Blob([await pdf.save()],{type:'application/pdf'}),'Sample-W-4-Do-Not-File.pdf');
    } catch { showToast('Could not generate the sample form. Try again.'); }
  }

  function electionFields() {
    const panel = element('details', '', 'payroll-tax-group withholding-elections');
    panel.open = true;
    panel.append(element('summary','W-4 elections for payroll'));
    const fields = element('div', '', 'payroll-tax-grid');
    const field = (label, control) => {
      const wrapper = element('label',label,'payroll-tax-field field');
      wrapper.append(control);
      fields.append(wrapper);
      return control;
    };
    const status = field('Filing status from W-4', element('select'));
    status.append(new Option('Enter later', ''), new Option('Single or married filing separately','single'),
      new Option('Married filing jointly or qualifying surviving spouse','married'), new Option('Head of household','head'), new Option('Exempt','exempt'));
    const multipleJobs = field('Step 2(c) multiple jobs box is checked',element('input'));
    multipleJobs.type = 'checkbox';
    const amounts = Object.fromEntries([
      ['credits','Step 3 annual credits ($)'], ['otherIncome','Step 4(a) other income ($)'],
      ['deductions','Step 4(b) deductions ($)'], ['federalExtra','Step 4(c) extra per paycheck ($)']
    ].map(([key,label]) => {
      const input = field(label,element('input'));
      Object.assign(input,{type:'number',min:'0',max:'100000000',step:'0.01',inputMode:'decimal'});
      return [key,input];
    }));
    const thisYear = new Date().getFullYear();
    const exemptYear = field('Exemption tax year',element('input'));
    Object.assign(exemptYear,{type:'number',min:'2020',max:'2100',step:'1',value:String(thisYear)});
    const sync = enabled => {
      panel.hidden = !enabled;
      status.disabled = !enabled;
      const regular = enabled && status.value && status.value !== 'exempt';
      for (const input of [multipleJobs,...Object.values(amounts)]) {
        input.disabled = !regular;
        input.parentElement.hidden = !regular;
      }
      exemptYear.disabled = !(enabled && status.value === 'exempt');
      exemptYear.required = !exemptYear.disabled;
      exemptYear.parentElement.hidden = exemptYear.disabled;
    };
    status.addEventListener('change',() => sync(true));
    panel.append(fields);
    sync(true);
    return { panel, sync, values:() => status.disabled || !status.value ? null : {
      filingStatus:status.value, multipleJobs:!multipleJobs.disabled && multipleJobs.checked,
      ...Object.fromEntries(Object.entries(amounts).map(([key,input]) => [key,input.disabled ? 0 : Number(input.value)])),
      exemptYear:exemptYear.disabled ? thisYear : Number(exemptYear.value)
    }};
  }

  async function mount(host, active, context, applyElections) {
    const heading = element('h3', context ? 'Withholding forms on file' : 'Submit a withholding form');
    const status = element('p', 'Loading withholding forms…', 'muted');
    status.setAttribute('role','status');
    const help = element('p', context ? 'Open the signed form to verify the elections before saving them.'
      : 'Complete and sign Form W-4, then upload a PDF or a clear photo for payroll. Upload your state form separately if payroll asks for one.', 'muted');
    const tools = element('div', '', 'dispatch-actions');
    const blank = element('a', 'IRS Form W-4');
    blank.href = 'https://www.irs.gov/pub/irs-pdf/fw4.pdf';
    blank.target = '_blank';
    blank.rel = 'noopener';
    tools.append(blank, button('Download sample W-4', sampleW4));
    const list = element('div', '', 'dispatch-load-list withholding-form-list');
    host.replaceChildren(heading, help, tools, status, list);
    try {
      const args = context ? { target_fleet:context.fleet,target_kind:context.kind,target_reference:context.reference } : {};
      const { data:folders, error } = await supabaseClient.rpc('payroll_withholding_folders',args);
      if (error) throw error;
      if (!active()) return;
      if (!folders.length) { status.textContent = 'Link your employee profile to a fleet to submit forms.'; return; }
      const storage = supabaseClient.storage.from(bucket);
      const uploadForm = element('form', '', 'withholding-upload');
      const fleetLabel = element('label', 'Fleet', 'field');
      const fleet = element('select');
      fleet.append(...folders.map(entry => new Option(entry.fleet,entry.folder)));
      fleetLabel.append(fleet);
      fleetLabel.hidden = folders.length === 1;
      const typeLabel = element('label', 'Form type', 'field');
      const type = element('select');
      type.append(...Object.entries(formLabels).map(([key,label]) => new Option(label,key)));
      typeLabel.append(type);
      const fileLabel = element('label', 'Signed form', 'field');
      const file = element('input');
      Object.assign(file,{type:'file',accept:Object.keys(extensions).join(','),required:true});
      fileLabel.append(file);
      const save = element('button', context ? 'Add signed form' : 'Submit to payroll', 'primary-btn');
      save.type = 'submit';
      const elections = electionFields();
      type.addEventListener('change',() => elections.sync(type.value === 'w4'));
      uploadForm.append(fleetLabel, typeLabel, fileLabel, elections.panel, save);
      list.before(uploadForm);

      async function refresh(message = '') {
        const entries = (await Promise.all(folders.map(async entry => {
          const { data,error } = await supabaseClient.rpc('payroll_withholding_submissions',{target_folder:entry.folder});
          if (error) throw error;
          return data.map(item => ({...item,fleet:entry.fleet}));
        }))).flat().sort((a,b) => Date.parse(b.created_at)-Date.parse(a.created_at));
        if (!active()) return;
        list.replaceChildren(...entries.map(entry => {
          const row = element('article', '', 'dispatch-load-row');
          const info = element('div');
          const label = formLabels[entry.kind];
          info.append(element('strong',label),element('p',[entry.fleet,
            entry.created_at && new Date(entry.created_at).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})].filter(Boolean).join(' · ')));
          const actions = element('div', '', 'dispatch-actions');
          const name = label + '.' + entry.path.split('.').pop();
          actions.append(button('Open',() => openFile(bucket,entry.path,name)),
            button('Download',() => openFile(bucket,entry.path,name,true)));
          if (applyElections && entry.elections) actions.append(button('Use W-4 elections',() => applyElections(entry.elections)));
          row.append(info,actions);
          return row;
        }));
        status.textContent = message || (entries.length ? '' : 'No withholding forms are on file.');
      }

      uploadForm.addEventListener('submit', async event => {
        event.preventDefault();
        if (!active() || save.disabled) return;
        const form = file.files[0];
        const extension = extensions[form?.type];
        if (!extension || !form.size || form.size > 10 * 1024 * 1024) {
          status.textContent = 'Choose a PDF or image up to 10 MB.';
          return;
        }
        save.disabled = true;
        status.textContent = 'Uploading signed form…';
        try {
          const path = [fleet.value,type.value,crypto.randomUUID()+'.'+extension].join('/');
          const values = elections.values();
          const {error} = await storage.upload(path,form,{upsert:false,...(values ? {metadata:{w4:values}} : {})});
          if (error) throw error;
          if (!active()) return;
          file.value = '';
          try { await refresh(context ? 'Signed form added.' : 'Signed form submitted to payroll.'); }
          catch { if (active()) status.textContent = 'Form saved. Reopen this section to refresh the list.'; }
        } catch {
          if (active()) status.textContent = 'Could not upload the signed form. Try again.';
        } finally { save.disabled = false; }
      });
      await refresh();
    } catch {
      if (active()) status.textContent = 'Could not load withholding forms. Reopen this section to retry.';
    }
  }

  return { mount, openFile };
})();
