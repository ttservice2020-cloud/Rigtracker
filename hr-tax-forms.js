const hrTaxForms = (() => {
  const byId = id => document.getElementById(id);
  const page = byId('hrTaxFormsPage');
  const status = byId('hrTaxFormsStatus');
  const picker = byId('hrTaxWorker');
  const selection = byId('hrTaxWorkerSelection');
  const actions = byId('hrTaxWorkerActions');
  const documents = byId('hrIssuedTaxDocuments');
  const own = byId('hrOwnTaxForms');
  const nav = byId('hrWorkspaceTabs');
  const taxPanel = byId('hrTaxFormsPanel');
  const customPanel = byId('hrCustomPanel');
  const manage = byId('hrManageTabs');
  const editor = byId('hrTabsDialog');
  const editorForm = byId('hrTabsForm');
  const editorRows = byId('hrTabsEditorRows');
  const editorStatus = byId('hrTabsEditorStatus');
  const add = byId('hrTabsAdd');
  const cancel = byId('hrTabsCancel');
  const save = byId('hrTabsSave');
  const canManage = () => Boolean(currentUser && (accountTypeFor(currentUser) === 'fleet' ||
    officeTools.has('hr') || officeTools.has('payroll')));
  let view;
  let editing;

  function button(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline';
    button.textContent = label;
    button.addEventListener('click',action);
    return button;
  }

  const active = current => view === current && currentUser === current.user && page.classList.contains('active');

  function reset() {
    view = null;
    editing = null;
    if (editor.open) editor.close();
    editorRows.replaceChildren();
    manage.classList.add('hidden');
    nav.classList.add('hidden');
    nav.replaceChildren();
    customPanel.classList.add('hidden');
    byId('hrCustomTitle').textContent = byId('hrCustomContent').textContent = '';
    taxPanel.classList.remove('hidden');
    picker.replaceChildren();
    actions.replaceChildren();
    documents.replaceChildren();
    selection.classList.add('hidden');
    status.textContent = '';
  }

  function showWorkspace(current, id) {
    const tabs = current.workspace?.tabs.filter(tab => !tab.archived) || [];
    const selected = tabs.find(tab => tab.id === id);
    current.tab = selected?.id || '';
    taxPanel.classList.toggle('hidden',Boolean(selected));
    customPanel.classList.toggle('hidden',!selected);
    byId('hrCustomTitle').textContent = selected?.title || '';
    byId('hrCustomContent').textContent = selected?.body || '';
    const items = [{id:'',title:'Tax Forms'},...tabs];
    nav.classList.toggle('hidden',!tabs.length);
    nav.replaceChildren(...items.map(tab => {
      const control = button(tab.title,() => showWorkspace(current,tab.id));
      control.setAttribute('aria-pressed',String(tab.id === current.tab));
      return control;
    }));
  }

  async function loadWorkspace(current) {
    try {
      const {data,error} = await supabaseClient.rpc('hr_workspace_tabs',{action:'read',target_fleet:current.fleet});
      if (error) throw error;
      if (!active(current)) return;
      current.workspace = data;
      manage.classList.toggle('hidden',accountTypeFor(current.user) !== 'fleet');
      showWorkspace(current,current.tab);
    } catch (error) {
      if (active(current)) showToast(error.message || 'Could not load the HR tabs.');
    }
  }

  function paintEditor() {
    const { tabs } = editing;
    editorRows.replaceChildren(...tabs.map((tab,index) => {
      const row = document.createElement('fieldset');
      row.className = 'payroll-tax-group';
      const legend = document.createElement('legend');
      legend.textContent = tab.archived ? 'Archived tab' : 'HR tab';
      const field = (key,label,tag,maxLength) => {
        const wrapper = document.createElement('label');
        wrapper.className = 'field';
        wrapper.textContent = label;
        const input = document.createElement(tag);
        input.maxLength = maxLength;
        input.required = key === 'title';
        input.value = tab[key];
        input.addEventListener('input',() => { tab[key] = input.value; });
        wrapper.append(input);
        return wrapper;
      };
      const arrange = document.createElement('div');
      arrange.className = 'dispatch-actions';
      const move = (direction,label) => {
        const target = index + direction;
        const control = button(label,() => {
          [tabs[target],tabs[index]] = [tabs[index],tabs[target]];
          paintEditor();
          editorRows.children[target].querySelector('input').focus();
        });
        control.disabled = target < 0 || target >= tabs.length;
        return control;
      };
      arrange.append(move(-1,'Move Up'),move(1,'Move Down'),button(tab.archived ? 'Restore' : 'Archive',() => {
        tab.archived = !tab.archived;
        paintEditor();
        editorRows.children[index].querySelector('input').focus();
      }));
      row.append(legend,field('title','Tab name','input',80),field('body','Content','textarea',4000),arrange);
      return row;
    }));
    add.disabled = tabs.length >= 30;
  }

  manage.addEventListener('click',() => {
    if (!view?.workspace || !active(view) || accountTypeFor(currentUser) !== 'fleet') return;
    editing = {current:view,revision:view.workspace.revision,tabs:view.workspace.tabs.map(tab => ({...tab}))};
    editorStatus.textContent = '';
    editorRows.disabled = save.disabled = cancel.disabled = false;
    paintEditor();
    editor.showModal();
  });
  add.addEventListener('click',() => {
    if (!editing || editing.saving || editing.tabs.length >= 30) return;
    editing.tabs.push({id:crypto.randomUUID(),title:'',body:'',archived:false});
    paintEditor();
    editorRows.lastElementChild.querySelector('input').focus();
  });
  cancel.addEventListener('click',() => editor.close());
  editor.addEventListener('cancel',event => { if (editing?.saving) event.preventDefault(); });
  editor.addEventListener('close',() => { if (!editor.open) { editing = null; editorRows.replaceChildren(); } });
  editorForm.addEventListener('submit',async event => {
    event.preventDefault();
    const draft = editing;
    if (!draft || draft.saving || !active(draft.current)) return;
    const {current,tabs,revision} = draft;
    draft.saving = add.disabled = cancel.disabled = save.disabled = editorRows.disabled = true;
    editorStatus.textContent = 'Saving HR tabs…';
    try {
      const {data,error} = await supabaseClient.rpc('hr_workspace_tabs',{action:'save',target_fleet:current.fleet,
        tabs:tabs.map(tab => ({...tab,title:tab.title.trim()})),expected_revision:revision});
      if (error) throw error;
      if (editing !== draft || !active(current)) return;
      current.workspace = data;
      editor.close();
      showWorkspace(current,current.tab);
      showToast('HR tabs saved.');
    } catch (error) {
      if (editing !== draft || !active(current)) return;
      editorStatus.textContent = error.message || 'Could not save the HR tabs.';
      if (error.code === '40001') void loadWorkspace(current);
    } finally {
      draft.saving = false;
      if (editing === draft) {
        cancel.disabled = save.disabled = editorRows.disabled = false;
        add.disabled = tabs.length >= 30;
      }
    }
  });

  function showWorker(current) {
    const worker = picker.value === '' ? null : current.workers[Number(picker.value)];
    current.selected = worker;
    actions.replaceChildren();
    documents.replaceChildren();
    documents.classList.toggle('hidden',!worker?.driver_id);
    if (!worker) return;
    if (current.managed && worker.kind !== 'roster') {
      const context = { fleet:current.fleet, kind:'hr_' + worker.kind, reference:worker.reference,
        name:worker.name, readOnlyForms:worker.former };
      if (worker.w2) actions.append(button(worker.kind === 'driver' ? 'Tax Form & Classification' : 'Withholding Forms & Elections',
        () => payrollTaxPreview.open(context)));
      actions.append(button('Prepare 1099-NEC',() => payrollTaxPreview.open({...context,mode:'1099'})));
    }
    if (worker.driver_id) {
      const heading = document.createElement('h2');
      heading.textContent = 'Issued Tax Documents';
      const files = document.createElement('div');
      documents.append(heading,files);
      void companyDriverTools.mountIssuedTaxFiles(files,
        () => active(current) && current.selected === worker && files.isConnected,
        current.fleet,worker.driver_id,current.managed);
    }
  }

  function matches(worker, target) {
    if (!target) return false;
    return target.kind === worker.kind &&
      ((target.reference && target.reference === worker.reference) || (target.number && target.number === worker.number));
  }

  async function open(fleet, target, back) {
    const user = currentUser;
    const role = accountTypeFor(user);
    if (!user || !['fleet','employee'].includes(role)) return;
    reset();
    const current = {user,fleet,back,workers:[]};
    view = current;
    own.classList.toggle('hidden',role !== 'employee');
    byId('hrFleetLinks').classList.toggle('hidden',role !== 'fleet');
    documents.classList.add('hidden');
    showPage(page.id);
    if (!fleet) {
      if (role === 'fleet') status.textContent = 'Set your Fleet ID in Fleet Settings to manage tax forms.';
      return;
    }
    if (role === 'fleet' || officeTools.has('hr')) void loadWorkspace(current);
    if (!target && !canManage() && !officeTools.has('driver_tax')) return;
    status.textContent = 'Loading tax profiles…';
    try {
      const {data,error} = await supabaseClient.rpc('hr_tax_roster',{target_fleet:fleet});
      if (error) throw error;
      if (!active(current)) return;
      current.managed = data.managed;
      current.workers = data.workers;
      const options = data.workers.map((worker,index) => new Option(
        [worker.name || (worker.kind === 'office' ? 'Office worker' : 'Driver'),worker.number,
          worker.kind === 'office' ? 'Office' : worker.former ? 'Former driver' : 'Driver'].filter(Boolean).join(' · '),String(index)
      ));
      picker.replaceChildren(new Option('Select a worker',''),...options);
      let selected = data.workers.findIndex(worker => matches(worker,target));
      if (selected < 0 && target?.driverId) selected = data.workers.findIndex(worker => worker.driver_id === target.driverId);
      if (selected >= 0) picker.value = String(selected);
      selection.classList.toggle('hidden',!options.length);
      status.textContent = options.length ? '' : 'No worker tax profiles are available.';
      showWorker(current);
    } catch (error) {
      if (active(current)) status.textContent = error.message || 'Could not load worker tax forms.';
    }
  }

  picker.addEventListener('change',() => { if (view && active(view)) showWorker(view); });
  byId('hrTaxFormsBack').addEventListener('click',() => {
    const back = view?.back;
    reset();
    if (back) return back();
    return accountTypeFor(currentUser) === 'employee' ? officeTools.openDashboard() : showFleetSection('dashboard');
  });
  own.addEventListener('click',() => {
    if (!view || !active(view)) return;
    void companyDriverTools.openDocuments('tax',() => showPage(page.id));
  });

  return { canManage,open,reset };
})();
