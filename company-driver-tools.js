const companyDriverTools = (() => {
  const byId = id => document.getElementById(id);
  const payBucket = 'company-driver-pay';
  const adminSections = [...document.querySelectorAll('[data-company-driver-section]')];
  const historyPageSize = 25;
  const clockFormat = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  let view;
  let clockRequest;
  let payRequest;
  let adminRequest;
  let pendingUpload;
  let replacementKey;
  let payroll;
  let payrollRequest;
  let payrollLoadRequest;
  let payrollSettlementLoads = [];
  let payrollOrigin;
  let payrollSection;
  let fuelRequest;
  let paySignature;
  let viewedPayAt = 0;
  let knownNotices;
  let activeReview;
  let rosterRequest;
  let nextPresenceUpdate = 0;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(label, handler) {
    const control = element('button', label, 'outline');
    control.type = 'button';
    control.addEventListener('click', () => void handler(control));
    return control;
  }

  async function rpc(action, fleet, profileNumber, params) {
    const request = { action, ...(fleet ? { fleet } : {}), ...(profileNumber ? { profile_number: profileNumber } : {}),
      ...(params ? { params } : {}) };
    const { data, error } = await supabaseClient.rpc('company_driver_resources', request);
    if (error) throw error;
    return data;
  }

  async function profileRequest(action, fleet, fields) {
    const { data, error } = await supabaseClient.rpc('fleet_company_driver_profile', { action, target_fleet: fleet, ...fields });
    if (error) throw error;
    return data;
  }

  function sameAdmin(selection) {
    return view === selection && currentUser === selection.user;
  }

  function selectAdminSection(section) {
    for (const control of adminSections) {
      const visible = !control.classList.contains('hidden') && control.dataset.companyDriverSection === section;
      control.setAttribute('aria-pressed', String(visible));
      byId(control.getAttribute('aria-controls')).classList.toggle('hidden', !visible);
    }
    if (section === 'history' && view && !view.historyLoaded) void loadHistory(view);
  }

  function paintPresence(presence) {
    const lastSeen = presence.last_seen_at && clockFormat.format(new Date(presence.last_seen_at));
    byId('companyDriverAdminPresence').textContent = presence.online ? 'Online now'
      : lastSeen ? 'Offline · Last active ' + lastSeen : 'No online activity recorded.';
  }

  async function loadOverview(selection, initialProfile) {
    if (!selection.owner) return;
    const status = byId('companyDriverAdminOverviewStatus');
    try {
      const profile = initialProfile ?? await profileRequest('overview', selection.fleet, { profile_number: selection.profile.profile_id });
      if (!sameAdmin(selection)) return;
      selection.linked = profile.linked;
      selection.dispatchDriverId = profile.linked ? profile.dispatch_driver_id : null;
      byId('companyDriverAdminTitle').textContent = name(profile);
      byId('companyDriverAdminMessage').classList.toggle('hidden', !profile.linked);
      byId('companyDriverAdminPaySettings').classList.toggle('hidden', !selection.dispatchDriverId);
      const availability = { assigned: 'On a load', available: 'Available', 'off-duty': 'Off duty' };
      const facts = [
        ['RigTracker ID', profile.display_profile_id], ['Employee number', profile.employee_number],
        ['Fleet status', profile.linked ? 'Active' : 'Former driver'],
        ['Email', profile.email], ['Phone', profile.phone], ['Driver’s license', profile.license_number],
        ['Equipment', profile.equipment], ['Dispatch availability', availability[profile.availability]]
      ];
      byId('companyDriverAdminFacts').replaceChildren(...facts.filter(([, value]) => value)
        .flatMap(([label, value]) => [element('dt', label), element('dd', value)]));
      if (profile.linked) paintPresence(profile.presence);
      status.textContent = '';
    } catch (error) {
      if (sameAdmin(selection)) status.textContent = error.message || 'Could not load this driver profile.';
    }
  }

  async function openRoster(driver) {
    const user = currentUser;
    const fleet = adminFleetId;
    if (!fleet || accountTypeFor(user) !== 'fleet') return;
    const request = {};
    rosterRequest = request;
    const current = () => rosterRequest === request && user === currentUser && fleet === adminFleetId &&
      byId('fleetWorkspace').classList.contains('active') && !byId('dispatch-panel-drivers').classList.contains('hidden');
    try {
      const profile = await profileRequest('overview', fleet, { roster_driver: driver.id });
      if (current()) return openAdmin(profile, 'dispatch', profile);
    } catch (error) {
      if (current()) showToast(error.code === '22023' ? 'Link a Company Driver profile to view this driver’s records.'
        : error.message || 'Could not open the driver profile.');
    } finally { if (rosterRequest === request) rosterRequest = null; }
  }

  function historyRow(load) {
    const row = element('article', '', 'dispatch-load-row');
    const summary = element('div');
    summary.append(element('strong', (load.return_load ? 'B-' : 'A-') + load.pro_number));
    const route = [load.origin, load.destination].filter(Boolean).join(' → ');
    if (route) summary.append(element('p', route));
    const completed = Date.parse(load.completed_at);
    if (Number.isFinite(completed)) summary.append(element('p', 'Completed ' + clockFormat.format(completed)));
    const actions = element('div', '', 'dispatch-actions');
    actions.append(button('Open Load', async () => {
      await showFleetSection('dispatch', 'history');
      if (fleetSection === 'dispatch' && byId('fleetWorkspace').classList.contains('active')) {
        await fleetDispatchApp.openRecord(load.load_id);
      }
    }));
    for (const [index, file] of load.paperwork.entries()) {
      const label = file.kind === 'delivery' ? 'Proof of Delivery' : 'BOL';
      actions.append(button(load.paperwork.length > 1 ? 'View ' + label + ' ' + (index + 1) : 'View ' + label,
        () => driverLoadWorkflow.openDocument(file.path)));
    }
    row.append(summary, actions);
    return row;
  }

  async function loadHistory(selection, more = false) {
    if (!selection.owner || selection.historyPending) return;
    const control = byId('companyDriverHistoryMore');
    const status = byId('companyDriverHistoryStatus');
    const cursor = more ? selection.historyCursor : null;
    selection.historyPending = true;
    control.disabled = true;
    status.textContent = 'Loading completed loads…';
    try {
      const page = await profileRequest('history', selection.fleet, { profile_number: selection.profile.profile_id,
        ...(cursor ? { before_time: cursor.updated_at, before_load: cursor.load_id } : {}) });
      if (!sameAdmin(selection)) return;
      const rows = page.slice(0, historyPageSize);
      byId('companyDriverHistoryList').append(...rows.map(historyRow));
      selection.historyLoaded = true;
      selection.historyCursor = rows.at(-1);
      control.classList.toggle('hidden', page.length <= historyPageSize);
      status.textContent = rows.length || more ? '' : 'No completed loads for this driver.';
    } catch (error) {
      if (sameAdmin(selection)) status.textContent = error.message || 'Could not load history. Select Load History to retry.';
    } finally {
      selection.historyPending = false;
      if (sameAdmin(selection)) control.disabled = false;
    }
  }

  async function refreshAdminPresence() {
    const selection = view;
    if (!selection?.linked || selection.presencePending || !byId('companyDriverAdminPage').classList.contains('active')) return;
    selection.presencePending = true;
    try {
      const presence = await profileRequest('presence', selection.fleet, { profile_number: selection.profile.profile_id });
      if (sameAdmin(selection)) paintPresence(presence);
    } catch {
      if (sameAdmin(selection)) byId('companyDriverAdminPresence').textContent = 'Online status unavailable.';
    } finally { selection.presencePending = false; }
  }

  async function recordPresence() {
    if (document.hidden || Date.now() < nextPresenceUpdate) return;
    nextPresenceUpdate = Date.now() + 45000;
    try { await supabaseClient.rpc('record_company_driver_presence'); }
    catch { /* The next refresh retries. */ }
  }

  for (const control of adminSections) {
    control.addEventListener('click', () => selectAdminSection(control.dataset.companyDriverSection));
  }
  byId('companyDriverHistoryMore').addEventListener('click', () => {
    if (view?.historyCursor) void loadHistory(view, true);
  });
  byId('companyDriverAdminMessage').addEventListener('click', () => {
    if (view?.linked) void companyMessaging.openDriver({ profileId: view.profile.profile_id });
  });
  byId('companyDriverAdminPaySettings').addEventListener('click', async () => {
    const selection = view;
    if (!selection?.dispatchDriverId) return;
    await showFleetSection('dispatch', 'drivers');
    if (sameAdmin(selection) && !fleetDispatchApp.openPayProfile(selection.dispatchDriverId)) {
      showToast('Could not open the driver pay settings.');
    }
  });

  function name(profile) {
    return [profile.first_name, profile.last_name].filter(Boolean).join(' ') || 'Company Driver';
  }

  function amount(started, ended) {
    const minutes = Math.floor(Math.max(0, Date.parse(ended) - Date.parse(started)) / 60000);
    return Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm';
  }

  function shiftList(shifts) {
    const list = element('div', '', 'dispatch-load-list');
    if (!shifts.length) list.append(element('p', 'No shifts recorded.', 'muted'));
    for (const shift of shifts) {
      const bounds = clockFormat.format(new Date(shift.started_at)) + (shift.ended_at ? ' → ' + clockFormat.format(new Date(shift.ended_at)) : '');
      const row = element('article', '', 'dispatch-load-row');
      row.append(element('span', bounds), element('strong', shift.ended_at ? amount(shift.started_at, shift.ended_at) : 'Clocked in'));
      list.append(row);
    }
    return list;
  }

  async function openStatement(record) {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { showToast('Allow a new tab to open the statement.'); return; }
    tab.opener = null;
    try {
      const { data, error } = await supabaseClient.storage.from(payBucket).createSignedUrl(record.storage_key, 120);
      if (error || !data?.signedUrl) throw error || new Error();
      tab.location.replace(data.signedUrl);
    } catch {
      tab.close();
      showToast('Could not open this pay statement.');
    }
  }

  const settlementStatus = {
    awaiting_review: 'Awaiting driver review',
    correction_requested: 'Correction requested',
    accepted: 'Accepted · Ready for payroll',
    submitted: 'Submitted by payroll',
    replaced: 'Replaced by a corrected statement'
  };

  async function reviewStatement(record, decision, note, control) {
    const user = currentUser;
    control.disabled = true;
    try {
      await rpc('review_pay', null, null, {
        storage_key: record.storage_key, decision, review_note: note
      });
      if (currentUser !== user) return;
      activeReview = null;
      showToast(decision === 'accepted' ? 'Accepted. Payroll has been notified.' : 'Correction requested. Payroll has been notified.');
      await refreshPay(true);
    } catch (error) {
      if (currentUser === user) showToast(error.message || 'Could not record your review.');
    } finally { control.disabled = false; }
  }

  function correctionForm(record) {
    const form = element('form');
    const field = element('label', 'What needs to be corrected?', 'field');
    const note = element('textarea');
    note.required = true;
    note.maxLength = 1000;
    note.rows = 3;
    field.append(note);
    const submit = element('button', 'Send Correction Request', 'primary-btn');
    submit.type = 'submit';
    const cancel = button('Cancel', () => { form.hidden = true; });
    form.append(field, submit, cancel);
    form.hidden = true;
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (!note.value.trim()) { note.focus(); return; }
      void reviewStatement(record, 'correction_requested', note.value.trim(), submit);
    });
    return { form, note };
  }

  async function submitPay(record, control) {
    const selection = view;
    if (!selection) return;
    control.disabled = true;
    try {
      await rpc('submit_pay', selection.fleet, selection.profile.profile_id, { storage_key: record.storage_key });
      if (view !== selection || currentUser !== selection.user) return;
      showToast('Settlement submitted.');
      await Promise.all([loadAdmin(), refreshPayroll(true)]);
    } catch (error) {
      if (view === selection) showToast(error.message || 'Could not submit this settlement.');
    } finally { control.disabled = false; }
  }

  function selectCorrection(record) {
    const form = byId('companyDriverPayForm');
    replacementKey = record.storage_key;
    pendingUpload = null;
    form.reset();
    for (const name of ['title', 'period_start', 'period_end']) form.elements.namedItem(name).value = record[name];
    byId('companyPayFormTitle').textContent = 'Send corrected statement';
    byId('companyPayReplacementNote').textContent = 'Replacing ' + record.title;
    byId('companyPayCancelReplacement').classList.remove('hidden');
    form.elements.namedItem('file').focus();
  }

  function clearPayForm() {
    pendingUpload = null;
    replacementKey = null;
    byId('companyDriverPayForm').reset();
    byId('companyPayFormTitle').textContent = 'Send a statement for review';
    byId('companyPayReplacementNote').textContent = '';
    byId('companyPayCancelReplacement').classList.add('hidden');
  }

  function paintStatements(id, records, canManagePay = false) {
    const reviewing = id === 'driverPayList';
    const rows = records.map(record => {
      const row = element('article', '', 'dispatch-load-row company-pay-row');
      const summary = element('div');
      summary.append(element('strong', record.title), element('p',
        [record.fleet_id, record.period_start + ' to ' + record.period_end].filter(Boolean).join(' · '), 'muted'),
        element('p', settlementStatus[record.status], 'muted'));
      if (record.review_note) summary.append(element('p', 'Correction requested: ' + record.review_note));
      const actions = element('div', '', 'dispatch-actions');
      actions.append(button('Open Statement', () => openStatement(record)));
      row.append(summary, actions);
      if (reviewing && record.status === 'awaiting_review') {
        const correction = correctionForm(record);
        actions.append(button('Accept', control => reviewStatement(record, 'accepted', null, control)));
        actions.append(button('Request Correction', () => {
          activeReview = record.storage_key;
          correction.form.hidden = false;
          correction.note.focus();
        }));
        correction.form.addEventListener('click', event => {
          if (event.target.type === 'button' && correction.form.hidden) activeReview = null;
        });
        row.append(correction.form);
      }
      if (!reviewing && canManagePay && record.status === 'accepted') {
        actions.append(button('Submit Settlement', control => submitPay(record, control)));
      }
      if (!reviewing && canManagePay && record.status === 'correction_requested') {
        actions.append(button('Send Corrected Statement', () => selectCorrection(record)));
      }
      return row;
    });
    byId(id).replaceChildren(...(rows.length ? rows : [element('p', 'No pay settlements yet.', 'muted')]));
  }

  function updatePayBadges(user, records, seen) {
    const key = 'rigtracker-pay-seen:' + user.id;
    let viewedAt = viewedPayAt;
    try {
      viewedAt = Math.max(viewedAt, Number(localStorage.getItem(key)) || 0);
      if (seen && records.length) {
        viewedAt = Math.max(viewedAt, ...records.map(record => Date.parse(record.published_at)));
        viewedPayAt = viewedAt;
        localStorage.setItem(key, String(viewedAt));
      }
    } catch { /* The screen still works without access to this browser’s storage. */ }
    const count = records.filter(record => Date.parse(record.published_at) > viewedAt).length;
    if (typeof rigTrackerApp !== 'undefined') rigTrackerApp.badge('settlements', count, 'new settlements');
    byId('companyDriverDocumentsButton').textContent = count ? 'Documents (' + count + ')' : 'Documents';
    byId('companyDriverPayButton').textContent = count ? 'Pay (' + count + ')' : 'Pay';
  }

  async function refreshPay(showList = false) {
    const user = currentUser;
    if (!user || accountTypeFor(user) !== 'company' || (!showList && payRequest)) return;
    const request = {};
    payRequest = request;
    try {
      const records = await rpc('driver_pay');
      if (user !== currentUser || payRequest !== request) return;
      const viewing = byId('driverDocumentsPage').classList.contains('active') && !document.hidden;
      updatePayBadges(user, records, viewing);
      const signature = JSON.stringify(records);
      if (viewing && (showList || (!activeReview && signature !== paySignature))) {
        paintStatements('driverPayList', records);
        paySignature = signature;
        byId('driverPayStatus').textContent = '';
      }
    } catch (error) {
      if (showList && currentUser === user) byId('driverPayStatus').textContent = error.message || 'Could not load pay statements.';
    } finally { if (payRequest === request) payRequest = null; }
  }

  function openDocuments() {
    activeReview = null;
    showPage('driverDocumentsPage');
    byId('driverPayStatus').textContent = 'Loading pay statements…';
    return refreshPay(true);
  }

  async function clockAction(control, company, openShift) {
    const user = currentUser;
    control.disabled = true;
    try {
      await rpc(openShift ? 'clock_out' : 'clock_in', company.fleet_id);
      if (currentUser === user) showToast(openShift ? 'Clocked out.' : 'Clocked in.');
    } catch (error) {
      if (currentUser === user) showToast(error.message || 'Could not update the time clock.');
    } finally {
      control.disabled = false;
      if (currentUser === user) await refreshClock(true);
    }
  }

  async function refreshClock(showList = false) {
    const user = currentUser;
    if (!user || accountTypeFor(user) !== 'company' || (!showList && clockRequest)) return;
    const request = {};
    clockRequest = request;
    try {
      const companies = await rpc('clock_status');
      if (user !== currentUser || clockRequest !== request) return;
      const openShift = company => company.shifts.find(shift => !shift.ended_at);
      byId('companyDriverClockButton').classList.toggle('hidden', !companies.length);
      byId('companyDriverClockButton').textContent = companies.some(openShift) ? 'Time Clock · In' : 'Time Clock';
      if (!showList && !byId('companyDriverClockPage').classList.contains('active')) return;
      if (!showList && byId('companyDriverClockList').contains(document.activeElement)) return;
      byId('companyDriverClockStatus').textContent = companies.length ? '' : 'The time clock is off for your linked fleets.';
      byId('companyDriverClockList').replaceChildren(...companies.map(company => {
        const section = element('section', '', 'panel');
        const shift = openShift(company);
        section.append(element('h2', company.fleet_id), element('p',
          shift ? 'Clocked in since ' + clockFormat.format(new Date(shift.started_at)) : 'Clocked out', 'muted'));
        if (shift || company.enabled) section.append(button(shift ? 'Clock Out' : 'Clock In',
          control => clockAction(control, company, shift)));
        section.append(element('h3', 'Recent shifts'), shiftList(company.shifts));
        return section;
      }));
    } catch (error) {
      if (showList && currentUser === user) byId('companyDriverClockStatus').textContent = error.message || 'Could not load the time clock.';
    } finally { if (clockRequest === request) clockRequest = null; }
  }

  function openClock() {
    showPage('companyDriverClockPage');
    byId('companyDriverClockStatus').textContent = 'Loading time clock…';
    return refreshClock(true);
  }

  async function loadAdmin() {
    const selection = view;
    if (!selection) return;
    const request = {};
    adminRequest = request;
    try {
      const detail = await rpc('admin_detail', selection.fleet, selection.profile.profile_id);
      if (view !== selection || adminRequest !== request || currentUser !== selection.user) return;
      byId('companyDriverAdminContent').classList.remove('hidden');
      byId('companyDriverAdminStatus').textContent = '';
      adminSections.find(control => control.dataset.companyDriverSection === 'clock')
        .classList.toggle('hidden', !detail.can_manage_clock);
      const control = byId('companyDriverClockSwitch');
      control.classList.toggle('hidden', !detail.linked);
      control.setAttribute('aria-pressed', String(detail.enabled));
      control.textContent = detail.enabled ? 'Time Clock On · Turn Off' : 'Time Clock Off · Turn On';
      byId('companyDriverClockArchive').classList.toggle('hidden', detail.linked);
      byId('companyDriverAdminShifts').replaceChildren(shiftList(detail.shifts));
      byId('companyDriverPayForm').classList.toggle('hidden', !detail.can_manage_pay);
      paintStatements('companyDriverAdminPayList', detail.documents, detail.can_manage_pay);
    } catch (error) {
      if (view === selection && currentUser === selection.user) byId('companyDriverAdminStatus').textContent = error.message || 'Could not load the driver’s settings.';
    }
  }

  function openAdmin(profile, source = 'links', initialProfile) {
    const user = currentUser;
    const fleet = source === 'payroll' ? payroll?.fleet_id : adminFleetId;
    const owner = accountTypeFor(user) === 'fleet';
    if (!user || !fleet || (source !== 'payroll' && !owner)) return;
    view = { user, fleet, profile, source, owner };
    byId('companyDriverAdminTitle').textContent = name(profile);
    byId('companyDriverAdminStatus').textContent = 'Loading Company Driver records…';
    byId('companyDriverAdminContent').classList.add('hidden');
    byId('companyDriverAdminMessage').classList.add('hidden');
    byId('companyDriverAdminPaySettings').classList.add('hidden');
    byId('companyDriverAdminFacts').replaceChildren();
    byId('companyDriverHistoryList').replaceChildren();
    byId('companyDriverHistoryMore').classList.add('hidden');
    byId('companyDriverAdminPresence').textContent = '';
    byId('companyDriverAdminOverviewStatus').textContent = 'Loading driver profile…';
    for (const control of adminSections) control.classList.toggle('hidden', !owner && control.dataset.companyDriverSection !== 'documents');
    selectAdminSection(source === 'payroll' ? 'documents' : 'overview');
    clearPayForm();
    showPage('companyDriverAdminPage');
    void loadOverview(view, initialProfile);
    return loadAdmin();
  }

  byId('companyDriverClockSwitch').addEventListener('click', async event => {
    const control = event.currentTarget;
    const selection = view;
    if (!selection || control.disabled) return;
    const enabled = control.getAttribute('aria-pressed') !== 'true';
    control.disabled = true;
    try {
      await rpc('set_clock', selection.fleet, selection.profile.profile_id, { enabled });
      if (view === selection && currentUser === selection.user) {
        showToast(enabled ? 'Time Clock enabled for this driver.' : 'Time Clock disabled for this driver.');
        await loadAdmin();
      }
    } catch (error) {
      if (view === selection) showToast(error.message || 'Could not change the setting.');
    } finally { control.disabled = false; }
  });

  byId('companyPayCancelReplacement').addEventListener('click', clearPayForm);

  byId('companyDriverPayForm').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const control = form.querySelector('button[type="submit"]');
    const selection = view;
    if (!selection || control.disabled) return;
    const file = form.elements.namedItem('file').files[0];
    const { title, period_start, period_end } = Object.fromEntries(new FormData(form));
    const replacing = replacementKey;
    const extensions = { 'application/pdf': 'pdf', 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
    const extension = extensions[file?.type];
    if (!extension || !file.size || file.size > 10485760) { showToast('Choose a PDF or photo up to 10 MB.'); return; }
    if (!title.trim() || period_end < period_start) { showToast('Enter a title and a valid pay period.'); return; }
    control.disabled = true;
    try {
      if (pendingUpload?.file !== file) {
        const objectKey = selection.fleet + '/' + selection.profile.profile_id + '/' + crypto.randomUUID() + '.' + extension;
        const { error } = await supabaseClient.storage.from(payBucket).upload(objectKey, file, {contentType:file.type});
        if (error) throw error;
        if (view !== selection || currentUser !== selection.user) return;
        pendingUpload = { file, objectKey };
      }
      if (view !== selection || currentUser !== selection.user) return;
      await rpc('publish_pay', selection.fleet, selection.profile.profile_id,
        { title, period_start, period_end, storage_key:pendingUpload.objectKey, replaces_key: replacing });
      if (view === selection && currentUser === selection.user) {
        clearPayForm();
        showToast('Statement sent to the driver for review.');
        await Promise.all([loadAdmin(), refreshPayroll(true)]);
      }
    } catch (error) {
      if (view === selection && currentUser === selection.user) showToast(error.message || 'Could not send the pay statement for review.');
    } finally { control.disabled = false; }
  });

  async function loadFormer() {
    const user = currentUser;
    const fleet = adminFleetId;
    if (!fleet || !user) return;
    const list = byId('formerCompanyDriverList');
    list.replaceChildren(element('p', 'Loading former drivers…', 'muted'));
    try {
      const drivers = await rpc('former_drivers', fleet);
      if (user !== currentUser || fleet !== adminFleetId) return;
      list.replaceChildren(...(drivers.length ? drivers.map(driver => {
        const row = element('article', '', 'dispatch-load-row');
        row.append(element('span', name(driver)), button('View records', () => openAdmin(driver)));
        return row;
      }) : [element('p', 'No former Company Drivers.', 'muted')]));
    } catch (error) {
      if (user === currentUser && fleet === adminFleetId) list.textContent = error.message;
    }
  }

  byId('formerCompanyDrivers').addEventListener('toggle', event => { if (event.target.open) void loadFormer(); });

  function payrollBadges(notices, allowed) {
    const officePayroll = typeof officeTools === 'undefined' || officeTools.has('payroll');
    byId('companyOfficePayrollButton').classList.toggle('hidden', !allowed || !officePayroll);
    for (const id of ['companyFleetPayrollButton','companyOfficePayrollButton']) {
      byId(id).querySelector('.payroll-label').textContent = notices.length ? 'Payroll (' + notices.length + ')' : 'Payroll';
    }
  }

  async function refreshPayroll(force = false) {
    const user = currentUser;
    if (!user || !['fleet','employee'].includes(accountTypeFor(user)) || (!force && payrollRequest)) return;
    const request = {};
    payrollRequest = request;
    try {
      const data = await rpc('payroll_fleet');
      if (currentUser !== user || payrollRequest !== request) return;
      payroll = data;
      const notices = data?.notices ?? [];
      payrollBadges(notices, Boolean(data));
      if (knownNotices && notices.some(notice => !knownNotices.has(notice))) showToast('A driver responded to a pay settlement.');
      knownNotices = new Set(notices);
      if (byId('companyPayrollPage').classList.contains('active') && payrollSection === 'records') {
        if (!data) {
          byId('companyPayrollStatus').textContent = 'Payroll access is required.';
          return;
        }
        const queue = await rpc('payroll_queue', data.fleet_id);
        if (currentUser !== user || payrollRequest !== request || !byId('companyPayrollPage').classList.contains('active') || payrollSection !== 'records') return;
        paintPayroll(queue);
        byId('companyPayrollStatus').textContent = '';
      }
    } catch (error) {
      if (force && currentUser === user) byId('companyPayrollStatus').textContent = error.message || 'Could not load payroll.';
    } finally { if (payrollRequest === request) payrollRequest = null; }
  }

  function payScaleLabel(scale) {
    if (!scale) return 'Pay scale not set';
    const money = value => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(Number(value));
    const has = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));
    if (scale.method === 'per_load') return 'Per load · manual pay';
    if (scale.method === 'hourly') return 'Hourly · hours need review';
    if (scale.method === 'split') return has(scale.split_percent) ? Number(scale.split_percent) + '% split' : 'Split rate not set';
    if (scale.method === 'per_mile') return has(scale.mile_rate)
      ? money(scale.mile_rate) + ' per loaded mile' + (has(scale.empty_mile_rate) ? ' · ' + money(scale.empty_mile_rate) + ' per empty mile' : '')
      : 'Per-mile rate not set';
    if (scale.method === 'load_percent') return has(scale.split_percent) ? Number(scale.split_percent) + '% of load gross' : 'Load percentage not set';
    if (scale.method === 'higher_of') return has(scale.split_percent) && has(scale.mile_rate)
      ? 'Higher of ' + Number(scale.split_percent) + '% or ' + money(scale.mile_rate) + ' per loaded mile'
      : 'Higher-of pay scale is incomplete';
    return 'Pay scale not set';
  }
  function settlementLoadPay(load) {
    const money = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value));
    const rawTotal = load.pay_entry?.totalPay;
    const rawBase = load.pay_entry?.amount ?? load.manual_pay;
    const additional = Number(load.pay_entry?.additionalPay ?? load.additional_pay ?? 0) || 0;
    const scale = load.pay_scale || {};
    const emptyMiles = money(load.empty_miles) ? Number(load.empty_miles) : 0;
    const empty = money(load.pay_entry?.emptyPay) ? Number(load.pay_entry.emptyPay)
      : money(scale.empty_mile_rate) && money(load.empty_miles) ? emptyMiles * Number(scale.empty_mile_rate) : 0;
    const stop = Number(load.stop_pay ?? 0) || 0;
    let calculatedBase = null;
    const loadedMiles = Number(load.loaded_miles);
    const gross = Number(load.gross);
    const rate = Number(scale.mile_rate);
    const percentage = Number(scale.split_percent);
    const perMile = money(load.loaded_miles) && money(scale.mile_rate) ? loadedMiles * rate : null;
    const percent = money(load.gross) && money(scale.split_percent) ? gross * percentage / 100 : null;
    if (scale.method === 'per_mile') calculatedBase = perMile;
    else if (scale.method === 'load_percent') calculatedBase = percent;
    else if (scale.method === 'higher_of' && perMile !== null && percent !== null) calculatedBase = Math.max(perMile, percent);
    const baseKnown = money(rawTotal) || money(rawBase) || calculatedBase !== null;
    const base = money(rawTotal) ? Number(rawTotal)
      : money(rawBase) ? Number(rawBase) + empty + additional
      : calculatedBase !== null ? calculatedBase + empty + additional : additional;
    return { baseKnown, base, empty, additional, stop, total: base + stop };
  }
  async function createSettlementPreview() {
    const selected = [...byId('companyPayrollLoadSettlements').querySelectorAll('[data-settlement-load]:checked')]
      .map(input => payrollSettlementLoads.find(load => load.load_id === input.value)).filter(Boolean);
    const preview = byId('companyPayrollSettlementPreview');
    if (!selected.length) {
      preview.replaceChildren(element('p', 'Select at least one completed load.', 'muted'));
      preview.classList.remove('hidden');
      return;
    }
    const user = currentUser;
    const profileId = byId('companyPayrollDriver').value;
    const fleet = payroll?.fleet_id;
    const control = byId('companyPayrollCreateSettlement');
    control.disabled = true;
    preview.replaceChildren(element('p', 'Saving settlement draft…', 'muted'));
    preview.classList.remove('hidden');
    try {
      const { data: created, error } = await supabaseClient.rpc('create_company_driver_settlement', {
        target_fleet: fleet, target_profile: profileId, requested_load_ids: selected.map(load => load.load_id)
      });
      if (error) throw error;
      if (currentUser !== user || byId('companyPayrollDriver').value !== profileId) return;
      await loadSettlementLoads(fleet, profileId);
      const driver = byId('companyPayrollDriver').selectedOptions[0]?.textContent || 'Company Driver';
      const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
      const rows = selected.map(load => {
        const label = (load.is_return ? 'B-' : 'A-') + load.pro_number;
        const pay = settlementLoadPay(load);
        const row = element('div', '', 'settlement-preview-line');
        const miles = [load.loaded_miles != null ? Number(load.loaded_miles).toLocaleString() + ' loaded mi' : '',
          load.empty_miles != null ? Number(load.empty_miles).toLocaleString() + ' empty mi' : ''].filter(Boolean).join(' · ');
        row.append(element('strong', label), element('span', miles || 'Miles not recorded'),
          element('span', 'Pay scale: ' + payScaleLabel(load.pay_scale)));
        if (pay.baseKnown) row.append(element('span', 'Base / saved pay: ' + currency.format(pay.base - pay.additional - pay.empty)));
        else row.append(element('span', 'Base pay not entered · review needed', 'muted'));
        if (pay.empty) row.append(element('span', 'Empty-mile pay: ' + currency.format(pay.empty)));
        if (pay.stop) row.append(element('span', 'Stop pay: ' + currency.format(pay.stop)));
        if (pay.additional) row.append(element('span', 'Additional pay: ' + currency.format(pay.additional)));
        return row;
      });
      const missingBase = selected.some(load => !settlementLoadPay(load).baseKnown);
      preview.replaceChildren(
        element('h3', 'Settlement ' + created.settlement_number + ' · Draft saved'),
        element('p', driver + ' · ' + selected.length + ' completed load' + (selected.length === 1 ? '' : 's')),
        ...rows,
        element('strong', 'Known pay items: ' + currency.format(Number(created.total_pay)), 'settlement-preview-total'),
        ...(missingBase ? [element('p', 'Some loads have no base pay entered. The saved draft includes recorded stop and additional pay; review it before issuing.', 'muted')] : []),
        button('Print / Save as PDF', () => window.print())
      );
      preview.classList.remove('hidden');
      preview.scrollIntoView?.({ block: 'nearest' });
    } catch (error) {
      if (currentUser === user) preview.replaceChildren(element('p', error.message || 'Could not create this settlement.', 'muted'));
    } finally {
      if (currentUser === user) control.disabled = !payrollSettlementLoads.some(load => !load.created_settlement);
    }
  }
  async function loadSettlementLoads(fleet, profileId) {
    const list = byId('companyPayrollLoadSettlements');
    const request = {};
    payrollLoadRequest = request;
    const active = () => payrollLoadRequest === request && currentUser && byId('companyPayrollPage').classList.contains('active');
    payrollSettlementLoads = [];
    byId('companyPayrollSettlementPreview').classList.add('hidden');
    if (!profileId) {
      list.replaceChildren(element('p', 'Select a driver to view completed loads.', 'muted'));
      return;
    }
    list.replaceChildren(element('p', 'Loading completed loads…', 'muted'));
    try {
      const { data, error } = await supabaseClient.rpc('company_driver_load_settlements', {
        target_fleet: fleet, target_profile: profileId
      });
      if (error) throw error;
      if (!active()) return;
      payrollSettlementLoads = Array.isArray(data) ? data : [];
      const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
      list.replaceChildren(...(payrollSettlementLoads.length ? payrollSettlementLoads.map(load => {
        const row = element('article', '', 'dispatch-load-row company-pay-load-row');
        const summary = element('div');
        const label = (load.is_return ? 'B-' : 'A-') + load.pro_number;
        const place = stop => [stop?.city, stop?.state].filter(Boolean).join(', ') || stop?.company || '';
        const route = [place(load.pickup), place(load.receiver)].filter(Boolean).join(' → ');
        summary.append(element('strong', label + (load.route_number ? ' · Route ' + load.route_number : '')));
        if (route) summary.append(element('p', route));
        if (load.updated_at) summary.append(element('p', 'Completed ' + clockFormat.format(new Date(load.updated_at)), 'muted'));
        const miles = [load.loaded_miles != null ? Number(load.loaded_miles).toLocaleString() + ' loaded mi' : '',
          load.empty_miles != null ? Number(load.empty_miles).toLocaleString() + ' empty mi' : ''].filter(Boolean).join(' · ');
        summary.append(element('p', 'Miles: ' + (miles || 'Not recorded')));
        summary.append(element('p', 'Profile pay scale: ' + payScaleLabel(load.pay_scale)));
        const pay = settlementLoadPay(load);
        if (pay.baseKnown) summary.append(element('p', 'Base / saved pay: ' + currency.format(pay.base - pay.additional - pay.empty)));
        else summary.append(element('p', 'Base pay not entered', 'muted'));
        if (pay.stop) summary.append(element('p', 'Stop pay: ' + currency.format(pay.stop)));
        if (pay.additional) summary.append(element('p', 'Additional pay: ' + currency.format(pay.additional)));
        const choose = element('label', '', 'settlement-load-include');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = load.load_id;
        checkbox.dataset.settlementLoad = 'true';
        checkbox.disabled = Boolean(load.created_settlement);
        choose.append(checkbox, element('span', load.created_settlement
          ? 'Draft ' + load.created_settlement.number
          : 'Include'));
        if (load.created_settlement) {
          summary.append(element('p', 'Saved in draft ' + load.created_settlement.number +
            ' · ' + currency.format(Number(load.created_settlement.line_total || 0)), 'muted'));
        }
        row.append(summary, choose);
        return row;
      }) : [element('p', 'No completed loads are assigned to this driver.', 'muted')]));
      byId('companyPayrollCreateSettlement').disabled = !payrollSettlementLoads.some(load => !load.created_settlement);
    } catch (error) {
      if (active()) list.replaceChildren(element('p', error.message || 'Could not load completed loads.', 'muted'));
    }
  }
  function paintPayroll(queue) {
    const picker = byId('companyPayrollDriver');
    const selected = picker.value;
    picker.replaceChildren(new Option('Select a Company Driver', ''), ...queue.drivers.map(driver => new Option(name(driver), driver.profile_id)));
    if (queue.drivers.some(driver => driver.profile_id === selected)) picker.value = selected;
    picker.onchange = () => void loadSettlementLoads(payroll?.fleet_id, picker.value);
    byId('companyPayrollCreateSettlement').disabled = true;
    byId('companyPayrollCreateSettlement').onclick = createSettlementPreview;
    byId('companyPayrollOpenDriver').onclick = () => {
      const driver = queue.drivers.find(driver => driver.profile_id === picker.value);
      if (driver) openAdmin(driver, 'payroll');
    };
    byId('companyPayrollQueue').replaceChildren(...(queue.records.length ? queue.records.map(record => {
      const row = element('article', '', 'dispatch-load-row');
      const summary = element('div');
      summary.append(element('strong', name(record) + ' · ' + record.title),
        element('p', settlementStatus[record.status], 'muted'));
      if (record.review_note) summary.append(element('p', record.review_note));
      row.append(summary, button('Open Review', () => openAdmin(record, 'payroll')));
      return row;
    }) : [element('p', 'No settlements are awaiting review or submission.', 'muted')]));
    void loadSettlementLoads(payroll?.fleet_id, picker.value);
  }

  function fuelSettingsFleet() {
    return accountTypeFor(currentUser) === 'fleet' ? adminFleetId : officeTools.fuelSettingsFleet();
  }

  function canReadSettlements() {
    return accountTypeFor(currentUser) === 'fleet' || officeTools.has('payroll') || officeTools.has('settlements');
  }

  function thisMonday() {
    const now = new Date();
    const day = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
    return day.toISOString().slice(0, 10);
  }

  const fuelForm = byId('dispatchFuelForm');
  const fuelWeek = fuelForm.elements.week;
  const fuelRate = fuelForm.elements.rate;
  const fuelStatus = byId('dispatchFuelStatus');
  const fuelSave = fuelForm.querySelector('button[type=submit]');
  const fuelTable = 'fleet_dispatch_fuel_rates';

  async function readFuelRate() {
    const fleet = fuelSettingsFleet();
    const user = currentUser;
    if (!fleet) return;
    const request = {};
    fuelRequest = request;
    fuelWeek.value ||= thisMonday();
    fuelRate.value = '';
    fuelRate.disabled = true;
    fuelSave.disabled = true;
    if (!fuelWeek.validity.valid) {
      fuelStatus.textContent = 'Choose a Monday to set the rate for that week.';
      return;
    }
    fuelStatus.textContent = 'Loading weekly rate…';
    const active = () => currentUser === user && fuelRequest === request && fleet === fuelSettingsFleet();
    try {
      const { data, error } = await supabaseClient.from(fuelTable).select('cents_per_mile')
        .eq('fleet_id', fleet).eq('week_start', fuelWeek.value).maybeSingle();
      if (error) throw error;
      if (!active()) return;
      fuelRate.value = data?.cents_per_mile ?? '';
      fuelStatus.textContent = data ? 'This week’s rate is saved.' : 'No rate set for this week.';
      fuelRate.disabled = false;
      fuelSave.disabled = false;
    } catch {
      if (active()) fuelStatus.textContent = 'Could not load the weekly fuel surcharge. Reopen Manage to retry.';
    }
  }

  fuelWeek.addEventListener('change', readFuelRate);
  fuelForm.addEventListener('submit', async event => {
    event.preventDefault();
    const fleet = fuelSettingsFleet();
    const user = currentUser;
    if (!fleet || fuelSave.disabled || payrollSection !== 'manage') return;
    const request = fuelRequest;
    const values = { fleet_id: fleet, week_start: fuelWeek.value, cents_per_mile: fuelRate.value };
    fuelSave.disabled = fuelWeek.disabled = fuelRate.disabled = true;
    try {
      const { error } = await supabaseClient.from(fuelTable).upsert(values, { onConflict: 'fleet_id,week_start' });
      if (error) throw error;
      if (currentUser === user && fuelRequest === request) {
        fuelStatus.textContent = 'Weekly fuel surcharge saved.';
        fleetDispatchApp.refreshPayPreview();
      }
    } catch {
      if (currentUser === user && fuelRequest === request) fuelStatus.textContent = 'Could not save the weekly fuel surcharge.';
    } finally {
      if (currentUser === user && fuelRequest === request) fuelSave.disabled = fuelWeek.disabled = fuelRate.disabled = false;
    }
  });

  function selectPayrollSection(section) {
    const canManage = Boolean(fuelSettingsFleet());
    const canRead = canReadSettlements();
    const manage = canManage && (section === 'manage' || !canRead);
    payrollSection = manage ? 'manage' : 'records';
    const listTab = byId('companyPayrollListTab');
    const manageTab = byId('companyPayrollManageTab');
    listTab.classList.toggle('hidden', !canRead);
    manageTab.classList.toggle('hidden', !canManage);
    listTab.setAttribute('aria-pressed', String(!manage));
    manageTab.setAttribute('aria-pressed', String(manage));
    byId('companyPayrollRecords').classList.toggle('hidden', manage);
    byId('companyPayrollManage').classList.toggle('hidden', !manage);
    if (manage) {
      fuelWeek.disabled = false;
      return readFuelRate();
    }
    fuelRequest = null;
    byId('companyPayrollStatus').textContent = 'Loading payroll…';
    return refreshPayroll(true);
  }

  byId('companyPayrollListTab').addEventListener('click', () => selectPayrollSection('records'));
  byId('companyPayrollManageTab').addEventListener('click', () => selectPayrollSection('manage'));

  function openPayroll(title = 'Payroll') {
    const page = document.querySelector('.page.active');
    if (!currentUser) return;
    if (page && !['companyPayrollPage','companyDriverAdminPage'].includes(page.id)) payrollOrigin = page.id;
    byId('companyPayrollTitle').textContent = title;
    showPage('companyPayrollPage');
    fuelForm.reset();
    return selectPayrollSection('records');
  }

  function backPayroll() {
    if (accountTypeFor(currentUser) === 'employee') return officeTools.openDashboard();
    if (payrollOrigin && payrollOrigin !== 'fleetWorkspace') return showPage(payrollOrigin);
    return showFleetSection('dashboard');
  }

  function backAdmin() {
    if (view?.source === 'payroll') return openPayroll(byId('companyPayrollTitle').textContent);
    if (view?.source === 'dispatch') return showFleetSection('dispatch', 'drivers');
    return showFleetSection('links');
  }

  function refresh() {
    if (!currentUser) return;
    if (accountTypeFor(currentUser) === 'company') {
      void recordPresence();
      void refreshClock();
      void refreshPay();
      return;
    }
    void refreshAdminPresence();
    void refreshPayroll();
  }

  function reset() {
    view = null; payroll = null; payrollOrigin = null; payrollRequest = null;
    fuelRequest = null; payrollSection = null;
    fuelForm.reset();
    fuelStatus.textContent = '';
    rosterRequest = null; nextPresenceUpdate = 0;
    knownNotices = null; paySignature = null; activeReview = null; viewedPayAt = 0;
    clearPayForm();
    payrollBadges([], false);
    byId('companyPayrollQueue').replaceChildren();
    byId('companyPayrollLoadSettlements').replaceChildren();
    byId('companyPayrollSettlementPreview').replaceChildren();
    byId('companyPayrollSettlementPreview').classList.add('hidden');
    byId('companyPayrollCreateSettlement').disabled = true;
    payrollSettlementLoads = [];
    byId('companyPayrollDriver').replaceChildren();
    byId('companyPayrollOpenDriver').onclick = null;
    adminRequest = null; clockRequest = null; payRequest = null;
    byId('formerCompanyDrivers').open = false;
    for (const id of ['driverPayList','companyDriverClockList','companyDriverAdminShifts','companyDriverAdminPayList',
      'formerCompanyDriverList','companyDriverAdminFacts','companyDriverHistoryList','companyDriverAdminPresence']) byId(id).replaceChildren();
    byId('companyDriverClockButton').classList.add('hidden');
    byId('companyDriverPayButton').textContent = 'Pay';
    byId('companyDriverDocumentsButton').textContent = 'Documents';
  }

  setInterval(() => { if (!document.hidden) refresh(); },24000);
  return { openDocuments, openClock, openAdmin, openRoster, openPayroll, backPayroll, backAdmin, loadFormer, refresh, reset };
})();
