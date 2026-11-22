const driverLoadWorkflow = (() => {
  const byId = id => document.getElementById(id);
  const pro = load => (load.return_of ? 'B-' : 'A-') + load.pro;
  const statusText = {
    pending: 'Pending Dispatch Review', posted: 'Posted to Current Loads', denied: 'Denied',
    accepted: 'Accepted', rejected: 'Rejected', completed: 'Completed'
  };
  const empty = () => ({ loads: [], yard: [] });
  const dispatchFleet = () => accountTypeFor(currentUser) === 'fleet' ? adminFleetId
    : typeof officeTools !== 'undefined' && officeTools.has('dispatch') ? officeTools.dispatchFleet() : null;
  const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
  const rate = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 6 });
  const quantity = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
  const appointmentDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  const zoneNames = {
    'America/New_York': 'Eastern', 'America/Chicago': 'Central', 'America/Denver': 'Mountain',
    'America/Phoenix': 'Arizona', 'America/Los_Angeles': 'Pacific', 'America/Anchorage': 'Alaska',
    'Pacific/Honolulu': 'Hawaii'
  };
  let driverData = empty();
  let selected = null;
  let detailTab = 'progress';
  const paperworkDrafts = new Map();
  let driverRead = null;
  let officeRead = null;
  let driverSnapshot = '';
  let officeSnapshot = '';
  let seenDriver = new Set();
  let seenOffice = new Set();
  let driverInitialized = false;
  let seenLoadVersion = '';
  let officeInitialized = false;

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text) item.textContent = text;
    if (className) item.className = className;
    return item;
  }

  function button(label, run, className = 'outline') {
    const control = node('button', label, className);
    control.type = 'button';
    control.addEventListener('click', () => void run(control));
    return control;
  }

  function submitButton(label) {
    const control = node('button', label, 'primary-btn');
    control.type = 'submit';
    return control;
  }

  function field(label, control) {
    const wrapper = node('label', '', 'field');
    wrapper.append(node('span', label), control);
    return wrapper;
  }

  function input(label, name, options = {}) {
    const control = node('input');
    Object.assign(control, { name, ...options });
    return field(label, control);
  }

  function fields(...children) {
    const wrapper = node('div', '', 'form-grid fleet-account-fields');
    wrapper.append(...children);
    return wrapper;
  }

  function values(form) {
    return Object.fromEntries(new FormData(form));
  }

  function place(stop) {
    return [stop?.company, stop?.address, [stop?.city, stop?.state, stop?.zip].filter(Boolean).join(' ')]
      .filter(Boolean).join(' · ');
  }

  function stopContact(info) {
    const phone = String(info?.phone ?? '').trim();
    return phone ? [String(info?.contactName ?? '').trim(), phone].filter(Boolean).join(' · ') : '';
  }

  const clock = (value, zone) => {
    if (!value) return '';
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        ...(zone ? { timeZone: zone } : {}) }).format(new Date(value));
    } catch { return ''; }
  };

  function setOptions(control, entries, placeholder) {
    const selectedValue = control.value;
    control.replaceChildren(new Option(placeholder, ''), ...entries.map(([value, label]) => new Option(label, value)));
    if (entries.some(([value]) => value === selectedValue)) control.value = selectedValue;
  }

  function setList(id, children, placeholder) {
    byId(id).replaceChildren(...(children.length ? children : [node('p', placeholder, 'muted')]));
  }

  function label(load) {
    if (load.review === 'pending' || load.review === 'denied') return statusText[load.review];
    if (load.status === 'completed') return 'Completed';
    return statusText[load.decision] || 'New assignment';
  }

  const isOffer = load => load?.status === 'current' && !load.decision;
  const isQueued = load => Number(load?.queuePosition) > 1;

  function offerNumber(value, formatter, unit = '') {
    if (value == null || value === '' || !Number.isFinite(Number(value))) return '';
    return formatter.format(Number(value)) + unit;
  }

  function offerFields(entries, className = '') {
    const list = node('dl', '', className);
    for (const [label, value] of entries) {
      if (!value) continue;
      const row = node('div');
      row.append(node('dt', label), node('dd', value));
      list.append(row);
    }
    return list;
  }

  function offerCard(title, extra) {
    const card = node('section', '', 'load-offer-card');
    const heading = node('header');
    heading.append(node('h3', title));
    if (extra) heading.append(node('span', extra));
    card.append(heading);
    return card;
  }

  function offerTime(value) {
    if (!value || !/^(?:[01]\d|2[0-3]):?[0-5]\d$/.test(value)) return '';
    return value.length === 4 ? value.slice(0, 2) + ':' + value.slice(2) : value;
  }

  function stopAppointment(info) {
    const date = info.date && new Date(info.date + 'T00:00:00Z');
    const day = date && Number.isFinite(date.valueOf()) ? appointmentDate.format(date) : '';
    const time = [offerTime(info.from), offerTime(info.to)].filter(Boolean).join('–');
    const zone = time && (zoneNames[info.zone] || info.zone);
    return [day, [time, zone].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  }

  function offerStops(load, kind, includeReports = false) {
    const stops = load.stops.filter(stop => stop.kind === kind);
    const card = offerCard(kind === 'pickup' ? 'Pickup' : 'Delivery',
      stops.length + (stops.length === 1 ? ' stop' : ' stops'));
    const list = node('ol', '', 'load-offer-stops');
    for (const stop of stops) {
      const { info } = stop;
      const row = node('li');
      row.append(node('strong', info.company || 'Stop location'));
      const locality = [[info.city, info.state].filter(Boolean).join(', '), info.zip].filter(Boolean).join(' ');
      for (const line of [info.address, locality]) if (line) row.append(node('p', line));
      const schedule = node('div', '', 'load-offer-appointment');
      schedule.append(node('span', 'Appointment'), node('strong', stopAppointment(info) || 'To be scheduled'));
      row.append(schedule);
      const contacts = offerFields([['Contact', stopContact(info)], ['Email', info.email]], 'driver-load-contacts');
      if (contacts.childElementCount) row.append(contacts);
      if (info.notes) row.append(node('p', info.notes, 'load-offer-notes'));
      row.append(...trailerPlanNotes(load, stop));
      if (includeReports) row.append(...stopReport(stop));
      list.append(row);
    }
    if (stops.length) card.append(list);
    else card.append(node('p', 'No stops assigned.', 'load-offer-empty'));
    return card;
  }

  function offerFreight(freight) {
    const card = offerCard('Shipment Details');
    const fields = offerFields([
      ['Route number', freight.route], ['Pickup number', freight.pickupNumber], ['BOL number', freight.bolNumber],
      ['Broker load number', freight.brokerLoadNumber], ['Broker', freight.brokerName],
      ['Broker phone', freight.brokerPhone], ['Broker email', freight.brokerEmail],
      ['Commodity', freight.commodity], ['Equipment', freight.equipment],
      ['Weight', offerNumber(freight.weight, quantity, ' lb')], ['Pieces', offerNumber(freight.pieces, quantity)],
      ['Truck number', freight.truckNumber], ['Trailer number', freight.trailerNumber],
      ['Trailer type', { fleet: 'Fleet', power_only: 'Power Only' }[freight.trailerType]],
      ['Loaded miles', offerNumber(freight.miles, quantity, ' mi')],
      ['Empty miles', offerNumber(freight.emptyMiles, quantity, ' mi')],
      ['Trailer drop', freight.trailerDropStopId ? '' : freight.trailerDrop],
      ['Trailer pickup', freight.trailerPickupStopId ? '' : freight.trailerPickup],
      ['Your stop pay', offerNumber(freight.stopPay, currency)]
    ], 'load-offer-freight');
    if (fields.childElementCount) card.append(fields);
    else card.append(node('p', 'No shipment details entered.', 'load-offer-empty'));
    return card;
  }

  function trailerPlanNotes(load, stop) {
    const freight = load.freight || load.offer?.freight || {};
    const notes = [];
    if (freight.trailerDropStopId === stop.key) {
      notes.push(node('p', ['Drop trailer', freight.trailerDropNumber, freight.trailerDropNotes].filter(Boolean).join(' · ')));
    }
    if (freight.trailerPickupStopId === stop.key) {
      if (freight.trailerPickupMode === 'bobtail') {
        notes.push(node('p', 'Leave this stop bobtail'));
        if (freight.nextTrailerLocation || freight.bobtailInstructions) {
          const section = node('details');
          section.open = true;
          section.append(node('summary', 'Next Trailer / Bobtail Instructions'));
          if (freight.nextTrailerLocation) section.append(node('p', 'Next trailer location · ' + freight.nextTrailerLocation));
          if (freight.bobtailInstructions) section.append(node('p', freight.bobtailInstructions));
          notes.push(section);
        }
      } else {
        notes.push(node('p', ['Pick up trailer', freight.trailerPickupNumber, freight.trailerPickupNotes].filter(Boolean).join(' · ')));
      }
    }
    return notes;
  }

  function offerPay(pay) {
    const company = accountTypeFor(currentUser) === 'company';
    const card = offerCard(company ? 'Company Driver Pay' : 'Owner-Operator Pay');
    if (!pay || (company ? pay.type !== 'company' : pay.type !== 'owner_op')) return card;
    const amount = value => offerNumber(value, currency);
    const displayRate = value => offerNumber(value, rate, ' / mi');
    const rows = pay.method === 'split' ? [
      ['Your split', offerNumber(pay.splitPercent, quantity, '%')]
    ] : pay.method === 'per_mile' ? [
      ['Your rate', displayRate(pay.mileRate)], ['Your loaded miles', offerNumber(pay.miles, quantity, ' mi')]
    ] : [];
    if (pay.method === 'load_percent' || pay.method === 'higher_of') {
      rows.push(['Your load percentage', offerNumber(pay.splitPercent, quantity, '%')]);
    }
    if (pay.method === 'higher_of') {
      rows.push(['Your rate', displayRate(pay.mileRate)], ['Your loaded miles', offerNumber(pay.miles, quantity, ' mi')],
        ['Pay by percentage', amount(pay.percentAmount)], ['Pay by mile', amount(pay.mileageAmount)]);
    }
    if (pay.emptyMileRate != null) {
      rows.push(['Loaded pay', amount(pay.linehaulPay)], ['Empty-mile rate', displayRate(pay.emptyMileRate)],
        ['Your empty miles', offerNumber(pay.emptyMiles, quantity, ' mi')], ['Empty-mile pay', amount(pay.emptyPay)]);
    }
    if (pay.pending) rows.push(['Pay pending', pay.pending]);
    rows.push(['Base pay', amount(pay.amount)]);
    if (pay.additionalPay > 0) rows.push(['Additional pay', amount(pay.additionalPay)]);
    const entries = offerFields(rows, 'load-offer-pay');
    if (entries.childElementCount) card.append(entries);
    const total = amount(pay.totalPay ?? pay.amount);
    if (total) {
      const summary = node('div', '', 'load-offer-total');
      summary.append(node('span', 'Estimated pay'), node('strong', total));
      card.append(summary);
    }
    return card;
  }

  function paintOffer(load, panel) {
    const cards = node('div', '', 'load-offer-grid');
    const freight = load.offer?.freight || load.freight || {};
    cards.append(offerStops(load, 'pickup'), offerStops(load, 'delivery'),
      offerFreight(freight));
    const relay = relayCard(load, freight);
    if (relay) cards.append(relay);
    if (accountTypeFor(currentUser) !== 'fleet' || load.offer?.pay) cards.append(offerPay(load.offer?.pay));
    const actions = node('div', '', 'dispatch-actions load-offer-actions');
    const respond = async (control, action, message) => {
      const other = control === accept ? reject : accept;
      other.disabled = true;
      try { await mutate(control, 'driver', action, load.id, {}, message); }
      finally { other.disabled = false; }
    };
    const accept = button('Accept', control => respond(control, 'accept', 'Assignment accepted.'), 'primary-btn');
    const reject = button('Reject', control => respond(control, 'reject', 'Dispatch was notified.'));
    actions.append(accept, reject);
    panel.append(cards, actions);
  }

  async function rpc(role, action, id, payload) {
    const data = { action, ...(id ? { load_id: id } : {}), ...(payload ? { payload } : {}) };
    if (role === 'dispatch') data.fleet = dispatchFleet();
    const response = await supabaseClient.rpc(role + '_workflow', data);
    if (response.error) throw response.error;
    return response.data;
  }

  async function mutate(control, role, action, id, payload, success, after, onError = showToast) {
    if (control.disabled) return;
    const user = currentUser;
    control.disabled = true;
    try {
      const result = await rpc(role, action, id, payload);
      if (currentUser !== user) return;
      after?.(result);
      showToast(typeof success === 'function' ? success(result) : success);
      if (role === 'driver') await refresh(false, true);
      else {
        await refreshOffice(false, true);
        await fleetDispatchApp.reload();
      }
    } catch (error) {
      if (currentUser === user) onError(error.message || 'Could not save the load update.');
    } finally { control.disabled = false; }
  }

  function paintDriverList() {
    function loadRow(load) {
      const row = node('article', '', 'dispatch-load-row');
      row.dataset.driverLoadId = load.id;
      row.dataset.breakdown = String(load.breakdown?.active === true);
      row.dataset.traffic = String(load.traffic?.active === true && !load.breakdown?.active);
      const summary = node('div');
      summary.append(node('strong', pro(load)), node('p', label(load), 'muted'));
      if (isQueued(load)) summary.append(node('p', 'Queue position ' + load.queuePosition, 'muted'));
      if (load.breakdown?.active) summary.append(node('p', 'Breakdown reported', 'dispatch-breakdown-label'));
      else if (load.traffic?.active) summary.append(node('p', 'Held up in traffic', 'dispatch-traffic-label'));
      const route = [place(load.stops[0]?.info), place(load.stops.at(-1)?.info)].filter(Boolean);
      if (route.length) summary.append(node('p', [...new Set(route)].join(' → ')));
      row.append(summary, button(isOffer(load) ? 'Review offer' : 'Open load', () => openLoad(load.id)));
      return row;
    }
    const queue = driverData.loads.filter(isQueued).sort((a, b) => a.queuePosition - b.queuePosition);
    const groups = [
      ['Current Load', driverData.loads.filter(load => Number(load.queuePosition) === 1)],
      ['Queued Loads', queue],
      ['New Offers', driverData.loads.filter(isOffer)],
      ['Other Loads', driverData.loads.filter(load => !load.queuePosition && !isOffer(load))]
    ];
    const rows = groups.filter(([, loads]) => loads.length).map(([title, loads]) => {
      const group = node('section', '', 'driver-assignment-group');
      const cards = node('div', '', 'dispatch-load-list');
      cards.append(...loads.map(loadRow));
      group.append(node('h3', title), cards);
      return group;
    });
    setList('driverWorkflowLoads', rows, 'No loads are assigned to you.');
    const offers = driverData.yard;
    const waiting = offers.filter(offer => !offer.picked_up_at);
    byId('driverYardList').replaceChildren(...offers.map(offer => node('li',
      [offer.trailer, offer.yard, pro(offer), offer.picked_up_at ? 'In Transit · Dispatch review' : 'Ready at yard'].join(' · '))));
    const current = driverData.loads.find(load => Number(load.queuePosition) === 1);
    const waitingInQueue = current && waiting.length && waiting.every(offer => offer.id !== current.id);
    byId('driverYardStatus').textContent = waitingInQueue ? 'Finish ' + pro(current) + ' before picking up a queued trailer.'
      : offers.length ? '' : 'No yard trailers have been sent.';
    updateYardMatch();
    byId('driverYardForm').classList.toggle('hidden', !waiting.length);
    byId('driverYardForm').querySelector('button[type=submit]').disabled = Boolean(waitingInQueue);
  }

  function updateYardMatch() {
    const number = byId('driverYardTrailer').value.trim().toUpperCase();
    const matches = driverData.yard.filter(offer => !offer.picked_up_at && offer.trailer.toUpperCase() === number);
    const picker = byId('driverYardOffer');
    const needsYard = matches.length > 1;
    picker.closest('.field').classList.toggle('hidden', !needsYard);
    picker.disabled = !needsYard;
    picker.required = needsYard;
    setOptions(picker, matches.map(offer => [offer.id, offer.yard + ' · ' + pro(offer)]), 'Choose the matching yard');
    return matches;
  }

  function showAllStops(load) {
    const list = node('ol', '', 'driver-load-stops');
    list.id = 'driverLoadStops';
    const active = load.stops.find(stop => !stop.progress?.completedAt);
    const handoffComplete = load.yard_handoff?.first_driver && load.yard_handoff?.picked_up_at;
    for (const stop of load.stops) {
      const row = node('li');
      if (stop === active && !isQueued(load) && !handoffComplete && load.decision === 'accepted' && load.review !== 'denied' &&
          (load.status === 'current' || load.review === 'pending')) row.setAttribute('aria-current', 'step');
      const schedule = stopAppointment(stop.info);
      const stage = stop.progress?.completedAt ? 'Departed' : stop.progress?.arrivalAt ? 'Arrived' : 'Scheduled';
      row.append(node('strong', (stop.kind === 'pickup' ? 'Pickup' : 'Delivery') + ' · ' + stage), node('p', place(stop.info)));
      const contact = stopContact(stop.info);
      if (contact) row.append(node('p', 'Contact · ' + contact, 'muted'));
      if (schedule) row.append(node('p', schedule, 'muted'));
      if (stop.info.notes) row.append(node('p', stop.info.notes));
      row.append(...trailerPlanNotes(load, stop));
      if (stop.progress?.arrivalAt) {
        const time = clock(stop.progress.arrivalAt, stop.info.zone);
        const departed = clock(stop.progress.completedAt, stop.info.zone);
        row.append(node('p', departed ? 'Arrived ' + time + ' · Departed ' + departed : 'Arrived ' + time, 'muted'));
      }
      row.append(...stopReport(stop));
      list.append(row);
    }
    return list;
  }

  function stopReport(stop) {
    const report = stop.progress?.driverReport;
    if (!report) return [];
    const details = [report.bobtail ? 'Departed bobtail' : report.trailer && 'Trailer ' + report.trailer, report.commodity,
      report.weight && 'Weight ' + report.weight, report.pieces && report.pieces + ' pieces',
      report.bol && 'BOL ' + report.bol,
      report.droppedTrailer && 'Dropped trailer ' + report.droppedTrailer,
      report.pickedTrailer && 'Picked up trailer ' + report.pickedTrailer +
        (report.loadedState ? ' (' + report.loadedState + ')' : '')].filter(Boolean);
    const rows = [];
    if (details.length) rows.push(node('p', details.join(' · '), 'muted'));
    if (Number(report.lumperFee) > 0) rows.push(node('p', 'Lumper fee paid: ' + offerNumber(report.lumperFee, currency), 'muted'));
    const label = stop.kind === 'pickup' ? 'BOL' : 'delivery paperwork';
    rows.push(...paperworkButtons(report, label, button));
    return rows;
  }

  function paperworkButtons(report, label, makeButton, context = '') {
    const documents = Array.isArray(report?.documents) && report.documents.length
      ? report.documents : [report?.document].filter(Boolean);
    if (!documents.length) return [];
    const title = label + (context ? ' · ' + context : '');
    const count = documents.length > 1 ? ' · ' + documents.length + ' files' : '';
    return [makeButton('View ' + title + count, () => driverPaperwork.open(documents, title))];
  }

  function stopForm(load, stop) {
    const form = node('form');
    form.dataset.trailerDeparture = '';
    let freight = load.freight || {};
    const title = stop.kind === 'pickup' ? 'Depart Pickup' : 'Depart Delivery';
    form.append(node('h3', title));
    const key = JSON.stringify([load.id, stop.key]);
    const draft = paperworkDrafts.get(key) || { files: [], saving: false };
    paperworkDrafts.set(key, draft);
    const submit = submitButton(title);
    const state = node('select');
    state.name = 'loaded_state';
    setOptions(state, [['loaded','Loaded'],['empty','Empty']], 'Select loaded or empty');
    const trailer = input('Trailer number', 'trailer', { maxLength:40, value:load.incomingTrailer ?? '' });
    const trailerNumber = trailer.querySelector('input');
    if (load.incomingTrailer != null) trailerNumber.dataset.incomingTrailer = load.incomingTrailer;
    const bobtail = input('Bobtail (leaving without a trailer)', 'bobtail', { type:'checkbox', value:'true' });
    bobtail.classList.add('dispatch-checkbox');
    const check = bobtail.querySelector('input');
    const dropped = input('Trailer drop number (optional)', 'dropped_trailer', { maxLength:40 });
    const droppedNumber = dropped.querySelector('input');
    const picked = input('Trailer pickup number (optional)', 'picked_trailer', { maxLength:40 });
    const pickedNumber = picked.querySelector('input');
    const numbers = [trailerNumber, droppedNumber, pickedNumber];
    const trailerTypes = node('fieldset', '', 'equipment-trailer-choices');
    trailerTypes.append(node('legend', 'Trailer Type'),
      input('Fleet', 'trailer_type', { type:'radio', value:'fleet' }),
      input('Power Only', 'trailer_type', { type:'radio', value:'power_only' }));
    const alert = node('p', '', 'driver-trailer-alert');
    alert.setAttribute('role', 'alert');
    alert.id = 'driver-trailer-alert';
    const serviceAlert = node('p', '', 'driver-trailer-alert');
    serviceAlert.setAttribute('role', 'status');
    serviceAlert.id = 'driver-trailer-service-alert';
    for (const control of numbers) control.setAttribute('aria-describedby', alert.id + ' ' + serviceAlert.id);
    const normalizeNumber = control => control.value.trim().toUpperCase();
    let inventory;
    let lookupKey;
    let lookupTimer;
    function scheduleTrailerLookup() {
      const units = [...new Set(numbers.filter(control => !control.disabled).map(normalizeNumber).filter(Boolean))].sort();
      const key = JSON.stringify(units);
      if (key === lookupKey) return;
      lookupKey = key;
      inventory = null;
      clearTimeout(lookupTimer);
      if (!units.length) return;
      const user = currentUser;
      lookupTimer = setTimeout(async () => {
        if (!form.isConnected || currentUser !== user) return;
        try {
          const { data, error } = await supabaseClient.rpc('driver_trailer_status', {
            target_load: load.id, unit_numbers: units
          });
          if (!error && form.isConnected && currentUser === user && lookupKey === key) {
            inventory = data;
            updateTrailer();
          }
        } catch {}
      }, 250);
    }
    function updateTrailer() {
      trailerNumber.disabled = pickedNumber.disabled = state.disabled = check.checked;
      trailerTypes.disabled = check.checked;
      scheduleTrailerLookup();
      const incoming = trailerNumber.dataset.incomingTrailer;
      const departure = normalizeNumber(trailerNumber);
      const dropped = normalizeNumber(droppedNumber);
      const picked = normalizeNumber(pickedNumber);
      const plannedDrop = freight.trailerDropStopId === stop.key && freight.trailerDropNumber;
      const plannedPickup = freight.trailerPickupStopId === stop.key && freight.trailerPickupNumber;
      const plannedBobtail = freight.trailerPickupStopId === stop.key && freight.trailerPickupMode === 'bobtail';
      const wrongDrop = plannedDrop && dropped !== plannedDrop.toUpperCase();
      const wrongArrivalDrop = !plannedDrop && incoming && dropped && dropped !== incoming.toUpperCase();
      const wrongPickup = plannedPickup && !check.checked && picked !== plannedPickup.toUpperCase();
      const missingBobtail = plannedBobtail && !check.checked;
      state.required = !check.checked && Boolean(picked);
      const hookMismatch = !check.checked && Boolean(picked) && departure !== picked;
      const unreportedHook = !check.checked && dropped && !picked && departure && departure !== dropped;
      const mismatch = incoming != null && departure !== incoming.toUpperCase()
        && !check.checked && !droppedNumber.value.trim() && !picked;
      const fleetSelected = trailerTypes.querySelector('input:checked')?.value === 'fleet';
      const unregisteredFleet = fleetSelected && !check.checked && departure &&
        (!dropped || picked || departure !== dropped) && inventory && !Object.hasOwn(inventory, departure);
      const unavailable = new Set();
      for (const control of numbers) {
        const unit = normalizeNumber(control);
        const outOfService = !control.disabled && inventory?.[unit] === true;
        control.dataset.outOfService = String(outOfService);
        if (outOfService) unavailable.add(unit);
      }
      serviceAlert.textContent = [...unavailable].map(unit => 'Trailer ' + unit + ' is out of service.').join(' ');
      alert.textContent = wrongDrop ? 'Enter the planned drop trailer number ' + plannedDrop + '.'
        : wrongArrivalDrop ? 'The drop trailer must match your arrival trailer ' + incoming + '.'
        : missingBobtail ? 'Select Bobtail to confirm you are leaving without a trailer.'
        : wrongPickup ? 'Enter the planned pickup trailer number ' + plannedPickup + '.'
        : hookMismatch ? 'Trailer number must match the picked-up trailer.'
        : unreportedHook ? 'Enter the trailer pickup number if you are leaving with a different trailer.'
        : mismatch
        ? 'Trailer mismatch. ' + (incoming ? 'Arrival trailer: ' + incoming + '. ' : 'You arrived bobtail. ') +
          'Enter the same trailer, record a trailer drop or pickup, or select Bobtail.'
        : unregisteredFleet ? 'Select a trailer saved in Equipment or choose Power Only.'
        : '';
      const invalid = wrongDrop || wrongArrivalDrop || wrongPickup || missingBobtail || hookMismatch || unreportedHook || mismatch || unregisteredFleet;
      trailerNumber.setAttribute('aria-invalid', String(Boolean(hookMismatch || unreportedHook || mismatch || unregisteredFleet)));
      droppedNumber.setAttribute('aria-invalid', String(Boolean(wrongDrop || wrongArrivalDrop)));
      pickedNumber.setAttribute('aria-invalid', String(Boolean(wrongPickup)));
      check.setAttribute('aria-invalid', String(Boolean(missingBobtail)));
      submit.disabled = draft.saving || Boolean(invalid);
      return !invalid;
    }
    check.addEventListener('change', updateTrailer);
    trailerTypes.addEventListener('change', updateTrailer);
    for (const control of [trailerNumber, droppedNumber]) control.addEventListener('input', updateTrailer);
    pickedNumber.addEventListener('input', () => {
      if (pickedNumber.value.trim()) trailerNumber.value = pickedNumber.value.trim();
      updateTrailer();
    });
    form.addEventListener('trailer-plan-change', event => {
      freight = event.detail || {};
      updateTrailer();
    });
    updateTrailer();
    const pickupFreight = stop.kind === 'pickup' && !load.return_of ? [
      input('Commodity', 'commodity', { maxLength:120 }),
      input('Weight', 'weight', { inputMode:'decimal', maxLength:20 }),
      input('Pieces', 'pieces', { inputMode:'numeric', maxLength:20 }),
      input('BOL number', 'bol', { maxLength:100 })
    ] : [];
    form.append(fields(
      trailer, bobtail, ...pickupFreight,
      input('Lumper fee paid ($, optional)', 'lumperFee', { inputMode:'decimal', maxLength:20 }),
      dropped,
      picked, field('Picked-up trailer status', state)
    ));
    form.append(trailerTypes, serviceAlert, alert);
    const paperworkTitle = stop.kind === 'pickup' ? 'BOL' : 'proof of delivery';
    const paperwork = button('', () => {
      if (!draft.saving) driverPaperwork.edit(draft, 'Upload ' + paperworkTitle, pro(load) + ' · ' + stop.info.company, updatePaperwork);
    });
    function updatePaperwork() {
      const total = draft.files.length;
      paperwork.textContent = total ? 'Edit ' + paperworkTitle + ' · ' + total + (total === 1 ? ' file' : ' files') : 'Add ' + paperworkTitle;
    }
    updatePaperwork();
    const actions = node('div', '', 'dispatch-actions');
    actions.append(paperwork, submit);
    form.append(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (draft.saving || !currentUser || !updateTrailer()) return;
      const user = currentUser;
      const data = { ...values(form), stop: stop.key };
      draft.saving = paperwork.disabled = submit.disabled = true;
      const originalLabel = submit.textContent;
      try {
        const documents = [];
        for (const [index, entry] of draft.files.entries()) {
          if (currentUser !== user) return;
          submit.textContent = 'Uploading ' + (index + 1) + ' of ' + draft.files.length + '…';
          documents.push(await driverPaperwork.upload(load.id, user.id, entry));
        }
        if (currentUser !== user) return;
        if (documents.length) data.documents = documents;
        submit.textContent = 'Saving stop…';
        submit.disabled = false;
        await mutate(submit, 'driver', 'finish_stop', load.id, data,
          stop.kind === 'pickup' ? 'Pickup departure recorded.' : 'Delivery departure recorded.',
          () => paperworkDrafts.delete(key));
      } catch (error) {
        if (currentUser === user) showToast(error.message || 'Could not upload the paperwork.');
      } finally {
        draft.saving = paperwork.disabled = false;
        updateTrailer();
        submit.textContent = originalLabel;
      }
    });
    return form;
  }

  function returnForm(load) {
    const section = node('details', '', 'driver-return-request');
    section.append(node('summary', 'Request a Return Load'));
    const form = node('form');
    const mode = node('select');
    mode.name = 'mode';
    setOptions(mode, [['destination','New Destination'],['reverse','Reverse Load']], 'Choose an option');
    mode.required = true;
    const destination = input('New destination', 'destination', {maxLength:160});
    const destinationValue = destination.querySelector('input');
    const update = () => {
      const useDestination = mode.value === 'destination';
      destination.classList.toggle('hidden', !useDestination);
      destinationValue.disabled = !useDestination;
      destinationValue.required = useDestination;
    };
    mode.addEventListener('change', update);
    update();
    const submit = submitButton('Request Return Load');
    form.append(fields(field('Return route', mode), destination,
      input('BOL number (optional)', 'bol', { maxLength:100 }),
      input('Commodity (optional)', 'commodity', { maxLength:120 }),
      input('Weight (lb, optional)', 'weight', { type:'number', min:'0.01', max:'999999999999.99', step:'0.01', inputMode:'decimal' }),
      input('Pieces (optional)', 'pieces', { type:'number', min:'1', max:'999999999', step:'1', inputMode:'numeric' })
    ), submit);
    const requestId = crypto.randomUUID();
    form.addEventListener('submit', event => {
      event.preventDefault();
      void mutate(submit, 'driver', 'request_return', load.id, { ...values(form), request_id: requestId },
        result => 'B-' + result.pro + ' created for Dispatch review.', () => { selected = requestId; form.reset(); });
    });
    section.append(form);
    return section;
  }

  function paintProgress(load, panel) {
    if (isQueued(load)) {
      const current = driverData.loads.find(row => Number(row.queuePosition) === 1);
      panel.append(node('p', current ? 'Finish ' + pro(current) + ' before starting this load.' :
        'Finish your current load before starting this one.', 'driver-load-queued'));
    }
    panel.append(node('h2', 'Stops', 'driver-load-stop-title'), showAllStops(load));
    const canReport = !isQueued(load) && load.status === 'current' && load.decision === 'accepted' &&
      !(load.yard_handoff?.first_driver && load.yard_handoff?.picked_up_at);
    if (canReport) {
      for (const kind of ['breakdown', 'traffic']) {
        const report = node('div');
        report.id = 'driver-load-report-' + kind;
        paintDriverIncident(load, kind, report);
        panel.append(report);
      }
    }
    if (!isQueued(load) && load.decision === 'accepted' && load.review !== 'denied') {
      const actions = node('div');
      actions.id = 'driverLoadProgressActions';
      paintProgressActions(load, actions);
      panel.append(actions);
    }
    const notes = node('section', '', 'dispatch-load-note-section');
    const list = node('div');
    list.id = 'driverLoadNotes';
    list.append(loadNotes(load.loadNotes));
    notes.append(node('h3', 'Load Notes'), list);
    if (canReport) {
      const form = node('form');
      const note = node('textarea');
      Object.assign(note, { name: 'note', maxLength: 1000, rows: 3, required: true });
      const submit = submitButton('Add Note');
      form.append(field('Note for Dispatch', note), submit);
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (note.value.trim()) void mutate(submit, 'driver', 'add_load_note', load.id, values(form), 'Load note sent to Dispatch.');
        else note.focus();
      });
      notes.append(form);
    }
    panel.append(notes);
  }

  function paintProgressActions(load, panel) {
    if (load.yard_handoff?.picked_up_at) {
      const { trailer, yard, picked_up_at, first_driver } = load.yard_handoff;
      panel.append(node('p', (first_driver ? 'Trailer handed off' : 'Yard pickup') + ' · ' + trailer + ' · ' + yard + ' · ' + clock(picked_up_at), 'muted'));
    }
    const handedOff = load.yard_handoff?.first_driver && load.yard_handoff?.picked_up_at;
    if (!handedOff && (load.status === 'current' || load.review === 'pending')) {
      const stop = load.stops.find(row => !row.progress?.completedAt);
      if (stop && !stop.progress?.arrivalAt) panel.append(button('Arrive at ' + (stop.kind === 'pickup' ? 'Pickup' : 'Delivery'),
        control => mutate(control, 'driver', 'arrive', load.id, { stop: stop.key }, 'Arrival recorded.'), 'primary-btn'));
      else if (stop) panel.append(stopForm(load, stop));
    }
    if (!load.return_of && ['current','completed'].includes(load.status)) panel.append(returnForm(load));
  }

  function loadNotes(notes) {
    if (!Array.isArray(notes) || !notes.length) return node('p', 'No load notes yet.', 'muted');
    const list = node('ol', '', 'dispatch-load-notes');
    for (const event of notes) {
      const row = node('li');
      row.append(node('strong', event.label));
      const instant = new Date(event.at);
      if (event.at && Number.isFinite(instant.valueOf())) {
        const time = node('time', instant.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
        time.dateTime = event.at;
        row.append(time);
      }
      if (event.source) row.append(node('span', event.source, 'muted'));
      if (event.body) row.append(node('p', event.body));
      list.append(row);
    }
    return list;
  }

  function paintDriverIncident(load, kind, host) {
    const traffic = kind === 'traffic';
    const report = load[kind];
    host.replaceChildren();
    if (report?.active) {
      const alert = node('section', '', traffic ? 'dispatch-traffic' : 'dispatch-breakdown');
      alert.dataset[kind] = 'true';
      alert.append(node('h3', traffic ? 'Held up in traffic' : 'Breakdown reported'));
      if (report.location || report.notes) alert.append(node('p', [report.location, report.notes].filter(Boolean).join(' · ')));
      alert.append(button(traffic ? 'Mark Traffic Cleared' : 'Back on the Road', control => mutate(
        control, 'driver', traffic ? 'clear_traffic' : 'resume_breakdown', load.id,
        { report_id: report.id }, traffic ? 'Dispatch was notified that traffic cleared.' : 'Dispatch was notified that you’re back on the road.')));
      host.append(alert);
      return;
    }
    if (report?.resolvedAt) host.append(node('p', traffic ? 'Traffic cleared' :
      report.resolution === 'recovered' ? 'Load recovered' : 'Breakdown cleared', 'muted'));
    const disclosure = node('details', '', 'dispatch-breakdown');
    disclosure.append(node('summary', traffic ? 'Report a Traffic Delay' : 'Report a Breakdown'));
    const form = node('form');
    const notes = node('textarea');
    Object.assign(notes, { name: 'notes', maxLength: 500, rows: 3 });
    const submit = submitButton('Notify Dispatch');
    form.append(fields(input('Location (optional)', 'location', { maxLength: 160 }), field('What happened? (optional)', notes)), submit);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void mutate(submit, 'driver', traffic ? 'report_traffic' : 'report_breakdown', load.id, values(form),
        traffic ? 'Traffic delay reported to Dispatch.' : 'Breakdown reported to Dispatch.');
    });
    disclosure.append(form);
    host.append(disclosure);
  }

  function relayCard(load, freight) {
    const address = [freight.relayAddress, [freight.relayCity, freight.relayState, freight.relayZip].filter(Boolean).join(' ')]
      .filter(Boolean).join(' · ');
    const relay = offerFields([
      ['Relay location', freight.relayLocation], ['Relay address', address], ['Relay date', freight.relayDate],
      ['Driver 1 drop time', offerTime(freight.relayDrop)], ['Driver 2 pickup time', offerTime(freight.relayPickup)],
      ['Driver 1 loaded miles', offerNumber(freight.firstLegMiles, quantity, ' mi')],
      ['Driver 1 empty miles', offerNumber(freight.firstLegEmptyMiles, quantity, ' mi')],
      ['Yard handoff', load.yard_handoff?.yard], ['Yard trailer', load.yard_handoff?.trailer]
    ], 'load-offer-freight');
    if (!relay.childElementCount) return null;
    const card = offerCard('Relay & Yard');
    card.append(relay);
    return card;
  }

  async function mileageRequest(action, loadId, readings) {
    const { data, error } = await supabaseClient.rpc('driver_operational_mileage', {
      action, target_load: loadId, ...(readings ? { readings } : {})
    });
    if (error) throw error;
    return data;
  }

  function paintMileageCard(card, load, mileage, message = '') {
    const reading = mileage.reading;
    const form = node('form');
    const fields = node('div', '', 'dispatch-fields');
    const odometer = { type: 'text', inputMode: 'numeric', pattern: '[0-9]{1,8}', maxLength: 8 };
    const truckField = input('Truck number', 'truck_number', { required: true, maxLength: 40, value: reading?.truck_number || mileage.truck || '' });
    const truck = truckField.querySelector('input');
    fields.append(
      truckField,
      input('Starting odometer (mi)', 'start_odometer', { ...odometer, required: true, value: reading?.start_odometer ?? '' })
    );
    if (mileage.can_finish) fields.append(
      input('Ending odometer (mi)', 'end_odometer', { ...odometer, required: true, value: reading?.end_odometer ?? '' })
    );
    const feedback = node('p', message, 'muted');
    feedback.setAttribute('role', 'status');
    const alert = node('p', '', 'driver-trailer-alert');
    alert.id = 'driver-mileage-truck-alert';
    alert.setAttribute('role', 'alert');
    truck.setAttribute('aria-describedby', alert.id);
    const save = submitButton('Save Mileage');
    let saving = false;
    function validateTruck() {
      const entered = truck.value.trim().toUpperCase();
      const mismatch = Boolean(mileage.truck && entered && entered !== mileage.truck.toUpperCase());
      alert.textContent = mismatch ? 'Truck mismatch. Dispatch assigned truck ' + mileage.truck + '.' : '';
      truck.setAttribute('aria-invalid', String(mismatch));
      save.disabled = saving || mismatch;
    }
    form.append(fields, alert, feedback, save);
    truck.addEventListener('input', validateTruck);
    validateTruck();
    const miles = value => value == null ? '—' : quantity.format(value) + ' mi';
    const facts = reading && offerFields([
      ['Loaded miles', miles(reading.loaded)], ['Empty miles before this load', miles(reading.empty)]
    ], 'load-offer-freight');
    const content = node('div', '', 'load-mileage-content');
    content.append(node('p', 'Record your truck’s odometer at the start and finish. These miles do not affect pay.', 'muted'));
    if (!mileage.can_finish) content.append(node('p', 'Enter the ending reading after completing your stops.', 'muted'));
    if (facts) content.append(facts);
    content.append(form);
    card.lastElementChild.replaceWith(content);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (save.disabled) return;
      saving = true;
      validateTruck();
      feedback.textContent = '';
      feedback.className = 'muted';
      const user = currentUser;
      try {
        const values = Object.fromEntries(new FormData(form));
        const updated = await mileageRequest('save', load.id, { ...values, updated_at: reading?.updated_at ?? null });
        if (card.isConnected && currentUser === user) paintMileageCard(card, load, updated, 'Mileage saved.');
      } catch (error) {
        if (currentUser === user) {
          feedback.className = 'driver-trailer-alert';
          feedback.textContent = error.message || 'Could not save mileage.';
        }
      } finally {
        saving = false;
        validateTruck();
      }
    });
  }

  async function loadMileageCard(panel, load) {
    const card = panel?.querySelector('[data-load-mileage]');
    if (!card || card.dataset.requested || isQueued(load)) return;
    const user = currentUser;
    card.dataset.requested = 'true';
    try {
      const mileage = await mileageRequest('read', load.id);
      if (card.isConnected && currentUser === user) paintMileageCard(card, load, mileage);
    } catch (error) {
      if (card.isConnected && currentUser === user) {
        const content = node('div', '', 'load-mileage-content');
        content.append(node('p', error.message || 'Could not load mileage.', 'muted'), button('Retry', () => {
            delete card.dataset.requested;
            void loadMileageCard(panel, load);
          }));
        card.lastElementChild.replaceWith(content);
      }
    }
  }

  function equipmentIssueCard(load, signature) {
    const card = offerCard('Truck & Trailer Condition');
    card.dataset.loadEquipmentIssue = signature;
    const host = node('div', '', 'load-mileage-content');
    const status = node('p', '', 'muted');
    status.setAttribute('role', 'status');
    const controls = node('div');
    const unit = node('select');
    unit.name = 'equipment_id';
    unit.required = true;
    unit.setAttribute('aria-label', 'Unit');
    const note = node('textarea');
    Object.assign(note, { name: 'note', maxLength: 2000, required: true, rows: 3 });
    const submit = submitButton('Mark Out of Service');
    const form = node('form');
    form.append(field('Unit', unit), field('Describe the issue', note), submit);
    let options;
    async function request(action, payload) {
      const { data, error } = await supabaseClient.rpc('driver_equipment_issue', {
        action, target_load: load.id, ...(payload ? { payload } : {})
      });
      if (error) throw error;
      return data;
    }
    async function loadOptions() {
      launch.disabled = true;
      status.textContent = 'Checking assigned equipment…';
      const user = currentUser;
      try {
        const results = await request('read');
        if (currentUser !== user || !card.isConnected) return;
        options = results.filter(row => !row.out_of_service);
        if (!options.length) {
          status.textContent = results.length ? 'The registered units are already out of service.'
            : 'No assigned units are registered. Contact Dispatch to report the issue.';
          return;
        }
        setOptions(unit, options.map(row => [row.id, (row.type === 'truck' ? 'Truck ' : 'Trailer ') + row.unit]), 'Select a unit');
        controls.replaceChildren(form);
        status.textContent = '';
        unit.focus();
      } catch (error) {
        if (currentUser === user) status.textContent = error.message || 'Could not check assigned equipment.';
      } finally { launch.disabled = false; }
    }
    const launch = button('Report Out of Service', loadOptions);
    controls.append(launch);
    host.append(controls, status);
    card.append(host);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const selected = options.find(row => row.id === unit.value);
      if (!selected || submit.disabled) return;
      submit.disabled = true;
      const user = currentUser;
      try {
        await request('report', { equipment_id: selected.id, equipment_type: selected.type, note: note.value.trim() });
        if (currentUser !== user || !card.isConnected) return;
        form.reset();
        status.textContent = 'Unit ' + selected.unit + ' marked out of service.';
        controls.replaceChildren(launch);
      } catch (error) {
        if (currentUser === user) status.textContent = error.message || 'Could not report the equipment issue.';
      } finally { submit.disabled = false; }
    });
    return card;
  }

  function paintLoadInfo(load, panel) {
    const freight = {
      ...load.freight,
      trailerNumber: load.incomingTrailer === '' ? 'Bobtail' : load.incomingTrailer ?? load.freight?.trailerNumber
    };
    const cards = node('div', '', 'load-offer-grid');
    cards.append(offerFreight(freight), offerStops(load, 'pickup', true), offerStops(load, 'delivery', true));
    const relay = relayCard(load, freight);
    if (relay) cards.append(relay);
    if (load.pay) cards.append(offerPay(load.pay));
    if (load.decision === 'accepted' && ['current', 'completed'].includes(load.status)) {
      const signature = JSON.stringify([load.id, load.status, isQueued(load), load.stops.every(stop => stop.progress?.completedAt)]);
      let mileage = panel.querySelector('[data-load-mileage]');
      if (mileage?.dataset.loadMileage !== signature) {
        mileage = offerCard('Mileage Tracker');
        mileage.dataset.loadMileage = signature;
        mileage.append(node('p', isQueued(load) ? 'Finish your current load before logging mileage here.' : 'Loading…', 'load-offer-empty'));
      }
      cards.append(mileage);
    }
    if (load.decision === 'accepted' && load.status === 'current' && Number(load.queuePosition) === 1) {
      const signature = JSON.stringify([load.id, load.incomingTrailer, freight.truckNumber]);
      const existing = panel.querySelector('[data-load-equipment-issue]');
      cards.append(existing?.dataset.loadEquipmentIssue === signature ? existing : equipmentIssueCard(load, signature));
    }
    panel.replaceChildren(cards);
    if (detailTab === 'info') void loadMileageCard(panel, load);
  }

  function paintLoadOverview(load, panel) {
    const freight = load.freight || load.offer?.freight || {};
    const stops = load.stops;
    const next = load.status !== 'completed' && stops.find(stop => !stop.progress?.completedAt);
    const location = stop => [stop?.info.city, stop?.info.state].filter(Boolean).join(', ') || stop?.info.company;
    const route = [...new Set([location(stops[0]), location(stops.at(-1))].filter(Boolean))].join(' → ');
    const currentStatus = load.breakdown?.active ? ['Breakdown reported', 'breakdown']
      : load.traffic?.active ? ['Held up in traffic', 'traffic']
        : isQueued(load) ? ['Queued · ' + load.queuePosition, 'assigned'] : [label(load), load.status === 'completed' ? 'complete' : 'assigned'];
    const status = node('span', currentStatus[0], 'dispatch-status');
    status.dataset.tone = currentStatus[1];
    const title = node('h1', pro(load));
    title.id = 'driverLoadHeading';
    title.tabIndex = -1;
    const heading = node('div', '', 'driver-load-heading');
    heading.append(title, status);
    panel.replaceChildren(heading);
    if (route) panel.append(node('p', route, 'driver-load-route'));
    if (load.fleet) panel.append(node('p', load.fleet, 'muted'));
    if (isOffer(load)) return;

    const summary = offerFields([
      [next?.kind === 'pickup' ? 'Next pickup' : 'Next delivery', next ? next.info.company || place(next.info) : ''],
      ['Appointment', next && (stopAppointment(next.info) || 'To be scheduled')],
      ['Route number', freight.route], ['Pickup number', freight.pickupNumber],
      ['Commodity', freight.commodity], ['Equipment', freight.equipment],
      ['Weight', offerNumber(freight.weight, quantity, ' lb')],
      ['Trailer number', load.incomingTrailer === '' ? 'Bobtail' : load.incomingTrailer || freight.trailerNumber]
    ], 'driver-load-summary');
    if (summary.childElementCount) panel.append(summary);
    if (stops.length) {
      const complete = stops.filter(stop => stop.progress?.completedAt).length;
      const count = node('label', complete + ' of ' + stops.length + ' stops completed', 'driver-load-stop-count');
      const progress = node('progress');
      Object.assign(progress, { value: complete, max: stops.length });
      count.append(progress);
      panel.append(count);
    }
  }

  function paintDetails() {
    const panel = byId('driverWorkflowDetail');
    const load = driverData.loads.find(row => row.id === selected);
    const loadInfoForms = [...panel.querySelectorAll('[data-load-mileage], [data-load-equipment-issue]')];
    panel.replaceChildren();
    panel.classList.toggle('hidden', !load);
    const pendingOffer = isOffer(load);
    panel.classList.toggle('load-offer', pendingOffer);
    if (!load) return;
    const overview = node('div');
    overview.id = 'driverLoadOverview';
    paintLoadOverview(load, overview);
    panel.append(overview);
    if (pendingOffer) {
      paintOffer(load, panel);
      return;
    }

    const tabs = node('div', '', 'driver-load-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Load details');
    const views = [
      ['progress', 'Load Progress', paintProgress], ['info', 'Load Info', paintLoadInfo]
    ].map(([key, label, paint]) => {
      const view = node('div');
      view.id = 'driver-load-view-' + key;
      view.setAttribute('role', 'tabpanel');
      view.tabIndex = 0;
      const control = button(label, () => activate(key));
      control.id = 'driver-load-tab-' + key;
      control.setAttribute('role', 'tab');
      control.setAttribute('aria-controls', view.id);
      view.setAttribute('aria-labelledby', control.id);
      tabs.append(control);
      if (key === 'info') view.append(...loadInfoForms);
      paint(load, view);
      return { key, view, control };
    });
    function activate(key) {
      detailTab = key;
      for (const entry of views) {
        const active = entry.key === key;
        entry.control.setAttribute('aria-selected', String(active));
        entry.control.tabIndex = active ? 0 : -1;
        entry.view.hidden = !active;
      }
      if (key === 'info') void loadMileageCard(views.find(entry => entry.key === key).view, load);
    }
    tabs.addEventListener('keydown', event => {
      const index = views.findIndex(entry => entry.control === event.target);
      if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? views[0] : event.key === 'End' ? views.at(-1)
        : views[(index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length];
      activate(next.key);
      next.control.focus();
    });
    activate(detailTab);
    panel.append(tabs, ...views.map(entry => entry.view));
  }

  function companyLoadUpdate(user, data, visible) {
    const key = 'rigtracker-load-seen:' + user.id;
    const snapshot = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < snapshot.length; i++) hash = Math.imul(31, hash) + snapshot.charCodeAt(i) | 0;
    const version = String(hash);
    try { seenLoadVersion ||= localStorage.getItem(key) || ''; } catch {}
    if (!seenLoadVersion || visible) {
      seenLoadVersion = version;
      try { localStorage.setItem(key, version); } catch {}
    }
    return (data.loads.length > 0 || data.yard.length > 0) && version !== seenLoadVersion;
  }

  function showingLoads() {
    return byId('driverLoadsPage').classList.contains('active') || byId('driverLoadDetailPage').classList.contains('active');
  }

  function updateOpenLoad(load, previous) {
    if (!previous || isOffer(load) || isOffer(previous) || previous.status !== load.status ||
      previous.decision !== load.decision || previous.review !== load.review ||
      previous.queuePosition !== load.queuePosition ||
      JSON.stringify(previous.yard_handoff) !== JSON.stringify(load.yard_handoff)) {
      paintDetails();
      return;
    }

    const overview = byId('driverLoadOverview');
    if (overview) {
      const focused = document.activeElement?.id === 'driverLoadHeading';
      paintLoadOverview(load, overview);
      if (focused) byId('driverLoadHeading').focus({ preventScroll: true });
    }
    const info = byId('driver-load-view-info');
    if (info) paintLoadInfo(load, info);
    const actions = byId('driverLoadProgressActions');
    const freightChanged = JSON.stringify(previous.freight) !== JSON.stringify(load.freight);
    if (freightChanged) {
      actions?.querySelector('[data-trailer-departure]')?.dispatchEvent(new CustomEvent('trailer-plan-change', { detail: load.freight }));
    }
    if (previous.incomingTrailer !== load.incomingTrailer) {
      const trailer = byId('driverLoadProgressActions')?.querySelector('input[name=trailer]');
      if (trailer) {
        const previousNumber = trailer.dataset.incomingTrailer ?? '';
        if (trailer.value.trim().toUpperCase() === previousNumber.toUpperCase()) trailer.value = load.incomingTrailer ?? '';
        if (load.incomingTrailer == null) delete trailer.dataset.incomingTrailer;
        else trailer.dataset.incomingTrailer = load.incomingTrailer;
        trailer.dispatchEvent(new Event('input'));
      }
    }
    const stopsChanged = JSON.stringify(previous.stops) !== JSON.stringify(load.stops);
    if (stopsChanged || freightChanged) byId('driverLoadStops')?.replaceWith(showAllStops(load));
    if (stopsChanged) {
      const before = previous.stops.find(stop => !stop.progress?.completedAt);
      const after = load.stops.find(stop => !stop.progress?.completedAt);
      if (actions && (before?.key !== after?.key || Boolean(before?.progress?.arrivalAt) !== Boolean(after?.progress?.arrivalAt))) {
        actions.replaceChildren();
        paintProgressActions(load, actions);
      }
    }
    for (const kind of ['breakdown', 'traffic']) {
      const report = byId('driver-load-report-' + kind);
      if (report && JSON.stringify(previous[kind]) !== JSON.stringify(load[kind])) paintDriverIncident(load, kind, report);
    }
    const notes = byId('driverLoadNotes');
    if (notes && JSON.stringify(previous.loadNotes) !== JSON.stringify(load.loadNotes)) {
      notes.replaceChildren(loadNotes(load.loadNotes));
    }
  }

  async function refresh(quiet = false, redraw = !quiet) {
    const user = currentUser;
    const role = accountTypeFor(user);
    const listScreen = byId('driverLoadsPage');
    const detailScreen = byId('driverLoadDetailPage');
    const canRead = role === 'driver' || role === 'company' || (role === 'fleet' && showingLoads());
    if ((quiet && driverRead) || !user || !canRead) return;
    const request = {};
    driverRead = request;
    try {
      const data = await rpc('driver', 'list');
      if (driverRead !== request || user !== currentUser) return;
      const previous = driverData.loads.find(load => load.id === selected);
      driverData = data;
      const unread = data.loads.filter(isOffer);
      const offers = data.yard.filter(offer => !offer.picked_up_at);
      const keys = [...unread.map(load => 'load:' + load.id), ...offers.map(offer => 'trailer:' + offer.id + ':' + offer.trailer)];
      const justArrived = keys.some(key => !seenDriver.has(key));
      if (driverInitialized && justArrived) showToast('You have a new load assignment or yard trailer.');
      seenDriver = new Set(keys);
      driverInitialized = true;
      const viewing = showingLoads() && !document.hidden;
      const updated = role === 'company' && companyLoadUpdate(user, data, viewing);
      if (typeof rigTrackerApp !== 'undefined') {
        rigTrackerApp.badge('loads', keys.length || (updated ? '•' : ''), keys.length ? 'new assignments or yard trailers' : 'load update');
      }
      byId('profileDriverLoadsButton').textContent = keys.length ? 'Loads (' + keys.length + ')' : updated ? 'Loads · Update' : 'Loads';
      byId('ownerDriverLoadsButton').textContent = keys.length ? 'Loads (' + keys.length + ')' : 'Loads';
      const snapshot = JSON.stringify(data);
      if (listScreen.classList.contains('active')) {
        if (redraw || snapshot !== driverSnapshot) paintDriverList();
        byId('driverWorkflowStatus').textContent = '';
        driverSnapshot = snapshot;
      }
      if (detailScreen.classList.contains('active')) {
        byId('driverLoadDetailStatus').textContent = '';
        const current = data.loads.find(load => load.id === selected);
        if (!current) {
          closeLoad();
          byId('driverWorkflowStatus').textContent = 'This load is no longer available.';
        } else if (redraw) {
          paintDetails();
        } else if (JSON.stringify(previous) !== JSON.stringify(current)) {
          updateOpenLoad(current, previous);
        }
      }
    } catch (error) {
      if (driverRead === request && user === currentUser && (!quiet || showingLoads())) {
        const status = detailScreen.classList.contains('active') ? 'driverLoadDetailStatus' : 'driverWorkflowStatus';
        byId(status).textContent = error.message || 'Could not load assignments.';
      }
    } finally { if (driverRead === request) driverRead = null; }
  }

  function returnReviewForm(load) {
    const form = node('form', '', 'panel');
    form.append(node('h3', pro({ ...load, return_of:true })),
      node('p', ['From A-' + load.source_pro, load.driver].filter(Boolean).join(' · '), 'muted'));
    const freight = load.freight || {};
    const cargo = offerFields([
      ['BOL number', freight.bolNumber], ['Commodity', freight.commodity],
      ['Weight', offerNumber(freight.weight, quantity, ' lb')], ['Pieces', offerNumber(freight.pieces, quantity)]
    ], 'dispatch-detail-facts');
    if (cargo.childElementCount) form.append(cargo);
    const shipper = input('Shipper', 'shipper', { value:load.shipper || '', maxLength:160, required:true });
    const receiver = input('Receiver', 'receiver', { value:load.receiver || '', maxLength:160, required:true });
    const pickupNow = input('Use current time for pickup', 'pickup_now', { type:'checkbox', value:'yes' });
    pickupNow.classList.add('dispatch-checkbox');
    const pickupZone = node('select');
    pickupZone.name = 'pickup_zone';
    setOptions(pickupZone, Object.entries(zoneNames), 'Select time zone');
    pickupZone.value = load.pickup?.zone || '';
    const zoneField = field('Pickup time zone', pickupZone);
    const addresses = node('details', '', 'panel');
    addresses.append(node('summary', 'Pickup & Delivery Addresses'));
    const addAddress = (prefix, label, source, nameField) => {
      const address = input(label + ' street address', prefix + '_address', { value:source.address || '', maxLength:180 });
      const city = input(label + ' city', prefix + '_city', { value:source.city || '', maxLength:80 });
      const region = input(label + ' state', prefix + '_state', { value:source.state || '', maxLength:2, pattern:'[A-Za-z]{2}', title:'Two-letter state abbreviation' });
      const zip = input(label + ' ZIP', prefix + '_zip', { value:source.zip || '', maxLength:10, pattern:'[0-9]{5}(-[0-9]{4})?', title:'5-digit or ZIP+4 code', inputMode:'numeric' });
      addresses.append(fields(address, city, region, zip));
      fleetDispatchApp.useSavedLocation(nameField.querySelector('input'), location => {
        for (const [key, wrapper] of [['address', address], ['city', city], ['state', region], ['zip', zip]]) {
          wrapper.querySelector('input').value = location[key];
        }
        addresses.open = true;
      });
    };
    addAddress('pickup', 'Pickup', load.pickup || {}, shipper);
    addAddress('receiver', 'Delivery', load.delivery || { address:load.address }, receiver);
    const yard = input('Yard for a split', 'yard', { maxLength:160 });
    const trailer = input('Trailer for the yard split', 'trailer', { maxLength:40 });
    const yardInput = yard.querySelector('input');
    const trailerInput = trailer.querySelector('input');
    const updateRequired = () => {
      const useNow = pickupNow.querySelector('input').checked;
      zoneField.classList.toggle('hidden', !useNow);
      pickupZone.disabled = !useNow;
      pickupZone.required = useNow;
      yardInput.required = Boolean(trailerInput.value.trim());
      trailerInput.required = Boolean(yardInput.value.trim());
    };
    form.addEventListener('input', updateRequired);
    updateRequired();
    form.append(fields(shipper, receiver, pickupNow, zoneField), addresses, fields(yard, trailer));
    const post = submitButton('Post to Current Loads');
    const deny = button('Deny', control => mutate(control, 'dispatch', 'deny_return', load.id, {}, 'Return load denied.'));
    const actions = node('div', '', 'dispatch-actions');
    actions.append(post, deny);
    const feedback = node('p', '', 'dispatch-form-issues hidden');
    feedback.setAttribute('role', 'alert');
    const showIssue = fleetDispatchApp.validationFeedback(form, feedback);
    form.append(feedback, actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      showIssue('');
      void mutate(post, 'dispatch', 'post_return', load.id, values(form), 'Return posted to Current Loads.', null, showIssue);
    });
    return form;
  }

  function paintOffice(data) {
    const status = byId('dispatchWorkflowStatus');
    status.textContent = '';
    setList('dispatchWorkflowReturns', data.returns.map(returnReviewForm), 'No returns are waiting for review.');
    setList('dispatchWorkflowResponses', data.responses.map(response => {
      const row = node('article', '', 'dispatch-load-row');
      const info = node('div');
      info.append(node('strong', pro(response) + ' · ' + (response.driver || 'Driver')),
        node('p', [statusText[response.decision], clock(response.at)].filter(Boolean).join(' · '), 'muted'));
      row.append(info, button('Open load', () => fleetDispatchApp.openRecord(response.id)));
      return row;
    }), 'Driver responses will appear here.');
    setList('dispatchWorkflowYard', data.yard.map(yard => {
      const row = node('article', '', 'dispatch-load-row');
      const info = node('div');
      info.append(node('strong', pro(yard) + ' · Trailer ' + yard.trailer), node('p', yard.yard),
        node('p', [yard.driver, yard.picked_up_at ? 'In Transit · ' + clock(yard.picked_up_at)
          : yard.offered_driver ? 'Sent to driver' : 'Next driver unassigned'].filter(Boolean).join(' · '), 'muted'));
      row.append(info);
      if (yard.picked_up_at) {
        row.append(button('Confirm Remaining Leg', control => mutate(control, 'dispatch', 'finish_yard', yard.id, {},
          'Remaining leg assigned to the driver who picked up the trailer.')));
      } else {
        row.append(button('Send or update trailer', () => {
          byId('dispatchYardLoad').value = yard.id;
          configureYardRecipient(data);
          byId('dispatchYardSite').value = yard.yard;
          byId('dispatchYardNumber').value = yard.trailer;
          byId('dispatchYardRecipient').value = yard.offered_driver || '';
          byId('dispatchYardRecipient').focus();
        }));
      }
      return row;
    }), 'No yard splits are waiting.');
    setOptions(byId('dispatchYardLoad'), data.loads.map(load => [load.id, pro(load) + (load.receiver ? ' · ' + load.receiver : '')]), 'Select a current load');
    configureYardRecipient(data);
    byId('dispatchYardLoad').onchange = () => configureYardRecipient(data);
  }

  function configureYardRecipient(data) {
    const load = data.loads.find(row => row.id === byId('dispatchYardLoad').value);
    setOptions(byId('dispatchYardRecipient'), data.drivers.filter(driver => driver.id !== load?.driver_id)
      .map(driver => [driver.id, driver.name]), 'Leave next driver unassigned');
  }

  async function refreshOffice(quiet = false, force = false) {
    const user = currentUser;
    const fleet = dispatchFleet();
    if ((quiet && officeRead) || !user || !fleet) return;
    const request = {};
    officeRead = request;
    const panel = byId('dispatch-panel-activity');
    try {
      const data = await rpc('dispatch', 'list');
      if (officeRead !== request || currentUser !== user || dispatchFleet() !== fleet) return;
      const keys = [
        ...data.returns.map(row => 'return:' + row.id),
        ...data.yard.filter(row => row.picked_up_at).map(row => 'pickup:' + row.id),
        ...data.responses.map(row => 'response:' + row.id + ':' + row.driver + ':' + row.at)
      ];
      if (officeInitialized && keys.some(key => !seenOffice.has(key))) showToast('New driver activity in Dispatch.');
      officeInitialized = true;
      seenOffice = new Set(keys);
      const waiting = data.returns.length + data.yard.filter(yard => yard.picked_up_at).length +
        data.responses.filter(row => row.decision === 'rejected').length;
      byId('dispatch-tab-activity').textContent = waiting ? 'Driver Activity (' + waiting + ')' : 'Driver Activity';
      const snapshot = JSON.stringify(data);
      if ((force || snapshot !== officeSnapshot) && (!quiet || !panel.contains(document.activeElement))) {
        paintOffice(data);
        officeSnapshot = snapshot;
      }
    } catch (error) {
      if (officeRead === request && currentUser === user && (!quiet || !panel.classList.contains('hidden'))) {
        byId('dispatchWorkflowStatus').textContent = error.message || 'Could not load driver activity.';
      }
    } finally { if (officeRead === request) officeRead = null; }
  }

  function openLoad(id) {
    if (!driverData.loads.some(load => load.id === id)) return;
    selected = id;
    detailTab = 'progress';
    byId('driverLoadDetailStatus').textContent = '';
    paintDetails();
    showPage('driverLoadDetailPage');
    byId('driverLoadHeading').focus({ preventScroll: true });
  }

  function closeLoad() {
    const previous = selected;
    selected = null;
    detailTab = 'progress';
    byId('driverLoadDetailStatus').textContent = '';
    paintDetails();
    paintDriverList();
    driverSnapshot = JSON.stringify(driverData);
    showPage('driverLoadsPage');
    const row = [...byId('driverWorkflowLoads').querySelectorAll('[data-driver-load-id]')]
      .find(item => item.dataset.driverLoadId === previous);
    (row?.querySelector('button') || byId('driverLoadsTitle')).focus();
  }

  function open() {
    if (byId('driverLoadDetailPage').classList.contains('active')) return refresh();
    selected = null;
    detailTab = 'progress';
    byId('driverLoadsTitle').textContent = accountTypeFor(currentUser) === 'fleet' ? 'My Loads' : 'Loads';
    showPage('driverLoadsPage');
    byId('driverWorkflowStatus').textContent = 'Loading your assignments…';
    return refresh();
  }

  function back() {
    const role = accountTypeFor(currentUser);
    if (role === 'fleet') return showFleetSection('dashboard');
    showPage(role === 'driver' ? 'dashboardPage' : 'rigTrackerProfilePage');
  }

  function reset() {
    driverPaperwork.close();
    paperworkDrafts.clear();
    driverRead = null; officeRead = null; selected = null;
    detailTab = 'progress';
    driverSnapshot = ''; officeSnapshot = ''; driverData = empty(); seenLoadVersion = '';
    driverInitialized = false; officeInitialized = false;
    seenDriver = new Set(); seenOffice = new Set();
    for (const id of ['driverWorkflowLoads','driverWorkflowDetail','driverYardList','dispatchWorkflowReturns',
      'dispatchWorkflowYard','dispatchWorkflowResponses']) byId(id).replaceChildren();
    byId('driverLoadDetailStatus').textContent = '';
    byId('driverYardForm').reset();
    byId('dispatchYardSendForm').reset();
    for (const id of ['profileDriverLoadsButton','ownerDriverLoadsButton']) byId(id).textContent = 'Loads';
    byId('dispatch-tab-activity').textContent = 'Driver Activity';
  }

  byId('driverLoadBack').addEventListener('click', closeLoad);
  byId('driverLoadRefresh').addEventListener('click', () => void refresh());
  byId('driverYardTrailer').addEventListener('input', updateYardMatch);
  updateYardMatch();
  byId('driverYardForm').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const matches = updateYardMatch();
    const { load, trailer } = values(form);
    if (!matches.length) { showToast('Enter a trailer number from your yard list.'); return; }
    const id = matches.length === 1 ? matches[0].id : load;
    if (!id) { byId('driverYardOffer').reportValidity(); return; }
    void mutate(form.querySelector('button[type="submit"]'), 'driver', 'yard_pickup', id, { trailer },
      'In Transit. Dispatch was notified.', () => form.reset());
  });

  byId('dispatchYardSendForm').addEventListener('submit', event => {
    event.preventDefault();
    const form = event.currentTarget;
    const { load, ...data } = values(form);
    void mutate(form.querySelector('button[type="submit"]'), 'dispatch', 'send_yard', load, data,
      data.driver_id ? 'Trailer sent to the driver.' : 'Yard split saved. Next driver is unassigned.', () => form.reset());
  });

  setInterval(() => {
    if (!currentUser || document.hidden) return;
    if (dispatchFleet() && !showingLoads()) void refreshOffice(true);
    else void refresh(true);
  }, 10000);

  return { open, back, refresh, refreshOffice, reset, paperworkButtons, loadNotes, stopContact,
    openDocument: (path, label) => driverPaperwork.open(path, label) };
})();
