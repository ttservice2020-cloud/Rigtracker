const fleetDispatchApp = (() => {
  const byId = id => document.getElementById(id);
  const toggle = (id, visible) => byId(id).classList.toggle('hidden', !visible);
  const form = byId('dispatchLoadForm');
  const driverForm = byId('dispatchDriverForm');
  const tabs = [...byId('dispatchTabs').querySelectorAll('[role=tab]')];
  const stops = { pickup: byId('dispatchPickups'), receiver: byId('dispatchReceivers') };
  const formDetails = [
    'secondDriverMode', 'commodity', 'commodityOther', 'weightLbs', 'equipmentType', 'equipmentTypeOther',
    'trailerDrop', 'trailerDropNotes', 'trailerPickup', 'trailerPickupNotes',
    'payGross', 'loadedMiles', 'relayLocation', 'relayDate', 'relayDrop',
    'relayPickup', 'firstLegMiles', 'driver1Pay', 'driver2Pay', 'emptyMiles', 'emptyRate', 'stopPay'
  ].filter(key => form.elements.namedItem(key));
  const conditionalFreightFields = [
    ['commodity', 'commodityOther', 'dispatchCommodityOtherField'],
    ['equipmentType', 'equipmentTypeOther', 'dispatchEquipmentTypeOtherField'],
    ['trailerDrop', 'trailerDropNotes', 'dispatchTrailerDropNotesField'],
    ['trailerPickup', 'trailerPickupNotes', 'dispatchTrailerPickupNotesField']
  ].filter(([key]) => form.elements.namedItem(key));
  const zones = [
    ['America/New_York', 'Eastern'], ['America/Chicago', 'Central'],
    ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'],
    ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'],
    ['Pacific/Honolulu', 'Hawaii']
  ];
  const loadTable = 'fleet_dispatch_loads';
  const driverTable = 'fleet_dispatch_drivers';
  const fuelTable = 'fleet_dispatch_fuel_rates';
  const payLabels = { hourly: 'Hourly', split: 'Split Load', per_mile: 'Flat Rate per Mile' };
  const payCurrency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
  const payRate = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
  let state;
  let edit;
  let stopId = 0;
  let selectedTab = 'current';

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(label, action) {
    const node = element('button', label, 'outline');
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function selectTab(tab, focus = false) {
    selectedTab = tab;
    for (const node of tabs) {
      const selected = node.dataset.dispatchTab === tab;
      node.setAttribute('aria-selected', String(selected));
      node.tabIndex = selected ? 0 : -1;
      toggle(node.getAttribute('aria-controls'), selected);
      if (selected && focus) node.focus();
    }
  }

  byId('dispatchTabs').addEventListener('keydown', event => {
    const index = tabs.indexOf(event.target);
    if (index < 0) return;
    const landing = {
      ArrowLeft: (index + tabs.length - 1) % tabs.length,
      ArrowRight: (index + 1) % tabs.length,
      Home: 0,
      End: tabs.length - 1
    }[event.key];
    if (landing === undefined) return;
    event.preventDefault();
    selectTab(tabs[landing].dataset.dispatchTab, true);
  });
  for (const node of tabs) node.addEventListener('click', () => selectTab(node.dataset.dispatchTab));

  function proLabel(number) {
    return state.fleetId.toUpperCase() + '-' + number;
  }

  function cityState(stop) {
    return [stop?.city, stop?.state].filter(Boolean).join(', ');
  }

  function route(load) {
    const { pickups, receivers } = load.details;
    return [cityState(pickups?.[0]), cityState(receivers?.at(-1))].filter(Boolean).join(' → ');
  }

  function loadDrivers(load) {
    return [load.driver_id, load.second_driver_id]
      .map(id => state.drivers.find(driver => driver.id === id)?.name)
      .filter(Boolean).join(' / ');
  }

  function lastContractAssignment(contract) {
    return state.loads.reduce((last, load) => {
      if (load.contract_load_id !== contract.id || !load.assigned_at) return last;
      return !last || load.assigned_at > last.assigned_at ? load : last;
    }, null);
  }

  function deliverySchedule(load) {
    const stop = load.details.receivers?.[0];
    if (!stop) return '';
    const location = cityState(stop);
    const zone = zones.find(([value]) => value === stop.zone)?.[1];
    const schedule = [stop.date, stop.from, zone].filter(Boolean).join(' ');
    return [location && 'Delivery: ' + location, schedule].filter(Boolean).join(' · ');
  }

  function matchesLoad(load, search) {
    const words = [proLabel(load.pro_number), loadDrivers(load)];
    for (const stop of [...(load.details.pickups || []), ...(load.details.receivers || [])]) {
      words.push(stop.company, stop.address, cityState(stop), stop.zip);
    }
    return words.join(' ').toLowerCase().includes(search);
  }

  function loadRow(load, actionLabel, action) {
    const row = element('article', '', 'dispatch-load-row');
    const info = element('div');
    info.append(element('strong', proLabel(load.pro_number)));
    const lastRun = load.status === 'contract' ? lastContractAssignment(load) : null;
    const drivers = loadDrivers(lastRun || load);
    const driverLabel = load.status === 'contract' && drivers
      ? (lastRun ? 'Last assigned: ' : 'Saved driver: ') + drivers : drivers;
    const label = [route(load), driverLabel].filter(Boolean).join(' · ');
    if (label) info.append(element('p', label));
    const { commodity, commodityOther, weightLbs, equipmentType, equipmentTypeOther, trailerDrop, trailerPickup } = load.details;
    const weight = Number(weightLbs);
    const freight = [
      commodity === 'Other' ? commodityOther || commodity : commodity,
      Number.isFinite(weight) && weight > 0 ? weight.toLocaleString(undefined, { maximumFractionDigits: 2 }) + ' lb' : '',
      equipmentType === 'Other' ? equipmentTypeOther || equipmentType : equipmentType,
      trailerDrop === 'yes' ? 'Trailer Drop' : '',
      trailerPickup === 'yes' ? 'Trailer Pickup' : ''
    ].filter(Boolean).join(' · ');
    if (freight) info.append(element('p', freight));
    const schedule = deliverySchedule(load);
    if (schedule) info.append(element('p', schedule));
    row.append(info, button(actionLabel, action));
    return row;
  }

  function paintLoads() {
    const search = byId('dispatchLoadSearch').value.trim().toLowerCase();
    const current = state.loads.filter(load => load.status === 'current');
    const matching = current.filter(load => matchesLoad(load, search));
    const drafts = state.loads.filter(load => load.status === 'draft' && matchesLoad(load, search));
    const contracts = state.loads.filter(load => load.status === 'contract');
    const history = state.loads.filter(load => load.status === 'completed');

    byId('dispatchRailStatus').textContent = state.loaded
      ? (current.length ? current.length + ' active' : 'No current loads')
      : (state.failed ? 'Loads unavailable' : 'Loading loads…');
    byId('dispatchRailList').replaceChildren(...current.map(load => {
      const row = button('', () => openLoad(load));
      row.className = '';
      row.append(element('strong', proLabel(load.pro_number)));
      for (const detail of [route(load), loadDrivers(load), deliverySchedule(load)].filter(Boolean)) {
        row.append(element('small', detail));
      }
      return row;
    }));
    byId('dispatchCurrentEmpty').textContent = matching.length || !state.loaded
      ? '' : (search ? 'No active loads match your search.' : 'No active loads.');
    byId('dispatchCurrentList').replaceChildren(...matching.map(load => loadRow(load, 'Open', () => openLoad(load))));
    toggle('dispatchDraftSection', drafts.length > 0);
    byId('dispatchDraftList').replaceChildren(...drafts.map(load => loadRow(load, 'Open Draft', () => openLoad(load))));
    byId('dispatchContractEmpty').textContent = contracts.length || !state.loaded ? '' : 'No contract loads.';
    byId('dispatchContractList').replaceChildren(...contracts.map(load => loadRow(load, 'Use Contract', () => openLoad(load, true))));
    byId('dispatchHistoryEmpty').textContent = history.length || !state.loaded ? '' : 'No completed loads.';
    byId('dispatchHistoryList').replaceChildren(...history.map(load => loadRow(load, 'View', () => openLoad(load))));
  }

  function paintDrivers() {
    const search = byId('dispatchDriverSearch').value.trim().toLowerCase();
    const filter = byId('dispatchDriverFilter').value;
    const assignments = new Map();
    for (const load of state.loads.filter(entry => entry.status === 'current')) {
      for (const id of [load.driver_id, load.second_driver_id].filter(Boolean)) {
        if (!assignments.has(id)) assignments.set(id, []);
        assignments.get(id).push(proLabel(load.pro_number));
      }
    }
    const rows = [];
    for (const driver of state.drivers) {
      const active = assignments.get(driver.id);
      const availability = active ? 'assigned' : driver.availability;
      if (filter && filter !== availability) continue;
      if (!(driver.name + ' ' + driver.equipment).toLowerCase().includes(search)) continue;
      const row = element('article', '', 'dispatch-load-row');
      const info = element('div');
      const label = active ? 'On a load · ' + active.join(', ') : availability === 'available' ? 'Available' : 'Off duty';
      info.append(element('strong', driver.name), element('p', label));
      if (driver.equipment) info.append(element('p', driver.equipment));
      if (driver.driver_type) {
        info.append(element('p', driver.driver_type === 'owner_op' ? 'Owner Op · ' + payLabels[driver.pay_method] : 'Company Driver'));
      }
      const actions = element('div', '', 'dispatch-actions');
      if (byId('dispatchPayProfileForm')) actions.append(button('Edit Pay Profile', () => editPayProfile(driver)));
      row.append(info, actions);
      if (!active) {
        const next = availability === 'available' ? 'off-duty' : 'available';
        const control = button(next === 'available' ? 'Set Available' : 'Set Off Duty', () => setAvailability(driver, next, control));
        actions.append(control);
      }
      rows.push(row);
    }
    byId('dispatchDriversEmpty').textContent = rows.length || !state.loaded ? ''
      : (state.drivers.length ? 'No drivers match this filter.' : 'No drivers yet. Add a driver to assign a load.');
    byId('dispatchDriversList').replaceChildren(...rows);

    for (const id of ['dispatchDriver1', 'dispatchDriver2']) {
      const select = byId(id);
      const value = select.value;
      const options = state.drivers.map(driver => new Option(driver.name, driver.id));
      if (value && !state.drivers.some(driver => driver.id === value)) options.push(new Option('Driver unavailable', value));
      select.replaceChildren(new Option('Select a driver', ''), ...options);
      select.value = value;
    }
    paintDriverPay();
  }

  async function readRecords(scope, table, sort, ascending) {
    const rows = [];
    const pageSize = 250;
    while (state === scope) {
      const result = await scope.client.from(table).select('*').eq('fleet_id', scope.fleetId)
        .order(sort, { ascending }).order('id').range(rows.length, rows.length + pageSize - 1);
      if (result.error) throw result.error;
      rows.push(...result.data);
      if (result.data.length < pageSize) break;
    }
    return rows;
  }

  async function refresh() {
    const scope = state;
    if (!scope) return;
    const request = {};
    scope.readRequest = request;
    try {
      const [loads, drivers] = await Promise.all([
        readRecords(scope, loadTable, 'updated_at', false),
        readRecords(scope, driverTable, 'name', true)
      ]);
      if (state !== scope || scope.readRequest !== request) return;
      Object.assign(scope, { loads, drivers, loaded: true, failed: false });
      toggle('dispatchReadError', false);
    } catch (error) {
      if (state !== scope || scope.readRequest !== request) return;
      scope.failed = true;
      toggle('dispatchReadError', true);
    }
    paintLoads();
    paintDrivers();
  }

  function addStop(kind, data = {}) {
    const container = stops[kind];
    if (container.children.length >= 12) {
      showToast('A load can have up to 12 ' + (kind === 'pickup' ? 'shipper' : 'receiver') + ' stops.');
      return;
    }
    const group = element('fieldset', '', 'dispatch-stop');
    const fields = element('div', '', 'dispatch-fields');
    const prefix = 'dispatch-stop-' + (++stopId) + '-';
    const field = (key, label, input, { required = false, wide = false } = {}) => {
      input.id = prefix + key;
      input.dataset.stopField = key;
      input.required = required;
      if (input.type === 'checkbox') input.checked = Boolean(data[key]);
      else input.value = data[key] ?? '';
      const caption = element('label', label);
      caption.htmlFor = input.id;
      const wrapper = element('div', '', 'field' + (wide ? ' dispatch-wide' : '') +
        (input.type === 'checkbox' ? ' dispatch-checkbox' : ''));
      wrapper.append(caption, input);
      fields.append(wrapper);
    };
    const input = (type = 'text', max) => {
      const node = element('input');
      node.type = type;
      if (max) node.maxLength = max;
      return node;
    };
    const required = { required: true };
    field('company', kind === 'pickup' ? 'Shipper name' : 'Receiver company name', input('text', 120), { required: true, wide: true });
    field('date', kind === 'pickup' ? 'Pickup date' : 'Receiver date', input('date'), required);
    const zone = element('select');
    zone.append(new Option('Select time zone', ''), ...zones.map(([value, label]) => new Option(label, value)));
    field('zone', 'Time zone', zone, required);
    field('from', 'From time', input('time'), required);
    field('to', 'To time (optional)', input('time'));
    field('address', 'Street address', input('text', 180), { required: true, wide: true });
    field('city', 'City', input('text', 80), required);
    const region = input('text', 2);
    region.pattern = '[A-Za-z]{2}';
    region.autocapitalize = 'characters';
    field('state', 'State', region, required);
    const zip = input('text', 10);
    zip.inputMode = 'numeric';
    zip.pattern = '[0-9]{5}(-[0-9]{4})?';
    field('zip', 'ZIP', zip, required);
    if (kind === 'receiver') field('phone', 'Contact number (optional)', input('tel', 40));
    const notes = element('textarea');
    notes.maxLength = 1200;
    notes.rows = 2;
    field('notes', kind === 'pickup' ? 'Pickup notes' : 'Receiver notes', notes, { wide: true });
    data = { driver1: true, ...data };
    field('driver1', 'Include for Driver 1', input('checkbox'));
    field('driver2', 'Include for Driver 2', input('checkbox'));
    const remove = button('Remove stop', () => {
      group.remove();
      numberStops(kind);
      markEdited();
    });
    remove.classList.add('dispatch-remove');
    group.append(element('legend'), fields, remove);
    container.append(group);
    numberStops(kind);
  }

  function numberStops(kind) {
    [...stops[kind].children].forEach((group, index, groups) => {
      const title = kind === 'pickup' ? 'Pickup ' + (index + 1) + ' / Shipper ' : 'Receiver ';
      group.querySelector('legend').textContent = title + (index + 1);
      group.querySelector('.dispatch-remove').classList.toggle('hidden', groups.length === 1);
    });
  }

  function getStops(kind) {
    return [...stops[kind].children].map(group => Object.fromEntries(
      [...group.querySelectorAll('[data-stop-field]')].map(input => {
        let value = input.type === 'checkbox' ? input.checked : input.value.trim();
        if (input.dataset.stopField === 'state') value = value.toUpperCase();
        return [input.dataset.stopField, value];
      })
    ));
  }

  function paintEditor() {
    const status = edit.row?.status;
    const locked = status === 'completed';
    byId('dispatchLoadFields').disabled = locked || edit.saving;
    byId('dispatchFormHeading').textContent = status === 'draft' ? 'Edit draft'
      : status === 'current' ? 'Edit load' : locked ? 'Completed load' : 'New load';
    byId('dispatchPro').textContent = edit.pro ? proLabel(edit.pro) : '—';
    byId('dispatchProStatus').textContent = edit.pro ? '' : edit.pending ? 'Assigning PRO number…'
      : edit.failed ? 'Could not assign a PRO number.' : 'A PRO number is assigned when you start entering the load.';
    toggle('dispatchProRetry', edit.failed && !edit.pending);
    toggle('dispatchSubmit', !locked);
    toggle('dispatchSaveDraft', !locked && status !== 'current');
    toggle('dispatchSaveContract', !locked && status !== 'current');
    toggle('dispatchComplete', status === 'current');
    byId('dispatchSubmit').textContent = status === 'current' ? 'Save Changes' : 'Submit';
    for (const id of ['dispatchSubmit', 'dispatchSaveDraft', 'dispatchSaveContract', 'dispatchComplete', 'dispatchNewLoad']) {
      byId(id).disabled = edit.saving;
    }
    paintAssignment();
    paintDriverPay();
  }

  function paintAssignment() {
    toggle('dispatchDriver2Field', form.elements.secondDriverMode.value === 'assigned');
    for (const [selection, description, field] of conditionalFreightFields) {
      const control = form.elements[selection];
      const visible = control.type === 'checkbox' ? control.checked : control.value === 'Other';
      form.elements[description].disabled = !visible;
      toggle(field, visible);
    }
    const loaded = form.elements.loadedMiles.value;
    const first = form.elements.firstLegMiles.value;
    let note = '';
    if (loaded !== '' && first !== '') {
      const total = Number(loaded);
      const leg = Number(first);
      if (leg > total) note = 'Driver 1 leg miles cannot exceed route loaded miles.';
      else if (total > 0) {
        const percent = Math.round(leg / total * 100);
        note = 'Driver 1: ' + leg + ' mi (' + percent + '%) · Driver 2: ' +
          Number((total - leg).toFixed(1)) + ' mi (' + (100 - percent) + '%)';
      }
    }
    byId('dispatchLegAllocation').textContent = note;
  }

  function installEditor(row = null, fromContract = false) {
    const data = row?.details ?? {};
    edit = {
      row: fromContract ? null : row,
      id: fromContract ? null : row?.id,
      pro: fromContract ? null : row?.pro_number,
      contractId: fromContract ? row.id : row?.contract_load_id
    };
    form.reset();
    for (const key of formDetails) {
      const field = form.elements[key];
      if (field.type === 'checkbox') field.checked = data[key] === field.value;
      else if (typeof data[key] === 'string') field.value = data[key];
    }
    const assignment = fromContract ? lastContractAssignment(row) || row : row;
    form.elements.driver1.value = assignment?.driver_id ?? '';
    form.elements.driver2.value = assignment?.second_driver_id ?? '';
    form.elements.secondDriverMode.value = assignment?.second_driver_id ? 'assigned'
      : assignment?.details?.secondDriverMode === 'unknown' ? 'unknown' : 'none';
    for (const [kind, source] of [['pickup', data.pickups], ['receiver', data.receivers]]) {
      stops[kind].replaceChildren();
      for (const stop of source?.length ? source : [{}]) addStop(kind, stop);
    }
    for (const details of form.querySelectorAll('details')) {
      details.open = details.id !== 'dispatchFreightDetails' &&
        Boolean(row && [...details.querySelectorAll('input')].some(input => input.value));
    }
    paintEditor();
  }

  function canOpenLoad() {
    return !edit.saving && (!edit.dirty || window.confirm('Discard unsaved changes to this load?'));
  }

  function openLoad(load, fromContract = false) {
    if (load?.id === edit.row?.id && load?.updated_at === edit.row?.updated_at && !fromContract) {
      selectTab('create', true);
      return;
    }
    if (!canOpenLoad()) return;
    installEditor(load, fromContract);
    selectTab('create', true);
    if (fromContract) markEdited();
  }

  function reservePro() {
    const draft = edit;
    const scope = state;
    if (!scope || !draft) return Promise.resolve(null);
    if (draft.pro) return Promise.resolve(draft.pro);
    if (draft.pending) return draft.pending;
    draft.id ||= crypto.randomUUID();
    draft.failed = false;
    draft.pending = (async () => {
      try {
        const { data, error } = await scope.client.rpc('reserve_dispatch_pro', {
          requested_fleet_id: scope.fleetId, requested_load_id: draft.id
        });
        if (error || !data) throw error || new Error('PRO number is missing');
        draft.pro = data;
        return data;
      } catch (error) {
        draft.failed = true;
        return null;
      } finally {
        draft.pending = null;
        if (state === scope && edit === draft) paintEditor();
      }
    })();
    paintEditor();
    return draft.pending;
  }

  function markEdited() {
    if (!edit || edit.saving) return;
    edit.dirty = true;
    paintAssignment();
    paintDriverPay();
    if (!edit.failed) void reservePro();
  }

  async function saveLoad(status) {
    const scope = state;
    const draft = edit;
    if (!scope || draft.saving || draft.row?.status === 'completed') return;
    if (status === 'completed' && !form.reportValidity()) return;
    const weightField = form.elements.namedItem('weightLbs');
    if (weightField && !weightField.reportValidity()) return;
    const data = new FormData(form);
    const details = Object.fromEntries(formDetails.map(key => [key, data.get(key)?.trim() ?? '']));
    details.pickups = getStops('pickup');
    details.receivers = getStops('receiver');
    const driver1 = data.get('driver1') || null;
    const driver2 = details.secondDriverMode === 'assigned' ? data.get('driver2') || null : null;
    if ((driver2 && (!driver1 || driver1 === driver2)) ||
        (status === 'current' && (!driver1 || (details.secondDriverMode === 'assigned' && !driver2)))) {
      showToast(state.drivers.length ? 'Select a driver for each assignment. Driver 1 and Driver 2 must be different.'
        : 'Add a driver in the Drivers tab before submitting.');
      return;
    }
    if (status !== 'draft' && [details.pickups, details.receivers].some(list => list.some(stop => !stop.company))) {
      showToast('Enter a name for each shipper and receiver.');
      return;
    }
    if ((status === 'current' || status === 'completed') && details.loadedMiles !== '' && Number(details.firstLegMiles) > Number(details.loadedMiles)) {
      showToast('Driver 1 leg miles cannot exceed route loaded miles.');
      return;
    }

    draft.saving = true;
    paintEditor();
    try {
      const number = await reservePro();
      if (!number || state !== scope || edit !== draft) return;
      const payload = {
        details, status,
        driver_id: driver1,
        second_driver_id: driver2,
        contract_load_id: status === 'contract' ? null : draft.contractId || null
      };
      let result;
      if (draft.row) {
        result = await scope.client.from(loadTable).update(payload).eq('fleet_id', scope.fleetId)
          .eq('id', draft.id).eq('updated_at', draft.row.updated_at).select().maybeSingle();
      } else {
        const record = { ...payload, id: draft.id, fleet_id: scope.fleetId, pro_number: number };
        result = await scope.client.from(loadTable).insert(record).select().single();
        if (result.error?.code === '23505') {
          // The same ID may already have been saved if the prior response was lost.
          result = { data: null };
        }
      }
      if (state !== scope || edit !== draft) return;
      if (result.error) throw result.error;
      if (!result.data) {
        showToast('This load changed in another session. Reopen it from the list before saving.');
        await refresh();
        return;
      }
      const saved = result.data;
      scope.loads = [saved, ...scope.loads.filter(load => load.id !== saved.id)];
      const tab = status === 'contract' ? 'contract' : status === 'completed' ? 'history' : 'current';
      const message = status === 'current' ? ' saved to Current Loads.' : status === 'draft' ? ' saved as a draft.'
        : status === 'contract' ? ' saved to Contract Loads.' : ' moved to Load History.';
      showToast(proLabel(number) + message);
      installEditor();
      paintLoads();
      paintDrivers();
      selectTab(tab, true);
      void refresh();
    } catch (error) {
      if (state === scope && edit === draft) showToast('Could not save the load. Try again.');
    } finally {
      draft.saving = false;
      if (state === scope && edit === draft) paintEditor();
    }
  }

  async function addDriver(event) {
    event.preventDefault();
    const scope = state;
    const control = driverForm.querySelector('button');
    if (!scope || control.disabled) return;
    const fields = new FormData(driverForm);
    const name = fields.get('name').trim();
    if (!name) { showToast('Enter a driver name.'); return; }
    control.disabled = true;
    try {
      const result = await scope.client.from(driverTable).insert({
        fleet_id: scope.fleetId, name, equipment: fields.get('equipment').trim()
      }).select().single();
      if (state !== scope) return;
      if (result.error) throw result.error;
      scope.drivers = [...scope.drivers, result.data].sort((a, b) => a.name.localeCompare(b.name));
      driverForm.reset();
      paintDrivers();
      showToast('Driver added.');
      void refresh();
    } catch (error) {
      if (state === scope) showToast('Could not add the driver. Try again.');
    } finally {
      control.disabled = false;
    }
  }

  async function setAvailability(driver, availability, control) {
    const scope = state;
    control.disabled = true;
    try {
      const result = await scope.client.from(driverTable).update({ availability }).eq('fleet_id', scope.fleetId)
        .eq('id', driver.id).eq('availability', driver.availability).select().maybeSingle();
      if (state !== scope) return;
      if (result.error) throw result.error;
      if (result.data) {
        scope.drivers = scope.drivers.map(entry => entry.id === driver.id ? result.data : entry);
        paintDrivers();
      }
      void refresh();
    } catch (error) {
      if (state === scope) showToast('Could not update availability. Try again.');
    } finally {
      control.disabled = false;
    }
  }

  function payInputs() {
    return {
      pickups: [{ date: stops.pickup.querySelector('[data-stop-field=date]')?.value ?? '' }],
      ...Object.fromEntries(['loadedMiles', 'firstLegMiles', 'payGross', 'driver1Pay', 'driver2Pay']
        .map(key => [key, form.elements.namedItem(key)?.value ?? '']))
    };
  }

  function assignedDriverIds() {
    return [form.elements.driver1.value || null,
      form.elements.secondDriverMode.value === 'assigned' ? form.elements.driver2.value || null : null];
  }

  function savedPay(drivers, inputs) {
    const original = edit.row?.details;
    const result = original?.driverPay;
    if (!result || (result.pending && edit.row.status !== 'completed')) return null;
    if (edit.row.driver_id !== drivers[0] || edit.row.second_driver_id !== drivers[1]) return null;
    if (edit.row.status === 'completed') return result;
    const matches = Object.keys(inputs).every(key =>
      key === 'pickups' ? (original.pickups?.[0]?.date || '') === inputs.pickups[0].date
        : (original[key] || '') === inputs[key]
    );
    return matches ? result : null;
  }

  function paintPayBreakdown(result, owners) {
    const breakdown = byId('dispatchOwnerPayBreakdown');
    const lines = [];
    if (owners.some(driver => driver.method === 'split')) {
      if (result?.weekStart) lines.push('Pickup week of ' + result.weekStart);
      if (result?.fuelRateCents != null) lines.push('Weekly fuel surcharge rate: ' + result.fuelRateCents + '¢ per mile');
      if (result?.fuelSurcharge != null) lines.push('Fuel surcharge total: ' + payCurrency.format(result.fuelSurcharge));
      if (result?.splitBase != null) lines.push('Gross after fuel surcharge: ' + payCurrency.format(result.splitBase));
    }
    for (const driver of owners) {
      const calculated = result?.drivers.find(entry => entry.slot === driver.slot);
      const name = driver.name + ' · ' + payLabels[driver.method];
      if (driver.method === 'hourly') {
        lines.push(name + ' · Uses time-clock hours');
        continue;
      }
      const terms = driver.method === 'split' ? driver.splitPercent + '% driver split'
        : payRate.format(driver.mileRate) + ' per loaded mile';
      lines.push([name, terms, calculated?.amount != null ? payCurrency.format(calculated.amount) : calculated?.pending]
        .filter(Boolean).join(' · '));
    }
    breakdown.replaceChildren(...lines.map(line => element('p', line)));
  }

  function paintDriverPay({ recalculate = false } = {}) {
    const panel = byId('dispatchDriverPay');
    const scope = state;
    const editor = edit;
    if (!panel || !scope || !editor) return;
    const ids = assignedDriverIds();
    const inputs = payInputs();
    const saved = savedPay(ids, inputs);
    const assigned = ids.flatMap((id, index) => {
      const profile = scope.drivers.find(driver => driver.id === id);
      if (!profile) return [];
      const terms = saved?.drivers.find(entry => entry.slot === index + 1);
      return [{
        slot: index + 1, name: profile.name, type: terms ? terms.type : profile.driver_type,
        method: terms ? terms.method : profile.pay_method,
        splitPercent: terms ? terms.splitPercent : profile.split_percent,
        mileRate: terms ? terms.mileRate : profile.mile_rate
      }];
    });
    const owners = assigned.filter(driver => driver.type === 'owner_op');
    const manual = assigned.filter(driver => driver.type !== 'owner_op');
    let category = editor.payCategory;
    if ((category === 'owner' && !owners.length) || (category === 'company' && !manual.length) || !category) {
      category = owners.length ? 'owner' : manual.length ? 'company' : null;
    }
    for (const [kind, drivers, control, section] of [
      ['owner', owners, 'dispatchOwnerPayTab', 'dispatchOwnerPayPanel'],
      ['company', manual, 'dispatchCompanyPayTab', 'dispatchCompanyPayPanel']
    ]) {
      byId(control).disabled = !drivers.length;
      byId(control).setAttribute('aria-pressed', String(category === kind));
      toggle(section, category === kind);
    }
    for (const slot of [1, 2]) {
      const visible = manual.some(driver => driver.slot === slot);
      toggle('dispatchDriver' + slot + 'PayField', visible);
      form.elements['driver' + slot + 'Pay'].disabled = !visible;
    }
    const split = owners.some(driver => driver.method === 'split');
    toggle('dispatchPayGrossField', split);
    form.elements.payGross.disabled = !split;
    const unconfigured = manual.some(driver => !driver.type);
    const legacy = editor.row?.status === 'completed' && !editor.row.details.driverPay;
    const status = byId('dispatchPayStatus');
    status.textContent = !assigned.length ? 'Select a driver to see their pay setup.'
      : legacy ? 'This load was completed before pay profiles were added.'
      : unconfigured ? 'Set the driver type in Drivers to use a pay profile.' : '';
    if (saved || legacy || !owners.some(driver => driver.method !== 'hourly') || !panel.open) {
      editor.payPreview = null;
      paintPayBreakdown(saved, owners);
      return;
    }

    const key = JSON.stringify([ids, inputs, owners]);
    if (!recalculate && editor.payPreview?.key === key) {
      if (!status.textContent) status.textContent = editor.payPreview.message || '';
      paintPayBreakdown(editor.payPreview.result, owners);
      return;
    }
    const request = { key, message: 'Calculating driver pay…' };
    editor.payPreview = request;
    if (!status.textContent) status.textContent = request.message;
    paintPayBreakdown(null, owners);
    const active = () => state === scope && edit === editor && editor.payPreview === request;
    window.setTimeout(async () => {
      if (!active()) return;
      try {
        const { data, error } = await scope.client.rpc('calculate_dispatch_driver_pay', {
          requested_fleet_id: scope.fleetId, first_driver_id: ids[0],
          second_driver_id: ids[1], requested_details: inputs
        });
        if (error) throw error;
        request.result = data;
        request.message = '';
      } catch {
        request.message = 'Driver pay preview unavailable. Reopen Driver Pay to retry.';
      }
      if (active()) paintDriverPay();
    }, 170);
  }

  function paintPayProfileFields() {
    const form = byId('dispatchPayProfileForm');
    const owner = form.elements.driverType.value === 'owner_op';
    const method = form.elements.payMethod.value;
    for (const [field, input, visible] of [
      ['dispatchProfileMethodField', form.elements.payMethod, owner],
      ['dispatchProfileSplitField', form.elements.splitPercent, owner && method === 'split'],
      ['dispatchProfileMileField', form.elements.mileRate, owner && method === 'per_mile']
    ]) {
      toggle(field, visible);
      input.disabled = !visible;
      input.required = visible;
    }
  }

  function editPayProfile(driver) {
    const form = byId('dispatchPayProfileForm');
    if (form.querySelector('button[type=submit]').disabled) return;
    state.payProfileId = driver.id;
    const { driverType, payMethod, splitPercent, mileRate } = form.elements;
    driverType.value = driver.driver_type ?? '';
    payMethod.value = driver.pay_method ?? '';
    splitPercent.value = driver.split_percent ?? '';
    mileRate.value = driver.mile_rate ?? '';
    byId('dispatchPayProfileHeading').textContent = driver.name + ' pay profile';
    toggle('dispatchPayProfile', true);
    paintPayProfileFields();
    driverType.focus();
  }

  async function savePayProfile(event) {
    event.preventDefault();
    const scope = state;
    const form = event.currentTarget;
    const control = form.querySelector('button[type=submit]');
    if (!scope?.payProfileId || control.disabled) return;
    const data = new FormData(form);
    const profile = {
      driver_type: data.get('driverType'), pay_method: data.get('payMethod'),
      split_percent: data.get('splitPercent'), mile_rate: data.get('mileRate')
    };
    control.disabled = true;
    try {
      const { data: driver, error } = await scope.client.from(driverTable).update(profile)
        .eq('fleet_id', scope.fleetId).eq('id', scope.payProfileId).select().single();
      if (error) throw error;
      if (state !== scope) return;
      scope.drivers = scope.drivers.map(entry => entry.id === driver.id ? driver : entry);
      scope.payProfileId = null;
      toggle('dispatchPayProfile', false);
      paintDrivers();
      paintDriverPay({ recalculate: true });
      showToast('Driver pay profile saved.');
      void refresh();
    } catch {
      if (state === scope) showToast('Could not save the driver pay profile.');
    } finally {
      control.disabled = false;
    }
  }

  function thisMonday() {
    const now = new Date();
    const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
    return day.toISOString().slice(0, 10);
  }

  async function readFuelRate() {
    const scope = state;
    const week = byId('dispatchFuelWeek');
    const rate = byId('dispatchFuelRate');
    const status = byId('dispatchFuelStatus');
    if (!scope) return;
    const request = {};
    scope.fuelRequest = request;
    if (!week.value) week.value = thisMonday();
    rate.value = '';
    if (!week.validity.valid) {
      status.textContent = 'Choose a Monday to set the rate for that week.';
      return;
    }
    status.textContent = 'Loading weekly rate…';
    rate.disabled = true;
    try {
      const { data, error } = await scope.client.from(fuelTable).select('cents_per_mile')
        .eq('fleet_id', scope.fleetId).eq('week_start', week.value).maybeSingle();
      if (error) throw error;
      if (state !== scope || scope.fuelRequest !== request) return;
      rate.value = data?.cents_per_mile ?? '';
      status.textContent = data ? 'This week’s rate is saved.' : 'No rate set for this week.';
    } catch {
      if (state === scope && scope.fuelRequest === request) status.textContent = 'Could not load this week’s rate.';
    } finally {
      if (state === scope && scope.fuelRequest === request) rate.disabled = false;
    }
  }

  async function saveFuelRate(event) {
    event.preventDefault();
    const scope = state;
    const form = event.currentTarget;
    const control = form.querySelector('button[type=submit]');
    if (!scope || control.disabled || form.elements.rate.disabled) return;
    const data = new FormData(form);
    control.disabled = true;
    try {
      const { error } = await scope.client.from(fuelTable).upsert({
        fleet_id: scope.fleetId, week_start: data.get('week'), cents_per_mile: data.get('rate')
      }, { onConflict: 'fleet_id,week_start' });
      if (error) throw error;
      if (state === scope) {
        paintDriverPay({ recalculate: true });
        showToast('Weekly fuel surcharge saved.');
        void readFuelRate();
      }
    } catch {
      if (state === scope) showToast('Could not save the weekly fuel surcharge.');
    } finally {
      control.disabled = false;
    }
  }

  if (byId('dispatchDriverPay')) {
    byId('dispatchDriverPay').addEventListener('toggle', () => paintDriverPay({ recalculate: true }));
    byId('dispatchOwnerPayTab').addEventListener('click', () => {
      edit.payCategory = 'owner';
      paintDriverPay();
    });
    byId('dispatchCompanyPayTab').addEventListener('click', () => {
      edit.payCategory = 'company';
      paintDriverPay();
    });
    byId('dispatchPayProfileForm').addEventListener('input', paintPayProfileFields);
    byId('dispatchPayProfileForm').addEventListener('submit', savePayProfile);
    byId('dispatchPayProfileCancel').addEventListener('click', () => {
      toggle('dispatchPayProfile', false);
    });
    byId('dispatchFuelSettings').addEventListener('toggle', event => {
      if (event.target.open) void readFuelRate();
    });
    byId('dispatchFuelWeek').addEventListener('change', readFuelRate);
    byId('dispatchFuelForm').addEventListener('submit', saveFuelRate);
  }

  form.addEventListener('input', markEdited);
  form.addEventListener('invalid', event => {
    const panel = event.target.closest('details');
    if (panel) panel.open = true;
  }, true);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void saveLoad(event.submitter?.value || 'current');
  });
  for (const control of form.querySelectorAll('[data-dispatch-add-stop]')) {
    control.addEventListener('click', () => {
      const kind = control.dataset.dispatchAddStop;
      const before = stops[kind].children.length;
      addStop(kind);
      if (stops[kind].children.length > before) {
        markEdited();
        stops[kind].lastElementChild.querySelector('input').focus();
      }
    });
  }
  byId('dispatchProRetry').addEventListener('click', () => { void reservePro(); });
  byId('dispatchComplete').addEventListener('click', () => { void saveLoad('completed'); });
  byId('dispatchNewLoad').addEventListener('click', () => {
    if (canOpenLoad()) installEditor();
  });
  byId('dispatchReload').addEventListener('click', refresh);
  byId('dispatchLoadSearch').addEventListener('input', paintLoads);
  byId('dispatchDriverSearch').addEventListener('input', paintDrivers);
  byId('dispatchDriverFilter').addEventListener('change', paintDrivers);
  driverForm.addEventListener('submit', addDriver);

  function reset() {
    state = null;
    edit = null;
    selectedTab = 'current';
    form.reset();
    driverForm.reset();
    if (byId('dispatchFuelForm')) {
      byId('dispatchFuelForm').reset();
      byId('dispatchFuelRate').disabled = false;
      byId('dispatchFuelSettings').open = false;
      toggle('dispatchPayProfile', false);
    }
    byId('dispatchLoadSearch').value = '';
    byId('dispatchDriverSearch').value = '';
    byId('dispatchDriverFilter').value = '';
    for (const id of ['dispatchRailList', 'dispatchCurrentList', 'dispatchDraftList', 'dispatchContractList',
      'dispatchHistoryList', 'dispatchDriversList', 'dispatchPickups', 'dispatchReceivers']) byId(id).replaceChildren();
    toggle('dispatchReadError', false);
  }

  function open(client, fleetId, stage, tab) {
    const ready = stage === 'ready' && Boolean(fleetId);
    toggle('dispatchGate', !ready);
    toggle('dispatchWorkspace', ready);
    if (!ready) {
      if (stage === 'ready' && state) reset();
      const missing = stage === 'ready' && !fleetId;
      byId('dispatchGateMessage').textContent = missing ? 'Set your Fleet ID to start using Dispatch.'
        : stage === 'error' ? 'Could not load your fleet.' : 'Loading your fleet…';
      toggle('dispatchGateSettings', missing);
      toggle('dispatchGateRetry', stage === 'error');
      if (tab) selectedTab = tab;
      return;
    }
    if (state?.fleetId !== fleetId || state.client !== client) {
      const destination = tab || selectedTab;
      reset();
      state = { client, fleetId, loads: [], drivers: [], loaded: false, failed: false };
      paintLoads();
      paintDrivers();
      installEditor();
      selectTab(destination);
    } else if (tab) {
      selectTab(tab);
    }
    return refresh();
  }

  return { open, reset };
})();
