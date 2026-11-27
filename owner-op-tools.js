const ownerOpTools = (() => {
  const byId = id => document.getElementById(id);
  const ownerRole = () => Boolean(currentUser && accountTypeFor(currentUser) === 'driver');
  const taxBucket = 'tax-documents';
  const documentBucket = 'owner-op-documents';
  const taxTypes = {
    '1099-nec': '1099-NEC', '1099-misc': '1099-MISC', '1099-k': '1099-K',
    w2: 'W-2', w9: 'W-9', other: 'Other'
  };
  const fileTypes = {
    'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
    'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif'
  };
  const truckTable = 'owner_op_trucks';
  const truckPage = byId('ownerOpTrucksPage');
  const truckForm = byId('ownerOpTruckForm');
  const truckList = byId('ownerOpTruckList');
  const truckStatus = byId('ownerOpTruckStatus');
  const truckSave = byId('ownerOpTruckSave');
  const truckAdd = byId('ownerOpTruckAdd');
  const truckCancel = byId('ownerOpTruckCancel');
  const truckFields = ['unit_number', 'model_year', 'make', 'model', 'vin', 'plate'];
  const fleetPage = byId('ownerOpFleetPage');
  const fleetForm = byId('ownerOpFleetSetup');
  const fleetStatus = byId('ownerOpFleetStatus');
  const fleetSave = byId('ownerOpFleetSave');
  let trucks;
  let fleet;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(label, handler, className = 'outline') {
    const control = node('button', label, className);
    control.type = 'button';
    control.addEventListener('click', handler);
    return control;
  }

  function describeFile(name, tax) {
    const match = /^(?:([a-z0-9-]+)--)?[0-9a-f-]{36}--(.+)$/i.exec(name);
    const type = !tax ? '' : Object.hasOwn(taxTypes, match?.[1]) ? taxTypes[match[1]] : 'Uncategorized';
    if (match) return { name: match[2], type };
    return { name: tax ? name.replace(/^tax-\d+-/, '') : name, type };
  }

  function mountDocuments(host, tax = false) {
    host.replaceChildren();
    if (!ownerRole()) return;
    const user = currentUser;
    const bucket = tax ? taxBucket : documentBucket;
    const store = supabaseClient.storage.from(bucket);
    const input = node('input', '', 'hidden');
    input.type = 'file';
    input.accept = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif';
    input.setAttribute('data-document-scan', '');
    const picker = node('select');
    const status = node('p', '', 'muted');
    status.setAttribute('role', 'status');
    const list = node('div', '', 'dispatch-load-list');
    const controls = node('div', '', 'dispatch-actions');
    let request = null;
    let busy = false;
    const current = () => currentUser === user && host.contains(input) && Boolean(host.closest('.page.active'));
    const upload = button(tax ? 'Upload Tax Document' : 'Upload Document', () => {
      if (current() && (!tax || picker.reportValidity())) input.click();
    }, 'primary-btn');
    const scan = button(tax ? 'Scan Tax Document' : 'Scan Document', () => {
      if (current() && (!tax || picker.reportValidity())) void driverPaperwork.captureDocument(input);
    });
    const refresh = button('Refresh', () => void read());
    controls.append(scan, upload, refresh);
    host.append(node('h2', tax ? 'My Tax Documents' : 'My Documents'));
    if (tax) {
      const field = node('div', '', 'field');
      const label = node('label', 'Tax document type');
      picker.id = host.id + '-tax-type';
      label.htmlFor = picker.id;
      picker.required = true;
      picker.append(new Option('Select document type', ''), ...Object.entries(taxTypes).map(([key, name]) => new Option(name, key)));
      field.append(label, picker);
      host.append(field);
    }
    host.append(controls, input, status, list);

    function setBusy(value) {
      busy = value;
      upload.disabled = scan.disabled = input.disabled = picker.disabled = refresh.disabled = value;
    }

    async function read() {
      if (!current()) return;
      const readRequest = {};
      request = readRequest;
      status.textContent = 'Loading documents…';
      try {
        const { data, error } = await store.list(user.id, { limit: 100, sortBy: { column: 'created_at', order: 'desc' } });
        if (request !== readRequest || !current()) return;
        if (error) throw error;
        const files = data.filter(file => file.id);
        const rows = files.map(file => {
          const info = describeFile(file.name, tax);
          const path = user.id + '/' + file.name;
          const row = node('article', '', 'dispatch-load-row');
          const title = node('div');
          title.append(node('strong', info.name));
          if (info.type) title.append(node('p', info.type, 'muted'));
          const actions = node('div', '', 'dispatch-actions');
          actions.append(button('Open', () => {
            if (current()) void payrollWithholdingForms.openFile(bucket, path, info.name);
          }), button('Download', () => {
            if (current()) void payrollWithholdingForms.openFile(bucket, path, info.name, true);
          }), button('Delete', () => void remove(path, info.name)));
          row.append(title, actions);
          return row;
        });
        list.replaceChildren(...rows);
        status.textContent = rows.length ? '' : 'No documents uploaded yet.';
      } catch {
        if (request === readRequest && current()) status.textContent = 'Could not load documents. Try refreshing.';
      }
    }

    async function remove(path, name) {
      if (!current() || busy || !window.confirm('Delete ' + name + '?')) return;
      request = null;
      setBusy(true);
      try {
        const { error } = await store.remove([path]);
        if (error) throw error;
        if (current()) {
          showToast('Document deleted.');
          await read();
        }
      } catch {
        if (current()) status.textContent = 'Could not delete the document. Try again.';
      } finally {
        setBusy(false);
      }
    }

    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.value = '';
      if (!file || !current() || busy || (tax && !Object.hasOwn(taxTypes, picker.value))) return;
      const pickedExtension = file.name.split('.').at(-1).toLowerCase();
      const mime = fileTypes[file.type] ? file.type
        : !file.type || file.type === 'application/octet-stream'
          ? Object.keys(fileTypes).find(type => fileTypes[type] === (pickedExtension === 'jpeg' ? 'jpg' : pickedExtension))
          : null;
      if (!mime || !file.size || (!tax && file.size > 10485760)) {
        status.textContent = tax ? 'Choose a PDF or a supported image.' : 'Choose a PDF or a supported image up to 10 MB.';
        return;
      }
      const title = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9 ._-]/gi, '_').trim().slice(0, 100) || 'Document';
      const prefix = tax ? picker.value + '--' : '';
      const path = user.id + '/' + prefix + crypto.randomUUID() + '--' + title + '.' + fileTypes[mime];
      request = null;
      setBusy(true);
      status.textContent = 'Uploading document…';
      try {
        const { error } = await store.upload(path, file, { contentType: mime });
        if (error) throw error;
        if (current()) {
          showToast('Document uploaded.');
          await read();
        }
      } catch {
        if (current()) status.textContent = 'Could not upload the document. Try again.';
      } finally {
        setBusy(false);
      }
    });
    void read();
  }

  function currentTrucks(scope) {
    return trucks === scope && currentUser === scope.user && truckPage.classList.contains('active');
  }

  function editTruck(row = null, show = true) {
    if (!trucks || trucks.busy) return;
    trucks.edit = row;
    truckForm.reset();
    for (const key of truckFields) truckForm.elements.namedItem(key).value = row?.[key] ?? '';
    byId('ownerOpTruckFormTitle').textContent = row ? 'Edit Truck' : 'Add Truck';
    byId('ownerOpTruckFormStatus').textContent = '';
    truckForm.classList.toggle('hidden', !show);
    truckAdd.setAttribute('aria-expanded', String(show));
    if (show) truckForm.elements.unit_number.focus();
  }

  function paintTrucks(scope) {
    truckList.replaceChildren(...scope.rows.map(row => {
      const card = node('article', '', 'panel');
      card.append(node('h2', 'Truck ' + row.unit_number));
      const vehicle = [row.model_year, row.make, row.model].filter(Boolean).join(' ');
      if (vehicle) card.append(node('p', vehicle));
      if (row.vin) card.append(node('p', 'VIN ' + row.vin));
      if (row.plate) card.append(node('p', 'Plate ' + row.plate));
      const actions = node('div', '', 'dispatch-actions');
      actions.append(button('Edit', () => editTruck(row)), button('Remove', () => void removeTruck(row)));
      card.append(actions);
      return card;
    }));
    truckStatus.textContent = scope.rows.length
      ? scope.rows.length + (scope.rows.length === 1 ? ' truck' : ' trucks') : 'No truck profiles yet.';
  }

  async function readTrucks(scope) {
    if (!currentTrucks(scope) || scope.reading) return;
    scope.reading = true;
    truckStatus.textContent = 'Loading trucks…';
    truckAdd.disabled = true;
    try {
      const { data, error } = await supabaseClient.from(truckTable)
        .select('id,unit_number,model_year,make,model,vin,plate').eq('user_id', scope.user.id).order('unit_number');
      if (!currentTrucks(scope)) return;
      if (error) throw error;
      scope.rows = data;
      paintTrucks(scope);
    } catch {
      if (currentTrucks(scope)) truckStatus.textContent = 'Could not load your trucks. Try refreshing.';
    } finally {
      scope.reading = false;
      if (currentTrucks(scope)) truckAdd.disabled = false;
    }
  }

  function truckBusy(scope, busy) {
    scope.busy = busy;
    if (currentTrucks(scope)) truckAdd.disabled = truckSave.disabled = truckCancel.disabled = busy;
  }

  async function removeTruck(row) {
    const scope = trucks;
    if (!scope || !currentTrucks(scope) || scope.busy || scope.reading ||
        !window.confirm('Remove truck ' + row.unit_number + '?')) return;
    truckBusy(scope, true);
    try {
      const { error } = await supabaseClient.from(truckTable).delete().eq('user_id', scope.user.id)
        .eq('id', row.id).select('id').single();
      if (!currentTrucks(scope)) return;
      if (error) throw error;
      scope.rows = scope.rows.filter(truck => truck.id !== row.id);
      if (scope.edit?.id === row.id) {
        truckBusy(scope, false);
        editTruck(null, false);
      }
      paintTrucks(scope);
      showToast('Truck removed.');
    } catch {
      if (currentTrucks(scope)) truckStatus.textContent = 'Could not remove this truck. Try refreshing.';
    } finally {
      truckBusy(scope, false);
    }
  }

  truckForm.addEventListener('submit', async event => {
    event.preventDefault();
    const scope = trucks;
    if (!scope || !currentTrucks(scope) || scope.busy || scope.reading) return;
    const editing = scope.edit;
    const values = Object.fromEntries(truckFields.map(key => [key, truckForm.elements.namedItem(key).value.trim() || null]));
    const problem = byId('ownerOpTruckFormStatus');
    if (!values.unit_number) {
      problem.textContent = 'Enter the truck number.';
      return;
    }
    values.unit_number = values.unit_number.toUpperCase();
    if (values.model_year) values.model_year = Number(values.model_year);
    if (values.vin) values.vin = values.vin.toUpperCase();
    const source = supabaseClient.from(truckTable);
    truckBusy(scope, true);
    problem.textContent = 'Saving truck…';
    try {
      const write = editing ? source.update(values).eq('user_id', scope.user.id).eq('id', editing.id)
        : source.insert({ ...values, user_id: scope.user.id });
      const { data, error } = await write.select('id,unit_number,model_year,make,model,vin,plate').single();
      if (!currentTrucks(scope)) return;
      if (error) throw error;
      scope.rows = [...scope.rows.filter(row => row.id !== data.id), data]
        .sort((a, b) => a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }));
      truckBusy(scope, false);
      editTruck(null, false);
      paintTrucks(scope);
      showToast('Truck saved.');
    } catch (error) {
      if (currentTrucks(scope)) problem.textContent = error.code === '23505' ? 'That truck number is already in use.'
        : 'Could not save this truck. Try again.';
    } finally {
      truckBusy(scope, false);
    }
  });

  function openTrucks() {
    if (!ownerRole()) return;
    trucks = { user: currentUser, rows: [], edit: null, reading: false, busy: false };
    truckList.replaceChildren();
    truckSave.disabled = truckCancel.disabled = false;
    editTruck(null, false);
    showPage('ownerOpTrucksPage');
    return readTrucks(trucks);
  }

  truckAdd.addEventListener('click', () => editTruck());
  truckCancel.addEventListener('click', () => editTruck(null, false));
  byId('ownerOpTruckRefresh').addEventListener('click', () => { if (trucks && !trucks.busy) void readTrucks(trucks); });

  function managesFleet(id) {
    return Boolean(id && ownerRole() && fleet?.user === currentUser && fleet.id === id);
  }

  function dispatchAccess(id) {
    if (!managesFleet(id)) return undefined;
    return { dispatch:true, drivers:true, equipment:false, maintenance:false, paySettings:true,
      messages:true, processing:false, ownerOpTrucks:fleet.truckNumbers };
  }

  function fleetPageCurrent(scope) {
    return fleet === scope && currentUser === scope.user && fleetPage.classList.contains('active');
  }

  function paintFleet(scope) {
    fleetForm.classList.toggle('hidden', Boolean(scope.id));
    byId('ownerOpFleetActions').classList.toggle('hidden', !scope.id);
    fleetStatus.textContent = scope.id ? 'Fleet ID ' + scope.id : '';
  }

  async function openFleet() {
    if (!ownerRole()) return;
    const scope = { user: currentUser, id: null, truckNumbers: [] };
    fleet = scope;
    fleetForm.reset();
    fleetForm.classList.add('hidden');
    byId('ownerOpFleetActions').classList.add('hidden');
    fleetSave.disabled = false;
    fleetStatus.textContent = 'Loading your fleet…';
    showPage('ownerOpFleetPage');
    try {
      const [owned, units] = await Promise.all([
        supabaseClient.from('fleets').select('id').eq('admin_user_id', scope.user.id).maybeSingle(),
        supabaseClient.from(truckTable).select('unit_number').eq('user_id', scope.user.id).order('unit_number')
      ]);
      if (!fleetPageCurrent(scope)) return;
      if (owned.error) throw owned.error;
      scope.id = owned.data?.id ?? null;
      scope.truckNumbers = (units.data || []).map(truck => truck.unit_number);
      paintFleet(scope);
    } catch {
      if (fleetPageCurrent(scope)) fleetStatus.textContent = 'Could not load your fleet. Reopen My Fleet to try again.';
    }
  }

  fleetForm.addEventListener('submit', async event => {
    event.preventDefault();
    const scope = fleet;
    if (!scope || !fleetPageCurrent(scope) || scope.id || fleetSave.disabled) return;
    const requested = byId('ownerOpFleetId').value.trim().toLowerCase();
    fleetSave.disabled = true;
    fleetStatus.textContent = 'Setting up your fleet…';
    try {
      const { data, error } = await supabaseClient.rpc('register_fleet', { requested_id:requested });
      if (!fleetPageCurrent(scope)) return;
      if (error) throw error;
      scope.id = data;
      paintFleet(scope);
      showToast('Your fleet is ready.');
    } catch (error) {
      if (fleetPageCurrent(scope)) fleetStatus.textContent = error.code === '23505' ? 'That Fleet ID is already in use.'
        : error.code === '42501' ? 'Confirm your email before setting up your fleet.' : 'Could not set up your fleet. Try again.';
    } finally {
      if (fleetPageCurrent(scope)) fleetSave.disabled = false;
    }
  });

  function enterFleet(section, tab = 'current') {
    if (!managesFleet(fleet?.id)) return;
    adminFleetId = fleet.id;
    fleetLoadState = 'ready';
    return showFleetSection(section, tab);
  }

  function reset() {
    trucks = null;
    fleet = null;
    truckForm.reset();
    truckList.replaceChildren();
    truckStatus.textContent = '';
    byId('ownerOpTruckFormStatus').textContent = '';
    fleetForm.reset();
    fleetStatus.textContent = '';
    for (const id of ['ownerOpPersonalFiles', 'ownerTaxDocuments']) byId(id).replaceChildren();
  }

  return { mountDocuments, openTrucks, openFleet, enterFleet, managesFleet, dispatchAccess, reset };
})();
