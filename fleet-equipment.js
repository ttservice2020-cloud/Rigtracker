const fleetEquipment = (() => {
  const byId = id => document.getElementById(id);
  const record = byId('fleetEquipmentRecord');
  const details = byId('fleetEquipmentDetails');
  const detailsForm = byId('fleetEquipmentDetailsForm');
  const editDetails = byId('fleetEquipmentEdit');
  const documents = byId('fleetEquipmentDocs');
  const maintenance = byId('fleetEquipmentMaintenance');
  const historyPanel = byId('fleetEquipmentHistory');
  const trailerPosition = byId('fleetEquipmentTrailerPosition');
  const maintenanceForm = byId('fleetEquipmentMaintenanceForm');
  const upload = byId('fleetEquipmentUpload');
  const picker = byId('fleetEquipmentPicker');
  const labels = { truck: 'Truck', trailer: 'Trailer' };
  const requiredFields = ['unit_number', 'equipment_type', 'vin'];
  const fields = [...requiredFields, 'make', 'model', 'model_year', 'plate', 'next_pm', 'inspection_date'];
  const columns = ['id', ...fields, 'out_of_service', 'updated_at'].join(',');
  const table = 'fleet_equipment';
  const fileBucket = 'fleet-equipment-documents';
  let workspace;
  let pick;

  function element(tag, text = '', className = '') {
    const item = document.createElement(tag);
    item.textContent = text;
    item.className = className;
    return item;
  }

  function button(label, action) {
    const control = element('button', label, 'outline');
    control.type = 'button';
    control.addEventListener('click', action);
    return control;
  }

  async function list(fleet) {
    const rows = [];
    const pageSize = 250;
    for (let offset = 0; ; offset += pageSize) {
      const result = await supabaseClient.from(table).select(columns)
        .eq('fleet_id', fleet).order('unit_number').order('id').range(offset, offset + pageSize - 1);
      if (result.error) throw result.error;
      rows.push(...result.data);
      if (result.data.length < pageSize) return rows;
    }
  }

  function matches(query, values) {
    const terms = query.trim().toLowerCase().split(/\s+/);
    const text = values.join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  }

  function equipmentRows(rows, query, action) {
    return rows.filter(row => matches(query, [row.unit_number, labels[row.equipment_type], row.vin, row.make, row.model, row.plate]))
      .map(row => {
        const control = button(row.unit_number, () => action(row));
        control.dataset.status = row.out_of_service ? 'out' : 'good';
        control.setAttribute('aria-label', labels[row.equipment_type] + ' ' + row.unit_number +
          (row.out_of_service ? ', out of service' : ', in service'));
        return control;
      });
  }

  function renderList() {
    const rows = equipmentRows(workspace.rows, byId('fleetEquipmentSearch').value, edit);
    byId('fleetEquipmentList').replaceChildren(...rows);
    byId('fleetEquipmentStatus').textContent = rows.length ? '' : workspace.rows.length
      ? 'No matching equipment.' : 'No trucks or trailers saved.';
  }

  function renderAssignments() {
    const selection = workspace;
    if (!selection?.editDriver) return;
    const query = byId('fleetEquipmentDriverSearch').value;
    const cards = selection.drivers.filter(row => row.link_active !== false &&
      matches(query, [row.name, row.assigned_truck_number, row.assigned_trailer_number])).map(row => {
      const card = element('article', '', 'dispatch-load-row');
      const text = element('div');
      text.append(element('strong', row.name), element('p',
        'Truck ' + (row.assigned_truck_number || '—') + ' · Trailer ' + (row.assigned_trailer_number || '—'), 'muted'));
      const actions = element('div','','dispatch-actions');
      if (selection.viewDriverLoads) actions.append(button('View Loads', () => selection.viewDriverLoads(row)));
      actions.append(button('Edit Truck & Trailer', () => selection.editDriver(row)));
      card.append(text,actions);
      return card;
    });
    byId('fleetEquipmentDriverList').replaceChildren(...(cards.length ? cards : [element('p', 'No drivers found.', 'muted')]));
  }

  function setDrivers(fleet, rows) {
    if (workspace?.fleet !== fleet) return;
    if (workspace.editDriver) workspace.drivers = rows;
    renderAssignments();
    renderFacts();
    void refreshInventory(workspace);
    if (workspace.selection?.row?.equipment_type === 'trailer') void loadTrailerActivity(workspace, workspace.selection);
  }

  function saveFeedback(message = '') {
    const status = byId('fleetEquipmentSaveStatus');
    status.textContent = message;
    status.classList.toggle('hidden', !message);
  }

  function active(scope, selection) {
    return workspace === scope && currentUser === scope.user && (!selection || scope.selection === selection);
  }

  function showTab(tab) {
    for (const [key, panel, control] of [['details', details, 'fleetEquipmentDetailsTab'],
      ['documents', documents, 'fleetEquipmentDocsTab'], ['maintenance', maintenance, 'fleetEquipmentMaintenanceTab'],
      ['history', historyPanel, 'fleetEquipmentHistoryTab']]) {
      panel.classList.toggle('hidden', tab !== key);
      byId(control).setAttribute('aria-pressed', String(tab === key));
    }
    if (tab === 'documents') void loadDocuments(workspace, workspace.selection);
    if (tab === 'maintenance') void loadMaintenance(workspace, workspace.selection);
    if (tab === 'history') void loadTrailerActivity(workspace, workspace.selection, true);
  }

  function renderFacts() {
    const summary = byId('fleetEquipmentFacts');
    const row = workspace?.selection?.row;
    if (!row) return summary.replaceChildren();
    const assignees = workspace.drivers.filter(driver => driver.link_active !== false &&
      driver['assigned_' + row.equipment_type + '_number']?.toUpperCase() === row.unit_number.toUpperCase())
      .map(driver => driver.name);
    const facts = [
      ['Unit number', row.unit_number], ['Equipment type', labels[row.equipment_type]], ['Assigned driver', assignees.join(', ')],
      ['Make', row.make], ['Model', row.model], ['Year', row.model_year], ['VIN', row.vin], ['Plate', row.plate],
      ['Next PM', row.next_pm], ['Inspection Date', row.inspection_date]
    ];
    summary.replaceChildren(...facts.map(([label, value]) => {
      const fact = element('div');
      fact.append(element('dt', label), element('dd', value || '—'));
      return fact;
    }));
  }

  function showDetailsForm(open) {
    detailsForm.classList.toggle('hidden', !open);
    editDetails.setAttribute('aria-expanded', String(open));
  }

  function edit(row = null, back = null) {
    if (!workspace || workspace.selection?.saving) return;
    workspace.selection = { row, id: row?.id || crypto.randomUUID(), back };
    byId('fleetEquipmentClose').textContent = back ? 'Back to Driver Profile' : 'Close record';
    for (const field of fields) detailsForm.elements.namedItem(field).value = row?.[field] ?? '';
    editDetails.classList.toggle('hidden', !row);
    showDetailsForm(!row);
    upload.reset();
    maintenanceForm.reset();
    maintenanceForm.querySelector('button').disabled = false;
    maintenanceForm.classList.toggle('hidden', !workspace.canMaintain);
    upload.querySelector('button').disabled = false;
    byId('fleetEquipmentDocsList').replaceChildren();
    byId('fleetEquipmentDocsStatus').textContent = '';
    byId('fleetEquipmentDocsTab').classList.toggle('hidden', !row);
    byId('fleetEquipmentMaintenanceTab').classList.toggle('hidden', !row);
    const trailer = row?.equipment_type === 'trailer';
    byId('fleetEquipmentHistoryTab').classList.toggle('hidden', !trailer);
    trailerPosition.classList.toggle('hidden', !trailer);
    trailerPosition.replaceChildren();
    byId('fleetEquipmentHistoryList').replaceChildren();
    byId('fleetEquipmentHistoryMore').classList.add('hidden');
    const issue = byId('fleetEquipmentOpenIssue');
    issue.replaceChildren();
    issue.classList.add('hidden');
    byId('fleetEquipmentTitle').textContent = row ? labels[row.equipment_type] + ' ' + row.unit_number : 'Add Equipment';
    record.classList.remove('hidden');
    renderFacts();
    showTab('details');
    if (row) void loadMaintenance(workspace, workspace.selection);
    if (trailer) void loadTrailerActivity(workspace, workspace.selection);
    saveFeedback();
    byId(row ? 'fleetEquipmentTitle' : 'fleetEquipmentUnit').focus();
  }

  async function save(event) {
    event.preventDefault();
    const scope = workspace;
    const selection = scope?.selection;
    if (!selection || selection.saving) return;
    const data = new FormData(detailsForm);
    const values = Object.fromEntries(fields.map(field => [field, data.get(field).trim() || null]));
    values.vin = values.vin?.toUpperCase();
    if (!values.unit_number || !values.equipment_type || !/^[A-Z0-9-]{1,32}$/.test(values.vin)) {
      saveFeedback('Enter a unit number, choose a type, and enter the VIN using letters and numbers.');
      return;
    }
    const control = byId('fleetEquipmentSave');
    selection.saving = control.disabled = true;
    saveFeedback();
    try {
      const equipment = supabaseClient.from(table);
      const result = selection.row
        ? await equipment.update(values).eq('id', selection.id).eq('fleet_id', scope.fleet)
          .eq('updated_at', selection.row.updated_at).select().maybeSingle()
        : await equipment.insert({ ...values, fleet_id: scope.fleet, id: selection.id }).select().single();
      if (result.error) throw result.error;
      if (!result.data) throw Error('This equipment record changed. Reopen Equipment and try again.');
      if (!active(scope, selection)) return;
      scope.rows = [...scope.rows.filter(row => row.id !== result.data.id), result.data]
        .sort((a, b) => a.unit_number.localeCompare(b.unit_number));
      renderList();
      selection.saving = false;
      edit(result.data, selection.back);
      showToast('Equipment saved.');
      if (scope.editDriver) void fleetDispatchApp.reload();
    } catch (error) {
      if (active(scope, selection)) saveFeedback(error.code === '23505'
        ? 'That VIN or unit number is already saved for this fleet.' : error.message || 'Could not save the equipment.');
    } finally {
      if (workspace === scope) control.disabled = false;
      selection.saving = false;
    }
  }

  function storage() {
    return supabaseClient.storage.from(fileBucket);
  }

  function proControl(load, canOpen) {
    const pro = (load.return_of ? 'B-' : 'A-') + load.pro;
    if (!canOpen) return element('span', pro);
    const control = button(pro, () => void fleetDispatchApp.openRecord(load.id, 'equipment'));
    control.setAttribute('aria-label', 'Open load ' + pro);
    return control;
  }

  function renderTrailerPosition(data, canOpen) {
    const reported = element('p', 'Last reported location');
    const location = element('p', data.location || 'No stop address reported yet.', 'muted');
    const status = element('p', data.status || 'No load movement reported.', 'muted');
    const rows = [reported, location, status];
    if (data.current_load) {
      const load = element('div', '', 'dispatch-actions');
      load.append(element('span', 'Current PRO'), proControl(data.current_load, canOpen));
      rows.push(load);
    }
    if (data.next_pickup) {
      const pickup = element('div', '', 'dispatch-actions');
      pickup.append(element('span', 'Assigned pickup · ' + data.next_pickup.drivers), proControl(data.next_pickup, canOpen));
      rows.push(pickup);
    }
    trailerPosition.replaceChildren(...rows);
  }

  async function loadTrailerActivity(scope, selection, showHistory = false, more = false) {
    const cursor = more && selection.historyCursor;
    const args = { target_equipment: selection.id };
    if (cursor) Object.assign(args, { before_time: cursor.updated_at, before_load: cursor.id });
    const status = byId('fleetEquipmentHistoryStatus');
    const next = byId('fleetEquipmentHistoryMore');
    const history = byId('fleetEquipmentHistoryList');
    if (showHistory) {
      status.textContent = 'Loading trailer loads…';
      next.disabled = true;
      if (!more) history.replaceChildren();
    }
    try {
      const { data, error } = await supabaseClient.rpc('fleet_trailer_activity', args);
      if (error) throw error;
      if (!active(scope, selection)) return;
      renderTrailerPosition(data, Boolean(scope.editDriver));
      if (showHistory) {
        const rows = data.history.slice(0, 25);
        selection.historyCursor = rows.at(-1);
        history.append(...rows.map(load => proControl(load, Boolean(scope.editDriver))));
        next.classList.toggle('hidden', data.history.length <= 25);
        status.textContent = history.childElementCount ? '' : 'No previous loads for this trailer.';
      }
    } catch (error) {
      if (active(scope, selection)) {
        if (showHistory) status.textContent = error.message || 'Could not load trailer history.';
        else if (!trailerPosition.childElementCount) trailerPosition.textContent = 'Could not load the trailer’s last reported location.';
      }
    } finally {
      if (showHistory && active(scope, selection)) next.disabled = false;
    }
  }

  async function maintain(scope, selection, action, note = '', issue) {
    const status = byId('fleetEquipmentMaintenanceStatus');
    if (selection.maintenanceSaving) return;
    selection.maintenanceSaving = true;
    const clear = byId('fleetEquipmentClearIssue');
    const submit = maintenanceForm.querySelector('button');
    submit.disabled = true;
    if (clear) clear.disabled = true;
    try {
      const { error } = await supabaseClient.rpc('manage_equipment_maintenance', {
        action, target_equipment: selection.id, note, ...(issue ? { issue_id: issue.id } : {})
      });
      if (error) throw error;
      if (!active(scope, selection)) return;
      maintenanceForm.reset();
      await loadMaintenance(scope, selection);
      await refreshInventory(scope);
      showToast(issue ? 'Equipment back in service.' : 'Maintenance record added.');
    } catch (error) {
      if (active(scope, selection)) {
        const message = error.message || 'Could not update maintenance.';
        status.textContent = message;
        if (issue) showToast(message);
      }
    } finally {
      selection.maintenanceSaving = false;
      if (active(scope, selection)) {
        submit.disabled = false;
        if (clear) clear.disabled = false;
      }
    }
  }

  async function loadMaintenance(scope, selection) {
    const status = byId('fleetEquipmentMaintenanceStatus');
    const history = byId('fleetEquipmentMaintenanceList');
    const issueHost = byId('fleetEquipmentOpenIssue');
    const request = {};
    selection.maintenanceRequest = request;
    status.textContent = 'Loading maintenance records…';
    const ownRequest = () => active(scope, selection) && selection.maintenanceRequest === request;
    const records = () => supabaseClient.from('fleet_equipment_maintenance')
      .select('id,kind,note,created_at,cleared_at,resolution').eq('equipment_id', selection.id);
    try {
      const [openIssue, recent] = await Promise.all([
        records().eq('kind', 'out_of_service').is('cleared_at', null).maybeSingle(),
        records().order('created_at', { ascending: false }).limit(100)
      ]);
      if (!ownRequest()) return;
      if (openIssue.error || recent.error) throw openIssue.error || recent.error;
      const issue = openIssue.data;
      issueHost.classList.toggle('hidden', !issue);
      issueHost.replaceChildren();
      if (issue) {
        const alert = element('div', '', 'dispatch-form-issues');
        alert.setAttribute('role', 'status');
        alert.append(element('strong', 'Out of service'), element('p', issue.note));
        if (scope.canMaintain) {
          const clear = button('Clear Out of Service', () => void maintain(scope, selection, 'clear_issue', '', issue));
          clear.id = 'fleetEquipmentClearIssue';
          alert.append(clear);
        }
        issueHost.append(alert);
      }
      const rows = recent.data.map(entry => {
        const row = element('article', '', 'dispatch-load-card');
        const title = entry.kind === 'maintenance' ? 'Maintenance record' : entry.cleared_at ? 'Out-of-service issue cleared' : 'Open out-of-service issue';
        row.append(element('strong', title), element('p', entry.note),
          element('p', new Date(entry.created_at).toLocaleString(), 'muted'));
        if (entry.resolution) row.append(element('p', entry.resolution));
        return row;
      });
      history.replaceChildren(...rows);
      status.textContent = rows.length ? '' : 'No maintenance records yet.';
    } catch (error) {
      if (ownRequest()) status.textContent = error.message || 'Could not load maintenance records.';
    }
  }

  async function loadDocuments(scope, selection) {
    const status = byId('fleetEquipmentDocsStatus');
    const host = byId('fleetEquipmentDocsList');
    const folder = scope.fleet + '/' + selection.id;
    const request = {};
    selection.docRequest = request;
    status.textContent = 'Loading documents…';
    host.replaceChildren();
    const current = () => active(scope, selection) && selection.docRequest === request;
    try {
      const names = [];
      const bucket = storage();
      for (let offset = 0; ; offset += 100) {
        const result = await bucket.list(folder, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
        if (!current()) return;
        if (result.error) throw result.error;
        names.push(...result.data.filter(file => file.id).map(file => file.name));
        if (result.data.length < 100) break;
      }
      if (names.length) {
        const result = await bucket.createSignedUrls(names.map(name => folder + '/' + name), 3600);
        if (!current()) return;
        if (result.error) throw result.error;
        for (const [index, item] of result.data.entries()) {
          const row = element('div', '', 'dispatch-load-row');
          row.append(element('span', names[index].slice(37)));
          if (item.signedUrl) {
            const link = element('a', 'View Document', 'outline');
            link.href = item.signedUrl;
            link.target = '_blank';
            link.rel = 'noopener';
            row.append(link);
          }
          host.append(row);
        }
      }
      status.textContent = names.length ? '' : 'No documents uploaded for this unit.';
    } catch (error) {
      if (current()) status.textContent = error.message || 'Could not load equipment documents.';
    }
  }

  upload.addEventListener('submit', async event => {
    event.preventDefault();
    const scope = workspace;
    const selection = scope?.selection;
    const file = byId('fleetEquipmentFile').files[0];
    const control = upload.querySelector('button');
    if (!selection?.row || !file || control.disabled) return;
    const status = byId('fleetEquipmentDocsStatus');
    if (file.size > 10 * 1024 * 1024 || !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      status.textContent = 'Choose a PDF, JPEG, PNG, or WebP file up to 10 MB.';
      return;
    }
    const name = file.name.replace(/[^\w. -]/g, '_').trim().slice(0, 150) || 'document';
    const path = [scope.fleet, selection.id, crypto.randomUUID() + '-' + name].join('/');
    control.disabled = true;
    status.textContent = 'Uploading document…';
    try {
      const { error } = await storage().upload(path, file, { contentType: file.type });
      if (error) throw error;
      if (!active(scope, selection)) return;
      upload.reset();
      showToast('Equipment document saved.');
      await loadDocuments(scope, selection);
    } catch (error) {
      if (active(scope, selection)) status.textContent = error.message || 'Could not upload the document.';
    } finally {
      if (active(scope, selection)) control.disabled = false;
    }
  });

  function renderPicker() {
    const selection = pick;
    if (!selection?.rows) return;
    const rows = equipmentRows(selection.rows, byId('fleetEquipmentPickerQuery').value, row => {
      if (pick !== selection || currentUser !== selection.user) return;
      picker.close();
      selection.choose(row);
    });
    byId('fleetEquipmentPickerList').replaceChildren(...rows);
    byId('fleetEquipmentPickerStatus').textContent = rows.length ? '' : 'No matching equipment.';
  }

  async function openPicker(fleet, choose) {
    if (!fleet || !currentUser || picker.open) return;
    const selection = pick = { user: currentUser, choose };
    byId('fleetEquipmentPickerQuery').value = '';
    byId('fleetEquipmentPickerList').replaceChildren();
    const status = byId('fleetEquipmentPickerStatus');
    status.textContent = 'Loading equipment…';
    picker.showModal();
    try {
      selection.rows = await list(fleet);
      if (pick === selection && currentUser === selection.user) renderPicker();
    } catch (error) {
      if (pick === selection && currentUser === selection.user) status.textContent = error.message || 'Could not load equipment.';
    }
  }

  async function refreshInventory(scope) {
    if (scope.loading) return;
    scope.loading = true;
    try {
      const rows = await list(scope.fleet);
      if (!active(scope)) return;
      scope.rows = rows;
      renderList();
      const selected = scope.selection?.row;
      const current = selected && rows.find(row => row.id === selected.id);
      if (current && selected.out_of_service !== current.out_of_service) {
        if (fields.every(key => selected[key] === current[key])) scope.selection.row = current;
        else selected.out_of_service = current.out_of_service;
        void loadMaintenance(scope, scope.selection);
      }
    } catch (error) {
      if (active(scope) && !scope.rows.length) byId('fleetEquipmentStatus').textContent = error.message || 'Could not load equipment.';
    } finally { scope.loading = false; }
  }

  async function open(fleet, drivers, editDriver, canMaintain, viewDriverLoads) {
    const scope = workspace = { user: currentUser, fleet, rows: [], drivers, editDriver, canMaintain, viewDriverLoads };
    record.classList.add('hidden');
    byId('fleetEquipmentDriverAssignments').classList.toggle('hidden', !editDriver);
    byId('fleetEquipmentSearch').value = byId('fleetEquipmentDriverSearch').value = '';
    byId('fleetEquipmentList').replaceChildren();
    byId('fleetEquipmentAdd').classList.add('hidden');
    byId('fleetEquipmentSave').disabled = false;
    const status = byId('fleetEquipmentStatus');
    status.textContent = 'Loading equipment…';
    renderAssignments();
    await refreshInventory(scope);
    if (active(scope)) byId('fleetEquipmentAdd').classList.remove('hidden');
    if (!editDriver) {
      const { data } = await supabaseClient.rpc('fleet_equipment_assignments', { target_fleet: fleet });
      if (active(scope) && data) {
        scope.drivers = data;
        renderFacts();
      }
    }
  }

  async function openRecord(fleet, id, back) {
    const scope = workspace;
    if (scope?.fleet !== fleet || !active(scope)) throw Error('Equipment access is required.');
    const { data, error } = await supabaseClient.from(table).select(columns)
      .eq('fleet_id', fleet).eq('id', id).maybeSingle();
    if (!active(scope)) return;
    if (error) throw error;
    if (!data) throw Error('This unit is no longer available in Equipment.');
    edit(data, back);
  }

  function reset() {
    workspace = pick = null;
    if (picker.open) picker.close();
    for (const id of ['fleetEquipmentList','fleetEquipmentDriverList','fleetEquipmentDocsList','fleetEquipmentPickerList'])
      byId(id).replaceChildren();
  }

  byId('fleetEquipmentAdd').addEventListener('click', () => edit());
  byId('fleetEquipmentSearch').addEventListener('input', () => { if (workspace) renderList(); });
  byId('fleetEquipmentDriverSearch').addEventListener('input', renderAssignments);
  byId('fleetEquipmentDetailsTab').addEventListener('click', () => showTab('details'));
  byId('fleetEquipmentDocsTab').addEventListener('click', () => showTab('documents'));
  byId('fleetEquipmentMaintenanceTab').addEventListener('click', () => showTab('maintenance'));
  byId('fleetEquipmentHistoryTab').addEventListener('click', () => showTab('history'));
  byId('fleetEquipmentHistoryMore').addEventListener('click', () =>
    void loadTrailerActivity(workspace, workspace.selection, true, true));
  maintenanceForm.addEventListener('submit', event => {
    event.preventDefault();
    const note = maintenanceForm.elements.note.value.trim();
    if (workspace?.selection?.row && note) void maintain(workspace, workspace.selection, 'add_record', note);
  });
  byId('fleetEquipmentClose').addEventListener('click', () => {
    const selection = workspace?.selection;
    if (!selection || selection.saving) return;
    workspace.selection = null;
    record.classList.add('hidden');
    if (selection.back) {
      void selection.back();
      return;
    }
    byId('fleetEquipmentSearch').focus();
  });
  editDetails.addEventListener('click', () => {
    const open = detailsForm.classList.contains('hidden');
    showDetailsForm(open);
    if (open) byId('fleetEquipmentUnit').focus();
  });
  detailsForm.addEventListener('submit', save);
  byId('fleetEquipmentPickerClose').addEventListener('click', () => picker.close());
  byId('fleetEquipmentPickerQuery').addEventListener('input', renderPicker);
  picker.addEventListener('close', () => { if (!picker.open) pick = null; });

  return { open, openRecord, setDrivers, openPicker, reset };
})();
