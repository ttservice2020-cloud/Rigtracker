const companyDriverTools = (() => {
  const byId = id => document.getElementById(id);
  const payBucket = 'company-driver-pay';
  const adminSections = [...document.querySelectorAll('[data-company-driver-section]')];
  const equipmentEditor = byId('companyDriverEquipmentEditor');
  const equipmentEdit = byId('companyDriverEquipmentEdit');
  const equipmentForm = byId('companyDriverEquipmentForm');
  const equipmentSave = equipmentForm.querySelector('button[type=submit]');
  const equipmentCancel = byId('companyDriverEquipmentCancel');
  const trailerType = equipmentForm.elements.trailer_type;
  const trailerNumber = equipmentForm.elements.trailer_number;
  const bobtailInput = equipmentForm.elements.bobtail;
  const trailerTypeChoices = byId('companyDriverTrailerTypeChoices');
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
  let settlementView;
  let settlementPreviewRequest;
  let savedSettlementsRequest;
  let ownDocumentsRequest;
  let payrollQueueSignature;
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

  const profilePayCurrency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
  const profileFileBucket = 'fleet-driver-profile-files';
  const fileTabs = { documents: 'documents', company: 'company', tax: 'tax' };
  const sectionPermission = section => 'driver_' + (section === 'company' ? 'company_file' : section);
  const fileExtensions = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  function profileFields(selection) {
    return selection.profile.profile_id ? { profile_number: selection.profile.profile_id }
      : { roster_driver: selection.dispatchDriverId };
  }

  function selectAdminSection(section) {
    if (!view) return;
    const requested = adminSections.find(control => control.dataset.companyDriverSection === section && !control.classList.contains('hidden'));
    const selected = requested || adminSections.find(control => !control.classList.contains('hidden'));
    for (const control of adminSections) {
      control.setAttribute('aria-pressed', String(control === selected));
      byId(control.getAttribute('aria-controls')).classList.toggle('hidden', control !== selected);
    }
    const active = selected?.dataset.companyDriverSection;
    if (['history','bols'].includes(active) && !view.pages[active]) void loadHistory(view, active);
    if (fileTabs[active] && !view.files.has(active)) void loadProfileFiles(view, active);
    if (['pay_status','pay_settlements'].includes(active)) void loadProfilePay(view, active);
    if (['mileage','concerns','pay_scale'].includes(active)) void loadDriverTracking(view, active);
  }

  function quickFact(label, value, href) {
    const cell = element('div');
    const detail = element('dd', href ? '' : value || '—');
    if (href) {
      const link = element('a', value);
      link.href = href;
      detail.append(link);
    }
    cell.append(element('dt', label), detail);
    return cell;
  }

  async function loadDriverTracking(selection, section) {
    const host = document.querySelector('[data-driver-tracking="' + section + '"]');
    if (selection.pending.has(section)) return;
    if (!selection.dispatchDriverId) {
      host.replaceChildren(element('p', 'No records for this driver.', 'muted'));
      return;
    }
    selection.pending.add(section);
    host.textContent = 'Loading…';
    try {
      const response = section === 'concerns'
        ? await supabaseClient.from('office_review_issues').select('title,description,created_at')
          .eq('fleet_id', selection.fleet).eq('driver_id', selection.dispatchDriverId)
          .order('created_at', { ascending: false }).limit(50)
        : await supabaseClient.rpc('fleet_driver_tracking', {
          target_fleet: selection.fleet, target_driver: selection.dispatchDriverId, section
        });
      if (response.error) throw response.error;
      if (!sameAdmin(selection)) return;
      const data = response.data;
      if (section === 'pay_scale') {
        host.replaceChildren(element('p', payScaleLabel(data)));
      } else if (section === 'concerns') {
        const concerns = data.map(issue => {
          const card = element('article', '', 'dispatch-load-card');
          card.append(element('h3', issue.title), element('p', issue.description),
            element('p', clockFormat.format(new Date(issue.created_at)), 'muted'));
          return card;
        });
        host.replaceChildren(...(concerns.length ? concerns : [element('p', 'No concerns to show.', 'muted')]));
      } else {
        const miles = value => value == null ? '—' : Number(value).toLocaleString() + ' mi';
        const totals = element('dl', '', 'dispatch-detail-facts');
        totals.append(quickFact('Loaded miles', miles(data.loaded)), quickFact('Empty miles', miles(data.empty)),
          quickFact('Percent loaded', data.percent == null ? '—' : data.percent + '%'));
        const history = element('div', '', 'dispatch-load-list');
        for (const reading of data.recent) {
          const card = element('article', '', 'dispatch-load-card');
          const facts = element('dl', '', 'dispatch-detail-facts');
          facts.append(quickFact('Truck', reading.truck_number), quickFact('Starting odometer', miles(reading.start_odometer)),
            quickFact('Ending odometer', miles(reading.end_odometer)), quickFact('Loaded miles', miles(reading.loaded)),
            quickFact('Empty before this load', miles(reading.empty)));
          card.append(element('h3', 'PRO ' + reading.pro), facts);
          history.append(card);
        }
        host.replaceChildren(totals, history);
        if (!data.recent.length) history.append(element('p', 'No odometer readings recorded.', 'muted'));
      }
    } catch (error) {
      if (sameAdmin(selection)) host.textContent = error.message || 'Could not load this section.';
    } finally {
      selection.pending.delete(section);
    }
  }

  function equipmentFact(label, number, id) {
    const fact = quickFact(label, number);
    if (!id) return fact;
    const link = button(number, () => openProfileEquipment(id));
    link.className = 'company-driver-equipment-link';
    link.setAttribute('aria-label', 'Open ' + label.toLowerCase() + ' ' + number + ' equipment profile');
    fact.querySelector('dd').replaceChildren(link);
    return fact;
  }

  async function openProfileEquipment(id) {
    const selection = view;
    if (!selection) return;
    try {
      if (selection.owner) await showFleetSection('dispatch', 'equipment');
      else await showOfficeDispatch('equipment');
      if (!sameAdmin(selection)) return;
      await fleetEquipment.openRecord(selection.fleet, id, () => {
        if (sameAdmin(selection)) return openAdmin(selection.profile, selection.source, undefined, selection.fleet);
      });
    } catch (error) {
      if (sameAdmin(selection)) showToast(error.message || 'Could not open the equipment profile.');
    }
  }

  function paintQuickReference(profile) {
    const type = { company: 'Company Driver', owner_op: 'Owner Op' }[profile.driver_type];
    const phoneNumber = profile.phone?.replace(/[^+\d]/g, '');
    const trailer = equipmentFact('Trailer', profile.trailer, profile.trailer_equipment_id);
    const typeLabel = { fleet: 'Fleet', power_only: 'Power Only' }[profile.trailer_type];
    if (typeLabel) {
      const detail = trailer.querySelector('dd');
      if (!detail.childElementCount) detail.replaceChildren(element('span', profile.trailer));
      detail.append(element('small', typeLabel, 'muted company-driver-trailer-type'));
    }
    byId('companyDriverAdminFacts').replaceChildren(
      quickFact('Name', name(profile)), quickFact('Phone', profile.phone, phoneNumber ? 'tel:' + phoneNumber : null),
      quickFact('Email', profile.email, profile.email ? 'mailto:' + profile.email : null),
      quickFact('Driver type', type), quickFact('DL number', profile.license_number),
      equipmentFact('Truck', profile.truck, profile.truck_equipment_id), trailer
    );
    equipmentEditor.classList.toggle('hidden', !profile.can_edit_equipment);
  }

  function showEquipmentError(message = '') {
    const feedback = byId('companyDriverEquipmentError');
    feedback.textContent = message;
    feedback.classList.toggle('hidden', !message);
  }

  function fillEquipmentForm(profile) {
    for (const [field, value] of [['truck_number', 'truck'], ['trailer_number', 'trailer']]) {
      const input = equipmentForm.elements.namedItem(field);
      const assignment = profile['assigned_' + field];
      input.value = assignment || '';
      input.placeholder = !assignment && profile[value] ? 'Current load · ' + profile[value] : '';
    }
    const assignment = profile.assigned_trailer_number;
    bobtailInput.checked = assignment?.toLowerCase() === 'bobtail';
    const type = assignment && !bobtailInput.checked ? profile.trailer_type : null;
    for (const option of trailerType) option.checked = option.value === type;
    if (bobtailInput.checked) trailerNumber.value = '';
    paintTrailerInputs();
  }

  function paintTrailerInputs() {
    trailerNumber.disabled = trailerTypeChoices.disabled = bobtailInput.checked;
  }

  function closeEquipmentForm(restoreFocus = true) {
    equipmentForm.classList.add('hidden');
    equipmentEdit.setAttribute('aria-expanded', 'false');
    showEquipmentError();
    if (restoreFocus) equipmentEdit.focus();
  }

  equipmentEdit.addEventListener('click', () => {
    if (!view?.profile.can_edit_equipment || equipmentSave.disabled) return;
    if (!equipmentForm.classList.contains('hidden')) {
      closeEquipmentForm();
      return;
    }
    fillEquipmentForm(view.profile);
    equipmentForm.classList.remove('hidden');
    equipmentEdit.setAttribute('aria-expanded', 'true');
    byId('companyDriverTruckNumber').focus();
  });
  equipmentCancel.addEventListener('click', () => closeEquipmentForm());
  equipmentForm.addEventListener('change', event => {
    if (!['bobtail', 'trailer_type'].includes(event.target.name)) return;
    paintTrailerInputs();
    showEquipmentError();
  });
  byId('companyDriverEquipmentSearch').addEventListener('click', () => {
    const selection = view;
    if (!selection?.profile.can_edit_equipment || equipmentSave.disabled) return;
    void fleetEquipment.openPicker(selection.fleet, unit => {
      if (!sameAdmin(selection)) return;
      equipmentForm.elements.namedItem(unit.equipment_type + '_number').value = unit.unit_number;
      if (unit.equipment_type === 'trailer') {
        trailerType.value = 'fleet';
        bobtailInput.checked = false;
        paintTrailerInputs();
      }
      showEquipmentError();
    });
  });

  equipmentForm.addEventListener('submit', async event => {
    event.preventDefault();
    const selection = view;
    if (!selection?.profile.can_edit_equipment || !selection.dispatchDriverId || equipmentSave.disabled) return;
    const { truck_number, trailer_number = '', trailer_type, bobtail } = Object.fromEntries(new FormData(equipmentForm));
    if (trailer_number.trim() && trailer_number.trim().toLowerCase() !== 'bobtail' && !trailer_type) {
      showEquipmentError('Choose Fleet or Power Only for this trailer.');
      trailerType[0].focus();
      return;
    }
    const { assigned_truck_number, assigned_trailer_number, assigned_trailer_type } = selection.profile;
    equipmentSave.disabled = equipmentCancel.disabled = true;
    showEquipmentError();
    try {
      const { data: profile, error } = await supabaseClient.rpc('set_dispatch_driver_equipment', {
        target_fleet: selection.fleet, target_driver: selection.dispatchDriverId,
        truck_number, trailer_number: bobtail ? 'Bobtail' : trailer_number, trailer_type: trailer_type ?? null,
        expected_truck: assigned_truck_number ?? null, expected_trailer: assigned_trailer_number ?? null,
        expected_trailer_type: assigned_trailer_type ?? null
      });
      if (error) throw error;
      if (!sameAdmin(selection)) return;
      selection.profile = profile;
      paintQuickReference(profile);
      closeEquipmentForm();
      showToast('Truck and trailer saved.');
    } catch (error) {
      if (sameAdmin(selection)) showEquipmentError(error.message || 'Could not save the truck and trailer.');
    } finally {
      if (sameAdmin(selection)) equipmentSave.disabled = equipmentCancel.disabled = false;
    }
  });

  function paintPresence(presence) {
    const lastSeen = presence.last_seen_at && clockFormat.format(new Date(presence.last_seen_at));
    byId('companyDriverAdminPresence').textContent = presence.online ? 'Online now'
      : lastSeen ? 'Offline · Last active ' + lastSeen : 'No online activity recorded.';
  }

  async function loadOverview(selection, initialProfile) {
    const status = byId('companyDriverAdminOverviewStatus');
    try {
      const profile = initialProfile ?? await profileRequest('overview', selection.fleet, profileFields(selection));
      if (!sameAdmin(selection)) return;
      selection.profile = profile;
      selection.linked = profile.linked;
      selection.dispatchDriverId = profile.dispatch_driver_id;
      byId('companyDriverAdminTitle').textContent = 'Driver Profile';
      byId('companyDriverReviewIssue').classList.toggle('hidden', selection.owner || !selection.dispatchDriverId);
      const canMessage = profile.company_driver && profile.linked;
      byId('companyDriverAdminMessage').classList.toggle('hidden', !canMessage);
      byId('companyDriverAdminMessagingStatus').textContent = canMessage ? '' : 'Conversations are available for linked Company Driver accounts.';
      byId('companyDriverAdminPaySettings').classList.toggle('hidden', !selection.owner || !selection.dispatchDriverId);
      const availability = { assigned: 'On a load', available: 'Available', 'off-duty': 'Off duty' };
      paintQuickReference(profile);
      byId('companyDriverCompanyFacts').replaceChildren(
        quickFact('RigTracker ID', profile.display_profile_id), quickFact('Employee number', profile.employee_number),
        quickFact('Fleet status', profile.linked ? 'Active' : profile.profile_id ? 'Former driver' : 'Roster only'),
        quickFact('Equipment', profile.equipment), quickFact('Dispatch availability', availability[profile.availability])
      );
      if (profile.linked) paintPresence(profile.presence || {});
      const allowed = new Set(profile.tabs || []);
      for (const control of adminSections) control.classList.toggle('hidden', !allowed.has(sectionPermission(control.dataset.companyDriverSection)));
      byId('companyDriverAdminSummary').classList.remove('hidden');
      byId('companyDriverAdminContent').classList.remove('hidden');
      byId('companyDriverAdminStatus').textContent = [...allowed].some(tab => tab !== 'driver_concerns')
        ? '' : 'Ask your Fleet Admin for access to additional driver profile tabs.';
      status.textContent = '';
      selectAdminSection(selection.source === 'payroll' ? 'pay_settlements' : 'company');
      if (profile.company_driver && profile.profile_id && (selection.owner ||
        (selection.source === 'payroll' && allowed.has('driver_pay_settlements')))) await loadAdmin();
    } catch (error) {
      if (sameAdmin(selection)) byId('companyDriverAdminStatus').textContent = error.message || 'Could not load this driver profile.';
    }
  }

  async function openRoster(driver, fleet, fromEquipment = false) {
    const user = currentUser;
    const role = accountTypeFor(user);
    if (!fleet || !['fleet','employee'].includes(role)) return;
    const request = {};
    rosterRequest = request;
    const source = fromEquipment ? 'equipment' : 'drivers';
    const current = () => rosterRequest === request && user === currentUser &&
      byId('fleetWorkspace').classList.contains('active') && !byId('dispatch-panel-' + source).classList.contains('hidden');
    try {
      const profile = await profileRequest('overview', fleet, { roster_driver: driver.id });
      if (!current()) return;
      const open = openAdmin(profile, fromEquipment ? 'equipment' : 'dispatch', profile, fleet);
      if (fromEquipment && profile.can_edit_equipment) equipmentEdit.click();
      return open;
    } catch (error) {
      if (current()) showToast(error.message || 'Could not open the driver profile.');
    } finally { if (rosterRequest === request) rosterRequest = null; }
  }

  function historyRow(load, selection, section) {
    const row = element('article', '', 'dispatch-load-row');
    const summary = element('div');
    const pro = (load.return_load ? 'B-' : 'A-') + load.pro_number;
    summary.append(element('strong', pro));
    const route = [load.origin, load.destination].filter(Boolean).join(' → ');
    if (route) summary.append(element('p', route));
    const completed = Date.parse(load.completed_at);
    if (Number.isFinite(completed)) summary.append(element('p', 'Completed ' + clockFormat.format(completed)));
    const actions = element('div', '', 'dispatch-actions');
    if (section === 'history' && (selection.owner || officeTools.has('dispatch'))) {
      actions.append(button('Open Load', async () => {
        if (selection.owner) await showFleetSection('dispatch', 'history');
        else await showOfficeDispatch('history');
        if (fleetSection === 'dispatch' && byId('fleetWorkspace').classList.contains('active')) {
          await fleetDispatchApp.openRecord(load.load_id);
        }
      }));
    }
    const groups = new Map();
    for (const file of load.paperwork) {
      if (!groups.has(file.stop)) groups.set(file.stop, { ...file, paths: [] });
      groups.get(file.stop).paths.push(file.path);
    }
    for (const file of groups.values()) {
      const label = file.kind === 'delivery' ? 'Proof of Delivery' : 'BOL';
      const caption = [label, file.company].filter(Boolean).join(' · ');
      actions.append(button('View ' + caption, () => driverLoadWorkflow.openDocument(file.paths, pro + ' · ' + caption)));
    }
    row.append(summary, actions);
    return row;
  }

  async function loadHistory(selection, section, more = false) {
    if (selection.pending.has(section)) return;
    const prefix = section === 'bols' ? 'companyDriverBols' : 'companyDriverHistory';
    const control = byId(prefix + 'More');
    const status = byId(prefix + 'Status');
    const cursor = more ? selection.pages[section]?.cursor : null;
    selection.pending.add(section);
    control.disabled = true;
    status.textContent = 'Loading…';
    try {
      const page = await profileRequest(section, selection.fleet, { ...profileFields(selection),
        ...(cursor ? { before_time: cursor.updated_at, before_load: cursor.load_id } : {}) });
      if (!sameAdmin(selection)) return;
      const rows = page.slice(0, historyPageSize);
      byId(prefix + 'List').append(...rows.map(load => historyRow(load, selection, section)));
      selection.pages[section] = { cursor: rows.at(-1) };
      control.classList.toggle('hidden', page.length <= historyPageSize);
      status.textContent = rows.length || more ? '' : section === 'bols' ? 'No bills of lading or delivery paperwork.' : 'No completed loads for this driver.';
    } catch (error) {
      if (sameAdmin(selection)) status.textContent = error.message || 'Could not load these records. Select the tab to retry.';
    } finally {
      selection.pending.delete(section);
      if (sameAdmin(selection)) control.disabled = false;
    }
  }

  async function openProfileFile(path) {
    try {
      const { data, error } = await supabaseClient.storage.from(profileFileBucket).createSignedUrl(path, 90);
      if (error) throw error;
      const link = document.createElement('a');
      link.href = data.signedUrl;
      link.target = '_blank';
      link.rel = 'noopener';
      link.click();
    } catch (error) { showToast(error.message || 'Could not open the file.'); }
  }

  async function loadProfileFiles(selection, section) {
    if (selection.pending.has(section)) return;
    const container = document.querySelector('[data-driver-profile-files="' + fileTabs[section] + '"]');
    if (!selection.dispatchDriverId) {
      container.replaceChildren(element('p', 'No driver roster entry is linked.', 'muted'));
      return;
    }
    const folder = [selection.fleet, selection.dispatchDriverId, fileTabs[section]].join('/');
    const bucket = supabaseClient.storage.from(profileFileBucket);
    selection.pending.add(section);
    container.replaceChildren(element('p', 'Loading files…', 'muted'));
    try {
      const { data, error } = await bucket.list(folder, { limit:100, sortBy:{ column:'created_at', order:'desc' } });
      if (error) throw error;
      if (!sameAdmin(selection)) return;
      const files = data.filter(file => file.id);
      container.replaceChildren(...files.map(file => {
        const row = element('article', '', 'dispatch-load-row');
        const label = file.name.replace(/^[0-9a-f-]{36}-/i, '');
        row.append(element('strong', label), button('Open', () => openProfileFile(folder + '/' + file.name)));
        return row;
      }));
      if (!files.length) container.append(element('p', 'No files on record.', 'muted'));
      if (selection.owner) {
        const fileInput = element('input');
        fileInput.type = 'file';
        fileInput.accept = Object.keys(fileExtensions).join(',');
        fileInput.className = 'hidden';
        const upload = button('Upload File', () => fileInput.click());
        fileInput.addEventListener('change', async () => {
          const file = fileInput.files[0];
          const extension = fileExtensions[file?.type];
          if (!extension || !file.size || file.size > 10485760) {
            showToast('Choose a PDF or image up to 10 MB.');
            fileInput.value = '';
            return;
          }
          upload.disabled = true;
          try {
            const name = file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9 ._-]/gi, '_').slice(0, 100) || 'Document';
            const { error } = await bucket.upload(folder + '/' + crypto.randomUUID() + '-' + name + '.' + extension, file);
            if (error) throw error;
            if (sameAdmin(selection)) { showToast('File uploaded.'); await loadProfileFiles(selection, section); }
          } catch (error) {
            if (sameAdmin(selection)) showToast(error.message || 'Could not upload this file.');
          } finally { upload.disabled = false; fileInput.value = ''; }
        });
        container.append(upload, fileInput);
      }
      selection.files.add(section);
    } catch (error) {
      if (sameAdmin(selection)) container.replaceChildren(element('p', error.message || 'Could not load these files.', 'muted'));
    } finally { selection.pending.delete(section); }
  }

  async function loadProfilePay(selection, section) {
    if (selection.pending.has(section)) return;
    selection.pending.add(section);
    const summary = byId(section === 'pay_status' ? 'companyDriverPayStatusRows' : 'companyDriverDraftSettlements');
    summary.replaceChildren(element('p', 'Loading pay records…', 'muted'));
    try {
      const result = await profileRequest(section, selection.fleet, profileFields(selection));
      if (!sameAdmin(selection)) return;
      const isStatus = section === 'pay_status';
      const drafts = result.settlements.map(record => element('p',
        record.settlement_number + ' · Draft' + (isStatus ? '' : ' · ' + profilePayCurrency.format(Number(record.total_pay)))));
      if (!isStatus && !(selection.profile.company_driver && (selection.owner || selection.source === 'payroll'))) paintStatements('companyDriverAdminPayList', result.statements);
      const states = !isStatus ? [] : result.statements.map(record => element('p',
        record.title + ' · ' + settlementStatus[record.status] + (record.submitted_at ? ' · ' + clockFormat.format(new Date(record.submitted_at)) : '')));
      summary.replaceChildren(...drafts, ...states);
      if (!drafts.length && !states.length && (isStatus || !result.statements.length)) summary.append(element('p', 'No pay records on file.', 'muted'));
    } catch (error) {
      if (sameAdmin(selection)) summary.replaceChildren(element('p', error.message || 'Could not load these pay records.', 'muted'));
    } finally { selection.pending.delete(section); }
  }

  async function refreshAdminPresence() {
    const selection = view;
    if (!selection?.linked || !selection.profile.tabs?.includes('driver_company_file') || selection.presencePending || !byId('companyDriverAdminPage').classList.contains('active')) return;
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
    if (view?.pages.history?.cursor) void loadHistory(view, 'history', true);
  });
  byId('companyDriverBolsMore').addEventListener('click', () => {
    if (view?.pages.bols?.cursor) void loadHistory(view, 'bols', true);
  });
  byId('companyDriverReviewIssue').addEventListener('click', () => {
    if (view?.dispatchDriverId) void officeTools.openReviewIssue(view.dispatchDriverId, name(view.profile));
  });
  byId('companyDriverAdminMessage').addEventListener('click', () => {
    if (view?.linked) void companyMessaging.openDriver({ profileId: view.profile.profile_id,
      ...(view.owner ? {} : { channel: 'dispatch' }) });
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
    return [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.name || 'Driver';
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

  async function openRateConfirmation(path) {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { showToast('Allow a new tab to open the rate confirmation.'); return; }
    tab.opener = null;
    try {
      const { data, error } = await supabaseClient.storage.from('dispatch-rate-confirmations').createSignedUrl(path, 120);
      if (error || !data?.signedUrl) throw error || new Error();
      tab.location.replace(data.signedUrl);
    } catch { tab.close(); showToast('Could not open the rate confirmation.'); }
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
    for (const name of ['period_start', 'period_end']) form.elements.namedItem(name).value = record[name];
    byId('newPaySettlementNumber').value = record.settlement_number || record.title;
    byId('companyPayDraftField').classList.add('hidden');
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
    paintPayNumber();
  }

  function paintPayNumber() {
    if (replacementKey) return;
    const drafts = byId('companyPayDraft');
    byId('companyPayDraftField').classList.toggle('hidden', drafts.options.length <= 1);
    byId('newPaySettlementNumber').value = drafts.value ? drafts.selectedOptions[0].textContent : '';
  }

  byId('companyPayDraft').addEventListener('change', paintPayNumber);

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
    byId('companyDriverPayButton').textContent = count ? 'Settlements (' + count + ')' : 'Settlements';
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

  function openSettlements() {
    activeReview = null;
    showPage('driverDocumentsPage');
    byId('driverPayStatus').textContent = 'Loading pay statements…';
    return refreshPay(true);
  }

  async function openDocuments() {
    const user = currentUser;
    if (!user || !['driver','company'].includes(accountTypeFor(user))) return;
    const request = {};
    ownDocumentsRequest = request;
    const active = () => ownDocumentsRequest === request && currentUser === user &&
      byId('ownDriverDocumentsPage').classList.contains('active');
    const status = byId('ownDriverDocumentStatus');
    const list = byId('ownDriverDocumentList');
    list.replaceChildren();
    status.textContent = 'Loading your documents…';
    showPage('ownDriverDocumentsPage');
    try {
      const { data: links, error } = await supabaseClient.from('rigtracker_fleet_links')
        .select('fleet_id,dispatch_driver_id').eq('profile_user_id', user.id).is('unlinked_at', null);
      if (error) throw error;
      if (!active()) return;
      const bucket = supabaseClient.storage.from(profileFileBucket);
      const groups = await Promise.all(links.filter(link => link.dispatch_driver_id).map(async link => {
        const folder = [link.fleet_id, link.dispatch_driver_id, 'documents'].join('/');
        const { data, error } = await bucket.list(folder, { limit:100, sortBy:{column:'created_at',order:'desc'} });
        if (error) throw error;
        return data.filter(file => file.id).map(file => ({ name:file.name, fleet:link.fleet_id, path:folder + '/' + file.name }));
      }));
      if (!active()) return;
      const files = groups.flat();
      list.replaceChildren(...files.map(file => {
        const row = element('article', '', 'dispatch-load-row');
        const info = element('div');
        info.append(element('strong', file.name.replace(/^[0-9a-f-]{36}-/i, '')), element('p', file.fleet));
        row.append(info, button('Open', () => openProfileFile(file.path)));
        return row;
      }));
      status.textContent = files.length ? '' : 'No documents are on your profile yet.';
    } catch (error) {
      if (active()) status.textContent = error.message || 'Could not load your documents.';
    }
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
      byId('companyDriverAdminClockPanel').classList.toggle('hidden', !detail.can_manage_clock);
      const control = byId('companyDriverClockSwitch');
      control.classList.toggle('hidden', !detail.linked);
      control.setAttribute('aria-pressed', String(detail.enabled));
      control.textContent = detail.enabled ? 'Time Clock On · Turn Off' : 'Time Clock Off · Turn On';
      byId('companyDriverClockArchive').classList.toggle('hidden', detail.linked);
      byId('companyDriverAdminShifts').replaceChildren(shiftList(detail.shifts));
      byId('companyDriverPayForm').classList.toggle('hidden', !detail.can_manage_pay);
      const drafts = byId('companyPayDraft');
      const selected = drafts.value;
      drafts.replaceChildren(new Option('Generate a new settlement number', ''),
        ...(detail.settlement_drafts || []).map(draft => new Option(draft.number, draft.id)));
      if ([...drafts.options].some(option => option.value === selected)) drafts.value = selected;
      paintPayNumber();
      paintStatements('companyDriverAdminPayList', detail.documents, detail.can_manage_pay);
    } catch (error) {
      if (view === selection && currentUser === selection.user) byId('companyDriverAdminStatus').textContent = error.message || 'Could not load the driver’s settings.';
    }
  }

  function openAdmin(profile, source = 'links', initialProfile, rosterFleet) {
    const user = currentUser;
    const fleet = rosterFleet || (source === 'payroll' ? payroll?.fleet_id : adminFleetId || officeTools.dispatchFleet());
    const owner = accountTypeFor(user) === 'fleet';
    if (!user || !fleet || (!owner && source === 'links' && !officeTools.canLinkProfiles())) return;
    view = { user, fleet, profile, source, owner, files: new Set(), pending: new Set(), pages: {} };
    closeEquipmentForm(false);
    equipmentEditor.classList.add('hidden');
    equipmentForm.reset();
    equipmentSave.disabled = equipmentCancel.disabled = false;
    byId('companyDriverAdminTitle').textContent = source === 'payroll' ? name(profile) : 'Driver Profile';
    byId('companyDriverAdminStatus').textContent = 'Loading driver profile…';
    for (const id of ['companyDriverAdminContent','companyDriverAdminSummary','companyDriverAdminMessage',
      'companyDriverAdminPaySettings','companyDriverHistoryMore','companyDriverBolsMore','companyDriverPayForm',
      'companyDriverAdminClockPanel','companyDriverReviewIssue']) byId(id).classList.add('hidden');
    for (const id of ['companyDriverAdminFacts','companyDriverCompanyFacts','companyDriverHistoryList','companyDriverBolsList',
      'companyDriverHistoryStatus','companyDriverBolsStatus','companyDriverAdminPresence','companyDriverAdminPayList',
      'companyDriverDraftSettlements','companyDriverPayStatusRows']) byId(id).replaceChildren();
    for (const container of document.querySelectorAll('[data-driver-profile-files]')) container.replaceChildren();
    for (const container of document.querySelectorAll('[data-driver-tracking]')) container.replaceChildren();
    byId('companyPayDraft').replaceChildren(new Option('Generate a new settlement number', ''));
    clearPayForm();
    showPage('companyDriverAdminPage');
    return loadOverview(view, initialProfile);
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
    const { settlement_id, period_start, period_end } = Object.fromEntries(new FormData(form));
    const replacing = replacementKey;
    const extensions = { 'application/pdf': 'pdf', 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
    const extension = extensions[file?.type];
    if (!extension || !file.size || file.size > 10485760) { showToast('Choose a PDF or photo up to 10 MB.'); return; }
    if (!period_start || !period_end || period_end < period_start) { showToast('Enter a valid pay period.'); return; }
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
      const sent = await rpc('publish_pay', selection.fleet, selection.profile.profile_id,
        { settlement_id, period_start, period_end, storage_key:pendingUpload.objectKey, replaces_key: replacing });
      if (view === selection && currentUser === selection.user) {
        clearPayForm();
        showToast(sent?.settlement_number ? 'Settlement ' + sent.settlement_number + ' sent for review.' : 'Statement sent to the driver for review.');
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
    const page = byId('companyPayrollPage');
    if (!user || !['fleet','employee'].includes(accountTypeFor(user)) ||
      (!force && (payrollRequest || page.classList.contains('active')))) return;
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
      if (force && page.classList.contains('active') && payrollSection === 'records') {
        if (!data) {
          byId('companyPayrollStatus').textContent = 'Payroll access is required.';
          return;
        }
        const queue = await rpc('payroll_queue', data.fleet_id);
        if (currentUser !== user || payrollRequest !== request || !page.classList.contains('active') || payrollSection !== 'records') return;
        paintPayroll(queue);
        void loadSavedSettlements(user, data.fleet_id);
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
  function checkedSettlementIds() {
    return [...byId('companyPayrollLoadSettlements').querySelectorAll('[data-settlement-load]:checked:not(:disabled)')]
      .map(input => input.value);
  }

  function updateSettlementButton() {
    byId('companyPayrollCreateSettlement').disabled = Boolean(settlementView?.saving) || !checkedSettlementIds().length;
  }

  function payrollRecordsActive(user, fleet) {
    return currentUser === user && payroll?.fleet_id === fleet &&
      byId('companyPayrollPage').classList.contains('active') && payrollSection === 'records';
  }

  function activeSettlementView(selection) {
    return settlementView === selection && payrollRecordsActive(selection.user, selection.fleet) &&
      byId('companyPayrollDriver').value === selection.profileId;
  }

  async function savedSettlements(fleet, id) {
    const { data, error } = await supabaseClient.rpc('company_payroll_saved_settlements', {
      target_fleet: fleet, ...(id ? {requested_settlement_id:id} : {})
    });
    if (error) throw error;
    return data;
  }

  async function loadSavedSettlements(user, fleet) {
    const request = {};
    savedSettlementsRequest = request;
    const active = () => savedSettlementsRequest === request && payrollRecordsActive(user, fleet);
    const status = byId('companyPayrollDraftStatus');
    try {
      const drafts = await savedSettlements(fleet);
      if (!active()) return;
      byId('companyPayrollDraftList').replaceChildren(...drafts.map(draft => {
        const row = element('article', '', 'dispatch-load-row');
        const info = element('div');
        info.append(element('strong', draft.settlement_number),
          element('p', [draft.driver, clockFormat.format(new Date(draft.created_at)),
            settlementCurrency.format(Number(draft.total_pay))].filter(Boolean).join(' · ')));
        row.append(info, button('View Draft', () => openSavedSettlement(draft.id)));
        return row;
      }));
      status.textContent = drafts.length ? '' : 'No saved settlement drafts.';
    } catch (error) {
      if (active()) status.textContent = error.message || 'Could not load saved settlement drafts.';
    }
  }

  const settlementCurrency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });

  function showSettlementPreview(settlement, lines, status) {
    const preview = byId('companyPayrollSettlementPreview');
    const rows = lines.map(line => {
      const label = (line.is_return ? 'B-' : 'A-') + line.pro_number;
      const row = element('div', '', 'settlement-preview-line');
      const miles = [line.loaded_miles != null ? Number(line.loaded_miles).toLocaleString() + ' loaded mi' : '',
        line.empty_miles != null ? Number(line.empty_miles).toLocaleString() + ' empty mi' : ''].filter(Boolean).join(' · ');
      row.append(element('strong', label), element('span', miles || 'Miles not recorded'),
        element('span', 'Pay scale: ' + payScaleLabel(line.pay_scale)));
      if (line.base_pay_entered) row.append(element('span', 'Base / saved pay: ' + settlementCurrency.format(Number(line.base_pay))));
      else row.append(element('span', 'Base pay not entered · review needed', 'muted'));
      for (const [amount, title] of [[line.empty_mile_pay,'Empty-mile pay'],[line.stop_pay,'Stop pay'],[line.additional_pay,'Additional pay']]) {
        if (Number(amount)) row.append(element('span', title + ': ' + settlementCurrency.format(Number(amount))));
      }
      return row;
    });
    const missingBase = lines.some(line => !line.base_pay_entered);
    preview.replaceChildren(
      element('h3', 'Settlement ' + settlement.settlement_number + ' · ' + status),
      element('p', [settlement.driver, lines.length + ' completed load' + (lines.length === 1 ? '' : 's')].filter(Boolean).join(' · ')),
      ...rows,
      element('strong', 'Known pay items: ' + settlementCurrency.format(Number(settlement.total_pay)), 'settlement-preview-total'),
      ...(missingBase ? [element('p', 'Review the loads with missing base pay before issuing this settlement.', 'muted')] : []),
      button('Print / Save as PDF', () => window.print())
    );
    preview.classList.remove('hidden');
    preview.scrollIntoView?.({ block:'nearest' });
  }

  async function openSavedSettlement(id) {
    const user = currentUser;
    const fleet = payroll?.fleet_id;
    if (!fleet || !payrollRecordsActive(user, fleet)) return;
    const request = {};
    settlementPreviewRequest = request;
    const active = () => settlementPreviewRequest === request && payrollRecordsActive(user, fleet);
    const preview = byId('companyPayrollSettlementPreview');
    preview.replaceChildren(element('p', 'Loading saved settlement…', 'muted'));
    preview.classList.remove('hidden');
    try {
      const [record] = await savedSettlements(fleet, id);
      if (!active()) return;
      if (!record) throw new Error('This saved settlement is unavailable.');
      showSettlementPreview(record, record.lines, record.sent_for_review ? 'Sent for review' : 'Draft saved');
    } catch (error) {
      if (active()) preview.replaceChildren(element('p', error.message || 'Could not open this settlement.', 'muted'));
    }
  }

  function settlementHourStart(now = new Date()) {
    return now.getTime() - (now.getMinutes() * 60 + now.getSeconds()) * 1000 - now.getMilliseconds();
  }

  function refreshSettlementHour() {
    const selection = settlementView;
    if (!document.hidden && selection?.profileId && activeSettlementView(selection) &&
      selection.readHour !== settlementHourStart()) {
      void loadSettlementLoads(selection.fleet, selection.profileId);
    }
  }

  function scheduleSettlementHour() {
    const now = new Date();
    setTimeout(function atSettlementHour() {
      scheduleSettlementHour();
      refreshSettlementHour();
    }, settlementHourStart(now) + 60 * 60 * 1000 - now.getTime());
  }

  async function createSettlementPreview() {
    const selection = settlementView;
    if (!selection || selection.saving || !activeSettlementView(selection)) return;
    const ids = new Set(checkedSettlementIds());
    const selected = selection.loads.filter(load => ids.has(load.load_id) && !load.created_settlement);
    const preview = byId('companyPayrollSettlementPreview');
    if (!selected.length) {
      preview.replaceChildren(element('p', 'Select at least one completed load.', 'muted'));
      preview.classList.remove('hidden');
      return;
    }
    const { fleet, profileId } = selection;
    const request = {};
    settlementPreviewRequest = request;
    selection.saving = true;
    updateSettlementButton();
    preview.replaceChildren(element('p', 'Saving settlement draft…', 'muted'));
    preview.classList.remove('hidden');
    try {
      const { data: created, error } = await supabaseClient.rpc('create_company_driver_settlement', {
        target_fleet: fleet, target_profile: profileId, requested_load_ids: selected.map(load => load.load_id)
      });
      if (error) throw error;
      if (payrollRecordsActive(selection.user, fleet)) void loadSavedSettlements(selection.user, fleet);
      if (!activeSettlementView(selection)) return;
      paintSettlementLoads(selection, selection.loads.map(load => ids.has(load.load_id) ? {
        ...load, created_settlement: { id: created.id, number: created.settlement_number }
      } : load));
      await loadSettlementLoads(fleet, profileId, true);
      if (!activeSettlementView(selection) || settlementPreviewRequest !== request) return;
      const driver = byId('companyPayrollDriver').selectedOptions[0]?.textContent || 'Company Driver';
      const lines = selected.map(load => {
        const pay = settlementLoadPay(load);
        return { ...load, base_pay:pay.base-pay.additional-pay.empty, base_pay_entered:pay.baseKnown,
          empty_mile_pay:pay.empty, stop_pay:pay.stop, additional_pay:pay.additional };
      });
      showSettlementPreview({ ...created, driver }, lines, 'Draft saved');
    } catch (error) {
      if (activeSettlementView(selection) && settlementPreviewRequest === request) {
        preview.replaceChildren(element('p', error.message || 'Could not create this settlement.', 'muted'));
      }
    } finally {
      selection.saving = false;
      if (settlementView === selection) {
        updateSettlementButton();
        refreshSettlementHour();
      }
    }
  }

  async function loadSettlementLoads(fleet, profileId, force = false) {
    const list = byId('companyPayrollLoadSettlements');
    const user = currentUser;
    if (!settlementView || settlementView.user !== user || settlementView.fleet !== fleet || settlementView.profileId !== profileId) {
      settlementView = { user, fleet, profileId, loads: [] };
      settlementPreviewRequest = null;
      const preview = byId('companyPayrollSettlementPreview');
      preview.replaceChildren();
      preview.classList.add('hidden');
      list.replaceChildren(element('p', profileId ? 'Loading completed loads…' : 'Select a driver to view completed loads.', 'muted'));
      updateSettlementButton();
    }
    const selection = settlementView;
    if (!profileId || (!force && (selection.request || selection.saving))) return;
    const request = {};
    selection.request = request;
    selection.readHour = settlementHourStart();
    const active = () => selection.request === request && activeSettlementView(selection);
    try {
      const { data, error } = await supabaseClient.rpc('company_driver_load_settlements', {
        target_fleet: fleet, target_profile: profileId
      });
      if (error) throw error;
      if (active()) paintSettlementLoads(selection, Array.isArray(data) ? data : []);
    } catch (error) {
      if (active() && selection.signature === undefined) {
        list.replaceChildren(element('p', error.message || 'Could not load completed loads.', 'muted'));
      }
    } finally {
      if (selection.request === request) {
        selection.request = null;
        refreshSettlementHour();
      }
    }
  }

  function paintSettlementLoads(selection, loads) {
    const signature = JSON.stringify(loads);
    if (selection.signature === signature) return;
    const list = byId('companyPayrollLoadSettlements');
    const checked = new Set(checkedSettlementIds());
    const expanded = new Set([...list.querySelectorAll('.settlement-load-details[open]')]
      .map(details => details.closest('article').querySelector('[data-settlement-load]').value));
    selection.loads = loads;
    selection.signature = signature;
    const currency = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' });
    list.replaceChildren(...(loads.length ? loads.map(load => {
      const row = element('article', '', 'dispatch-load-row company-pay-load-row');
      const summary = element('div');
      const label = (load.is_return ? 'B-' : 'A-') + load.pro_number;
      const place = stop => [stop?.city, stop?.state].filter(Boolean).join(', ') || stop?.company || '';
      const route = [place(load.pickup), place(load.receiver)].filter(Boolean).join(' → ');
      summary.append(element('strong', label + (load.route_number ? ' · Route ' + load.route_number : '')));
      if (route) summary.append(element('p', route));
      const completedAt = load.completed_at || load.updated_at;
      if (completedAt) summary.append(element('p', 'Completed ' + clockFormat.format(new Date(completedAt)), 'muted'));
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
      checkbox.checked = !checkbox.disabled && checked.has(load.load_id);
      const addLabel = () => checkbox.disabled ? 'Already in settlement'
        : checkbox.checked ? 'Added · Remove from settlement' : 'Add load to this settlement';
      const onSelectionChange = () => {
        add.textContent = addLabel();
        updateSettlementButton();
      };
      const savedId = load.created_settlement?.id;
      const add = button(savedId ? 'View Settlement' : addLabel(), () => {
        if (savedId) return openSavedSettlement(savedId);
        if (checkbox.disabled) return;
        checkbox.checked = !checkbox.checked;
        onSelectionChange();
      });
      add.disabled = checkbox.disabled && !savedId;
      checkbox.addEventListener('change', onSelectionChange);
      choose.append(checkbox, element('span', load.created_settlement ? 'Settlement ' + load.created_settlement.number : 'Select load'));
      if (load.created_settlement) {
        const { number, line_total } = load.created_settlement;
        const amount = line_total == null ? '' : ' · ' + currency.format(Number(line_total));
        summary.append(element('p', 'Included in settlement ' + number + amount, 'muted'));
      }
      const freight = load.freight || {};
      const more = element('details', '', 'settlement-load-details');
      more.open = expanded.has(load.load_id);
      more.append(element('summary', 'View load details'));
      const facts = element('dl', '', 'settlement-load-facts');
      const fact = (label, value) => { if (value !== null && value !== undefined && String(value).trim()) {
        const pair = element('div'); pair.append(element('dt', label), element('dd', String(value))); facts.append(pair);
      }};
      fact('Truck number', freight.truckNumber); fact('Trailer number', freight.trailerNumber);
      fact('Commodity', freight.commodity === 'Other' ? freight.commodityOther : freight.commodity);
      fact('Weight', freight.weightLbs ? Number(freight.weightLbs).toLocaleString() + ' lb' : '');
      fact('Pieces', freight.pieces); fact('Equipment', freight.equipmentType === 'Other' ? freight.equipmentTypeOther : freight.equipmentType);
      fact('Trailer drop', freight.trailerDrop === 'yes' ? freight.trailerDropNotes || 'Yes' : 'No');
      fact('Broker', freight.brokerName); fact('Broker contact', [freight.brokerPhone, freight.brokerEmail].filter(Boolean).join(' · '));
      fact('Shipper', load.pickup?.company); fact('Receiver', load.receiver?.company);
      fact('Shipper contact', driverLoadWorkflow.stopContact(load.pickup));
      fact('Receiver contact', driverLoadWorkflow.stopContact(load.receiver));
      fact('Route / shipping number', [freight.routeNumber, freight.brokerLoadNumber].filter(Boolean).join(' · '));
      fact('Pickup number', freight.pickupNumber); fact('Loaded miles', load.loaded_miles != null ? Number(load.loaded_miles).toLocaleString() + ' mi' : '');
      fact('Stop pay', currency.format(Number(load.stop_pay || 0)));
      fact('Additional pay', currency.format(Number(load.additional_pay || 0)));
      more.append(facts);
      for (const report of [...(load.pickup_reports || []), ...(load.receiver_reports || [])].filter(Boolean)) {
        const label = report.kind === 'pickup' ? 'signed pickup BOL' : 'signed delivery BOL';
        more.append(...driverLoadWorkflow.paperworkButtons(report.report, label, button));
        more.append(element('p', driverLoadWorkflow.lumperCharge(report.report), 'muted'));
      }
      if (freight.rateConfirmation?.path) more.append(button('View Rate Confirmation', () => openRateConfirmation(freight.rateConfirmation.path)));
      row.append(summary, more, choose, add);
      return row;
    }) : [element('p', 'No loads are ready for settlement for this driver.', 'muted')]));
    updateSettlementButton();
  }
  function paintPayroll(queue) {
    const picker = byId('companyPayrollDriver');
    const selected = picker.value;
    const choices = [['', 'Select a Company Driver'], ...queue.drivers.map(driver => [driver.profile_id, name(driver)])];
    if (choices.length !== picker.options.length || choices.some(([id, label], index) =>
      picker.options[index].value !== id || picker.options[index].text !== label)) {
      picker.replaceChildren(...choices.map(([id, label]) => new Option(label, id)));
      if (choices.some(([id]) => id === selected)) picker.value = selected;
    }
    picker.onchange = () => void loadSettlementLoads(payroll?.fleet_id, picker.value);
    byId('companyPayrollCreateSettlement').onclick = createSettlementPreview;
    byId('companyPayrollOpenDriver').onclick = () => {
      const driver = queue.drivers.find(driver => driver.profile_id === picker.value);
      if (driver) openAdmin(driver, 'payroll');
    };
    const signature = JSON.stringify(queue.records);
    if (payrollQueueSignature !== signature) {
      payrollQueueSignature = signature;
      byId('companyPayrollQueue').replaceChildren(...(queue.records.length ? queue.records.map(record => {
        const row = element('article', '', 'dispatch-load-row');
        const summary = element('div');
        summary.append(element('strong', name(record) + ' · ' + record.title),
          element('p', settlementStatus[record.status], 'muted'));
        if (record.review_note) summary.append(element('p', record.review_note));
        row.append(summary, button('Open Review', () => openAdmin(record, 'payroll')));
        return row;
      }) : [element('p', 'No settlements are awaiting review or submission.', 'muted')]));
    }
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
    if (view?.source === 'dispatch') return view.owner ? showFleetSection('dispatch', 'drivers') : showOfficeDispatch('drivers');
    if (view?.source === 'equipment') return view.owner ? showFleetSection('dispatch', 'equipment') : showOfficeDispatch('equipment');
    return view?.owner ? showFleetSection('links') : showPage('fleetWorkspace');
  }

  function refresh() {
    if (!currentUser) return;
    if (accountTypeFor(currentUser) === 'company') {
      void recordPresence();
      void refreshClock();
      if (!byId('driverDocumentsPage').classList.contains('active')) void refreshPay();
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
    byId('companyPayrollDraftList').replaceChildren();
    byId('companyPayrollDraftStatus').textContent = '';
    byId('companyPayrollLoadSettlements').replaceChildren();
    byId('companyPayrollSettlementPreview').replaceChildren();
    byId('companyPayrollSettlementPreview').classList.add('hidden');
    byId('companyPayrollCreateSettlement').disabled = true;
    settlementView = null; payrollQueueSignature = null;
    savedSettlementsRequest = null; settlementPreviewRequest = null; ownDocumentsRequest = null;
    byId('ownDriverDocumentList').replaceChildren();
    byId('ownDriverDocumentStatus').textContent = '';
    byId('companyPayrollDriver').replaceChildren();
    byId('companyPayrollOpenDriver').onclick = null;
    adminRequest = null; clockRequest = null; payRequest = null;
    byId('formerCompanyDrivers').open = false;
    for (const id of ['driverPayList','companyDriverClockList','companyDriverAdminShifts','companyDriverAdminPayList',
      'formerCompanyDriverList','companyDriverAdminFacts','companyDriverHistoryList','companyDriverAdminPresence']) byId(id).replaceChildren();
    byId('companyDriverClockButton').classList.add('hidden');
    byId('companyDriverPayButton').textContent = 'Settlements';
  }

  setInterval(() => {
    if (!document.hidden && !byId('companyPayrollPage').classList.contains('active')) refresh();
  },24000);
  scheduleSettlementHour();
  document.addEventListener('visibilitychange', refreshSettlementHour);
  return { openDocuments, openSettlements, openClock, openAdmin, openRoster, openPayroll, backPayroll, backAdmin, loadFormer, refresh, reset };
})();
