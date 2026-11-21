const driverLoadWorkflow = (() => {
  const byId = id => document.getElementById(id);
  const pro = load => (load.return_of ? 'B-' : 'A-') + load.pro;
  const statusText = {
    pending: 'Pending Dispatch Review', posted: 'Posted to Current Loads', denied: 'Denied',
    accepted: 'Accepted', rejected: 'Rejected', completed: 'Completed'
  };
  const empty = () => ({ loads: [], yard: [] });
  const bucket = 'driver-load-documents';
  let driverData = empty();
  let selected = null;
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

  async function rpc(role, action, id, payload) {
    const data = { action, ...(id ? { load_id: id } : {}), ...(payload ? { payload } : {}) };
    if (role === 'dispatch') data.fleet = adminFleetId;
    const response = await supabaseClient.rpc(role + '_workflow', data);
    if (response.error) throw response.error;
    return response.data;
  }

  async function mutate(control, role, action, id, payload, success, after) {
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
      if (currentUser === user) showToast(error.message || 'Could not save the load update.');
    } finally { control.disabled = false; }
  }

  function paintDriverList() {
    const rows = driverData.loads.map(load => {
      const row = node('article', '', 'dispatch-load-row');
      const summary = node('div');
      summary.append(node('strong', pro(load)), node('p', label(load), 'muted'));
      const route = [place(load.stops[0]?.info), place(load.stops.at(-1)?.info)].filter(Boolean);
      if (route.length) summary.append(node('p', [...new Set(route)].join(' → ')));
      row.append(summary, button('Open load', () => { selected = load.id; paintDetails(); }));
      return row;
    });
    setList('driverWorkflowLoads', rows, 'No loads are assigned to you.');
    const offers = driverData.yard;
    const waiting = offers.filter(offer => !offer.picked_up_at);
    byId('driverYardList').replaceChildren(...offers.map(offer => node('li',
      [offer.trailer, offer.yard, pro(offer), offer.picked_up_at ? 'In Transit · Dispatch review' : 'Ready at yard'].join(' · '))));
    byId('driverYardStatus').textContent = offers.length ? '' : 'No yard trailers have been sent.';
    updateYardMatch();
    byId('driverYardForm').classList.toggle('hidden', !waiting.length);
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
    const active = load.stops.find(stop => !stop.progress?.completedAt);
    const handoffComplete = load.yard_handoff?.first_driver && load.yard_handoff?.picked_up_at;
    for (const stop of load.stops) {
      const row = node('li');
      if (stop === active && !handoffComplete && load.decision === 'accepted' && load.review !== 'denied' &&
          (load.status === 'current' || load.review === 'pending')) row.setAttribute('aria-current', 'step');
      const schedule = [stop.info.date, stop.info.from, stop.info.zone].filter(Boolean).join(' ');
      const stage = stop.progress?.completedAt ? 'Departed' : stop.progress?.arrivalAt ? 'Arrived' : 'Scheduled';
      row.append(node('strong', (stop.kind === 'pickup' ? 'Pickup' : 'Delivery') + ' · ' + stage), node('p', place(stop.info)));
      if (schedule) row.append(node('p', schedule, 'muted'));
      if (stop.info.notes) row.append(node('p', stop.info.notes));
      if (stop.progress?.arrivalAt) {
        const time = clock(stop.progress.arrivalAt, stop.info.zone);
        const departed = clock(stop.progress.completedAt, stop.info.zone);
        row.append(node('p', departed ? 'Arrived ' + time + ' · Departed ' + departed : 'Arrived ' + time, 'muted'));
      }
      const report = stop.progress?.driverReport;
      const freight = [report?.trailer && 'Trailer ' + report.trailer, report?.commodity,
        report?.weight && 'Weight ' + report.weight, report?.pieces && report.pieces + ' pieces',
        report?.bol && 'BOL ' + report.bol].filter(Boolean);
      if (freight.length) row.append(node('p', freight.join(' · '), 'muted'));
      if (report?.document) row.append(button(stop.kind === 'pickup' ? 'View BOL' : 'View delivery paperwork', () => openDocument(report.document)));
      list.append(row);
    }
    return list;
  }

  function stopForm(load, stop) {
    const form = node('form');
    const title = stop.kind === 'pickup' ? 'Depart Pickup' : 'Depart Delivery';
    form.append(node('h3', title));
    const state = node('select');
    state.name = 'loaded_state';
    setOptions(state, [['loaded','Loaded'],['empty','Empty']], 'Select loaded or empty');
    const file = node('input');
    file.type = 'file';
    file.accept = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';
    const picked = input('Trailer pickup number (optional)', 'picked_trailer', { maxLength:40 });
    picked.querySelector('input').addEventListener('input', event => { state.required = Boolean(event.target.value.trim()); });
    form.append(fields(
      input('Trailer number', 'trailer', { maxLength:40 }),
      input('Commodity', 'commodity', { maxLength:120 }),
      input('Weight', 'weight', { inputMode:'decimal', maxLength:20 }),
      input('Pieces', 'pieces', { inputMode:'numeric', maxLength:20 }),
      input('BOL number', 'bol', { maxLength:100 }),
      input('Trailer drop number (optional)', 'dropped_trailer', { maxLength:40 }),
      picked, field('Picked-up trailer status', state),
      field(stop.kind === 'pickup' ? 'Photo or copy of BOL' : 'Photo or copy of proof of delivery', file)
    ));
    const submit = submitButton(title);
    form.append(submit);
    let uploaded = null;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (submit.disabled || !currentUser) return;
      const user = currentUser;
      const data = { ...values(form), stop: stop.key };
      if (file.files[0]) {
        submit.disabled = true;
        try {
          if (uploaded?.file !== file.files[0]) {
            uploaded = { file: file.files[0], path: await upload(load, file.files[0], user) };
          }
          data.document = uploaded.path;
        } catch (error) {
          if (currentUser === user) showToast(error.message || 'Could not upload the paperwork.');
          return;
        } finally { submit.disabled = false; }
      }
      if (currentUser === user) await mutate(submit, 'driver', 'finish_stop', load.id, data,
        stop.kind === 'pickup' ? 'Pickup departure recorded.' : 'Delivery departure recorded.');
    });
    return form;
  }

  async function upload(load, file, user) {
    const names = { 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic','image/heif':'heif','application/pdf':'pdf' };
    const types = { jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',heic:'image/heic',heif:'image/heif',pdf:'application/pdf' };
    const mime = file.type || types[file.name.split('.').at(-1).toLowerCase()];
    const extension = names[mime];
    if (!extension || file.size > 10485760) throw new Error('Choose a supported photo or PDF up to 10 MB.');
    const name = load.id + '/' + user.id + '/' + crypto.randomUUID() + '.' + extension;
    const { error } = await supabaseClient.storage.from(bucket).upload(name, file, { contentType: mime });
    if (error) throw error;
    return name;
  }

  async function openDocument(path) {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { showToast('Allow the browser to open a new tab for the document.'); return; }
    tab.opener = null;
    const { data, error } = await supabaseClient.storage.from(bucket).createSignedUrl(path, 120);
    if (error || !data?.signedUrl) {
      tab.close();
      showToast('Could not open the paperwork.');
      return;
    }
    tab.location.replace(data.signedUrl);
  }

  function returnForm(load) {
    const form = node('form');
    form.append(node('h3', 'Request return load'));
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
    form.append(fields(field('Return route', mode), destination), submit);
    const requestId = crypto.randomUUID();
    form.addEventListener('submit', event => {
      event.preventDefault();
      void mutate(submit, 'driver', 'request_return', load.id, { ...values(form), request_id: requestId },
        result => 'B-' + result.pro + ' created for Dispatch review.', () => { selected = requestId; form.reset(); });
    });
    return form;
  }

  function paintDetails() {
    const panel = byId('driverWorkflowDetail');
    const load = driverData.loads.find(row => row.id === selected);
    panel.replaceChildren();
    panel.classList.toggle('hidden', !load);
    if (!load) return;
    panel.append(node('h2', pro(load)), node('p', label(load), 'muted'), node('h3', 'Load Progress'), showAllStops(load));
    if (load.status === 'current' && !load.decision) {
      const actions = node('div', '', 'dispatch-actions');
      actions.append(button('Accept', control => mutate(control, 'driver', 'accept', load.id, {}, 'Assignment accepted.'),
        'primary-btn'), button('Reject', control => mutate(control, 'driver', 'reject', load.id, {}, 'Dispatch was notified.')));
      panel.append(actions);
      return;
    }
    if (load.decision !== 'accepted' || load.review === 'denied') return;
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

  async function refresh(quiet = false, redraw = !quiet) {
    const user = currentUser;
    if ((quiet && driverRead) || !user || !['driver','company'].includes(accountTypeFor(user))) return;
    const request = {};
    driverRead = request;
    const screen = byId('driverLoadsPage');
    try {
      const data = await rpc('driver', 'list');
      if (driverRead !== request || user !== currentUser) return;
      driverData = data;
      const unread = data.loads.filter(load => load.status === 'current' && !load.decision);
      const offers = data.yard.filter(offer => !offer.picked_up_at);
      const keys = [...unread.map(load => 'load:' + load.id), ...offers.map(offer => 'trailer:' + offer.id + ':' + offer.trailer)];
      const justArrived = keys.some(key => !seenDriver.has(key));
      if (driverInitialized && justArrived) showToast('You have a new load assignment or yard trailer.');
      seenDriver = new Set(keys);
      driverInitialized = true;
      const viewing = screen.classList.contains('active') && !document.hidden;
      const updated = accountTypeFor(user) === 'company' && companyLoadUpdate(user, data, viewing);
      byId('profileDriverLoadsButton').textContent = keys.length ? 'Loads (' + keys.length + ')' : updated ? 'Loads · Update' : 'Loads';
      byId('ownerDriverLoadsButton').textContent = keys.length ? 'Loads (' + keys.length + ')' : 'Loads';
      const snapshot = JSON.stringify(data);
      if (screen.classList.contains('active') && (redraw || snapshot !== driverSnapshot)) {
        paintDriverList();
        byId('driverWorkflowStatus').textContent = '';
        driverSnapshot = snapshot;
      }
      if (screen.classList.contains('active') && redraw) paintDetails();
    } catch (error) {
      if (driverRead === request && user === currentUser && (!quiet || screen.classList.contains('active'))) {
        byId('driverWorkflowStatus').textContent = error.message || 'Could not load assignments.';
      }
    } finally { if (driverRead === request) driverRead = null; }
  }

  function returnReviewForm(load) {
    const form = node('form', '', 'panel');
    form.append(node('h3', pro({ ...load, return_of:true })),
      node('p', ['From A-' + load.source_pro, load.driver].filter(Boolean).join(' · '), 'muted'));
    form.append(fields(
      input('Shipper', 'shipper', { value:load.shipper || '', maxLength:160, required:true }),
      input('Receiver', 'receiver', { value:load.receiver || '', maxLength:160, required:true }),
      input('Delivery address', 'address', { value:load.address || '', maxLength:180 }),
      input('Yard for a split (optional)', 'yard', { maxLength:160 }),
      input('Trailer for the yard split', 'trailer', { maxLength:40 })
    ));
    const post = submitButton('Post to Current Loads');
    const deny = button('Deny', control => mutate(control, 'dispatch', 'deny_return', load.id, {}, 'Return load denied.'));
    const actions = node('div', '', 'dispatch-actions');
    actions.append(post, deny);
    form.append(actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      void mutate(post, 'dispatch', 'post_return', load.id, values(form), 'Return posted to Current Loads.');
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
    const fleet = adminFleetId;
    if ((quiet && officeRead) || !user || !fleet || accountTypeFor(user) !== 'fleet') return;
    const request = {};
    officeRead = request;
    const panel = byId('dispatch-panel-activity');
    try {
      const data = await rpc('dispatch', 'list');
      if (officeRead !== request || currentUser !== user || adminFleetId !== fleet) return;
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

  function open() {
    showPage('driverLoadsPage');
    byId('driverWorkflowStatus').textContent = 'Loading your assignments…';
    return refresh();
  }

  function back() {
    showPage(accountTypeFor(currentUser) === 'driver' ? 'dashboardPage' : 'rigTrackerProfilePage');
  }

  function reset() {
    driverRead = null; officeRead = null; selected = null;
    driverSnapshot = ''; officeSnapshot = ''; driverData = empty(); seenLoadVersion = '';
    driverInitialized = false; officeInitialized = false;
    seenDriver = new Set(); seenOffice = new Set();
    for (const id of ['driverWorkflowLoads','driverWorkflowDetail','driverYardList','dispatchWorkflowReturns',
      'dispatchWorkflowYard','dispatchWorkflowResponses']) byId(id).replaceChildren();
    byId('driverYardForm').reset();
    byId('dispatchYardSendForm').reset();
    for (const id of ['profileDriverLoadsButton','ownerDriverLoadsButton']) byId(id).textContent = 'Loads';
    byId('dispatch-tab-activity').textContent = 'Driver Activity';
  }

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
    if (accountTypeFor(currentUser) === 'fleet') void refreshOffice(true);
    else void refresh(true);
  }, 10000);

  return { open, back, refresh, refreshOffice, reset, openDocument };
})();
