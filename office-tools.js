const officeTools = (() => {
  const byId = id => document.getElementById(id);
  const dialog = byId('officeProfileDialog');
  const accessForm = byId('officeProfileAccessForm');
  const rateForm = byId('officeProfileHourlyRateForm');
  const rateStatus = byId('officeProfileHourlyRateStatus');
  const rateSave = rateForm.querySelector('button[type=submit]');
  const passwordForm = byId('officeProfilePasswordForm');
  const temporaryPassword = byId('officeProfileTemporaryPassword');
  const tabs = [...document.querySelectorAll('[data-office-tool]')];
  const permissionLabels = [...document.querySelectorAll('#newEmployeePermissionOptions [name=officePermission]')]
    .map(field => [field.value, field.closest('label').textContent.trim()]);
  const driverTabLabels = [...document.querySelectorAll('#newEmployeeDriverProfileAccess [name=driverProfilePermission]')]
    .map(field => [field.value, field.closest('label').textContent.trim()]);
  const issueDialog = byId('officeReviewIssueDialog');
  const issueForm = byId('officeReviewIssueForm');
  let issueRequest;
  const requests = new Map();
  const clock = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  });
  let employee;
  let editing;
  let pending = false;
  let employeeRequest;
  let clockRequest;
  let clockWrite;
  let officeShift;

  const has = permission => Boolean(employee && (employee.office_is_official || employee.office_permissions.includes(permission)));
  const canLinkProfiles = () => Boolean(employee?.office_is_official && employee.office_can_link_profiles && !employee.password_required);
  const fuelSettingsFleet = () => employee?.office_can_manage_fuel_settings && !employee.password_required ? employee.fleet_id : null;
  const messagesAllowed = () => Boolean(employee && !employee.password_required && ['messages','dispatch','assets','policies'].some(has));
  const visible = (id, allowed) => byId(id).classList.toggle('hidden', !allowed);
  const displayName = row => [row.first_name,row.last_name].filter(Boolean).join(' ') || 'Office employee';

  function renderTools() {
    for (const tab of tabs) {
      const key = tab.dataset.officeTool;
      const available = key === 'review-issue' || key === 'hr' ? Boolean(employee && !employee.password_required)
        : key === 'office_messages' ? Boolean(employee && !employee.password_required)
        : key === 'profiles' ? employee?.office_can_manage_profiles
        : key === 'link-profiles' ? canLinkProfiles()
        : key === 'equipment' ? has('dispatch') || has('assets')
        : key === 'safety' ? employee?.office_is_official : key === 'messages' ? messagesAllowed()
        : key === 'settlements' ? has(key) || Boolean(fuelSettingsFleet()) : has(key);
      tab.classList.toggle('hidden', !available);
    }
    for (const group of document.querySelectorAll('[data-office-group]')) {
      group.classList.toggle('hidden', !group.querySelector('[data-office-tool]:not(.hidden)'));
    }
    visible('officeNoTools', Boolean(employee) && tabs.every(tab => tab.classList.contains('hidden')));
  }

  function paintClock() {
    const widget = byId('officeClockWidget');
    const control = byId('officeClockToggle');
    const enabled = Boolean(employee && has('hourly'));
    widget.classList.toggle('hidden', !enabled);
    if (!enabled) return;
    const active = Boolean(officeShift?.clocked_in);
    byId('officeClockStatus').textContent = active
      ? 'Started ' + clock.format(new Date(officeShift.started_at))
      : 'Not clocked in';
    control.textContent = active ? 'Stop' : 'Start';
    control.setAttribute('aria-label', active ? 'Stop work time clock' : 'Start work time clock');
  }

  async function clockRpc(action, fleetId) {
    const { data, error } = await supabaseClient.rpc('fleet_employee_time_clock', { action, target_fleet: fleetId });
    if (error) throw error;
    return data;
  }

  async function refreshClock() {
    const user = currentUser;
    if (!user || !employee || !has('hourly')) { paintClock(); return; }
    const request = {};
    clockRequest = request;
    try {
      const data = await clockRpc('clock_status', employee.fleet_id);
      if (currentUser !== user) return;
      if (clockRequest === request) {
        officeShift = data;
        paintClock();
      }
      return data;
    } catch {
      if (currentUser === user && clockRequest === request) {
        officeShift = null;
        byId('officeClockWidget').classList.toggle('hidden', !(employee && has('hourly')));
        byId('officeClockStatus').textContent = 'Clock unavailable';
        byId('officeClockToggle').textContent = 'Start';
      }
    }
  }

  async function clockStatus() {
    const user = currentUser;
    if (!user || !employee || !has('hourly')) return [];
    if (clockWrite) await Promise.allSettled([clockWrite]);
    if (currentUser !== user) return [];
    const status = await refreshClock();
    return status ? [{ fleetId: status.fleet_id, enabled: true, running: status.clocked_in }] : [];
  }

  async function updateClock(action, fleetId) {
    if (!employee || employee.fleet_id !== fleetId || !has('hourly')) throw new Error('Hourly time clock access is required.');
    const user = currentUser;
    const write = clockRpc(action, fleetId);
    clockWrite = write;
    try {
      const shift = await write;
      if (currentUser === user && employee?.fleet_id === fleetId) {
        clockRequest = null;
        officeShift = shift;
        paintClock();
      }
    } finally {
      if (clockWrite === write) clockWrite = null;
    }
  }

  async function toggleClock() {
    if (!employee || !has('hourly')) return;
    const user = currentUser;
    const action = officeShift?.clocked_in ? 'clock_out' : 'clock_in';
    const control = byId('officeClockToggle');
    control.disabled = true;
    try {
      await updateClock(action, employee.fleet_id);
    } catch (error) {
      if (currentUser === user) showToast(error.message || 'Could not update the work time clock.');
    } finally {
      control.disabled = false;
    }
  }

  byId('officeClockToggle').addEventListener('click', () => void toggleClock());

  function setEmployee(profile) {
    employee = { ...profile, office_permissions: profile.office_permissions || [] };
    byId('employeeAccountSummary').textContent = profile.fleet_id + '-' + profile.employee_id
      + (profile.office_role ? ' · ' + profile.office_role : '');
    visible('officeDashboardTools', true);
    renderTools();
    paintClock();
    void refreshClock();
  }

  function readEmployee(user) {
    return supabaseClient.from('fleet_employees')
      .select('fleet_id,employee_id,office_role,office_is_official,office_can_manage_profiles,office_can_link_profiles,office_can_manage_fuel_settings,office_permissions,password_required')
      .eq('user_id',user.id).maybeSingle();
  }

  async function refreshEmployee() {
    const user = currentUser;
    if (!user || accountTypeFor(user) !== 'employee') return;
    const request = {};
    employeeRequest = request;
    const { data, error } = await readEmployee(user);
    if (currentUser !== user || employeeRequest !== request || error || !data) return;
    if (data.password_required) {
      if (!byId('rigTrackerPasswordPage').classList.contains('active')) openRigTrackerPasswordChange(true);
      return;
    }
    setEmployee(data);
  }

  function openDashboard() {
    showPage('fleetEmployeePage');
    return refreshEmployee();
  }

  function dispatchFleet() {
    return has('dispatch') || has('drivers') ? employee.fleet_id : null;
  }

  function equipmentFleet() {
    return has('dispatch') || has('assets') ? employee.fleet_id : null;
  }

  function dispatchAccess() {
    return { dispatch:has('dispatch'), drivers:has('drivers'), equipment:Boolean(equipmentFleet()),
      maintenance:has('assets'), paySettings:Boolean(employee?.office_is_official), messages:messagesAllowed(),
      processing:has('bol_payments') };
  }

  async function rpc(action, fleet, row, settings) {
    const payload = { action, fleet, ...(row ? { employee_number:row.employee_id } : {}), ...(settings ? { settings } : {}) };
    const { data, error } = await supabaseClient.rpc('office_profiles',payload);
    if (error) throw error;
    return data;
  }

  function rosterRow(row, fleet, prefix) {
    const tr = document.createElement('tr');
    for (const value of [displayName(row), fleet + '-' + row.employee_id, row.office_role || '—',
      row.office_can_manage_profiles ? 'On' : 'Off']) {
      tr.insertCell().textContent = value;
    }
    const actions = tr.insertCell();
    if (row.can_edit) {
      const control = document.createElement('button');
      control.className = 'outline';
      control.type = 'button';
      control.textContent = 'Edit Profile';
      control.addEventListener('click',()=>editProfile(row,fleet,prefix));
      actions.append(control);
    }
    return tr;
  }

  async function loadRoster(prefix, fleet) {
    const user = currentUser;
    if (!user || !fleet) return;
    const request = {};
    requests.set(prefix,request);
    const status = byId(prefix+'Status');
    visible(prefix+'Status',true);
    visible(prefix+'Table',false);
    status.textContent = 'Loading profiles…';
    try {
      const rows = await rpc('list',fleet);
      if (currentUser !== user || requests.get(prefix) !== request) return;
      if (!rows.length) { status.textContent = 'No Office profiles yet.'; return; }
      byId(prefix+'Rows').replaceChildren(...rows.map(row=>rosterRow(row,fleet,prefix)));
      visible(prefix+'Table',true);
      visible(prefix+'Status',false);
    } catch (error) {
      if (currentUser === user && requests.get(prefix) === request) status.textContent = error.message || 'Could not load Office profiles.';
    }
  }

  function updateCreateAccess() {
    const official = byId('newEmployeeDesignation').value === 'official';
    visible('newEmployeeOfficialAccess',official);
    visible('newEmployeePermissionOptions',!official);
  }
  byId('newEmployeeDesignation').addEventListener('change',updateCreateAccess);

  function updateEditAccess() {
    const official = byId('officeProfileDesignation').value === 'official';
    visible('officeProfileOfficialAccess',official);
    visible('officeProfileLinkAccess',Boolean(editing?.admin) && official);
    visible('officeProfileFuelAccess',Boolean(editing?.admin));
    visible('officeProfilePermissionFields',!official);
  }
  byId('officeProfileDesignation').addEventListener('change',updateEditAccess);

  async function hourlyRateRpc(selection, action, change = {}) {
    const { data, error } = await supabaseClient.rpc('manage_office_hourly_rates', {
      action, target_fleet: selection.fleet, employee_number: selection.row.employee_id, ...change
    });
    if (error) throw error;
    return data;
  }

  const isEditing = selection => editing === selection && currentUser === selection.user;

  function showRateForDate() {
    if (!editing?.rates) return;
    const date = rateForm.elements.effective_on.value;
    const rate = editing.rates.find(row => row.effective_on <= date);
    rateForm.elements.hourly_rate.value = rate ? Number(rate.hourly_rate).toFixed(2) : '';
    rateStatus.textContent = rate ? 'Rate effective from ' + rate.effective_on + '.' : 'No hourly rate saved for this date.';
  }

  async function loadHourlyRates(selection) {
    selection.rates = null;
    rateSave.disabled = true;
    rateStatus.textContent = 'Loading hourly rates…';
    try {
      const rates = await hourlyRateRpc(selection, 'list');
      if (!isEditing(selection)) return;
      selection.rates = rates;
      showRateForDate();
      rateSave.disabled = pending;
    } catch (error) {
      if (isEditing(selection)) rateStatus.textContent = error.message || 'Could not load hourly rates.';
    }
  }

  function clearRateForm() {
    rateForm.reset();
    rateStatus.textContent = '';
    rateForm.classList.add('hidden');
  }

  rateForm.elements.effective_on.addEventListener('change', showRateForDate);
  rateForm.addEventListener('submit', async event => {
    event.preventDefault();
    const selection = editing;
    if (!selection?.rates || pending || !rateForm.reportValidity()) return;
    const { effective_on, hourly_rate } = Object.fromEntries(new FormData(rateForm));
    const existing = selection.rates.find(row => row.effective_on === effective_on);
    setBusy(true);
    rateStatus.textContent = 'Saving hourly rate…';
    try {
      const saved = await hourlyRateRpc(selection, 'save', {
        rate_date: effective_on, rate_amount: hourly_rate, expected_revision: existing?.revision ?? null
      });
      if (!isEditing(selection)) return;
      selection.rates = [saved, ...selection.rates.filter(row => row.effective_on !== effective_on)]
        .sort((a,b) => b.effective_on.localeCompare(a.effective_on));
      showRateForDate();
      rateStatus.textContent = 'Hourly rate saved. Effective from ' + saved.effective_on + '.';
    } catch (error) {
      if (!isEditing(selection)) return;
      if (error.code === '40001') await loadHourlyRates(selection);
      if (isEditing(selection)) rateStatus.textContent = error.message || 'Could not save the hourly rate.';
    } finally {
      setBusy(false);
    }
  });

  function editProfile(row,fleet,prefix) {
    if (pending) return;
    const admin = accountTypeFor(currentUser) === 'fleet';
    editing = { row,fleet,prefix,user:currentUser,admin };
    byId('officeProfileIdentity').textContent = displayName(row) + ' · ' + fleet + '-' + row.employee_id;
    visible('officeProfileHrTaxForms',hrTaxForms.canManage());
    byId('officeProfileDesignation').value = row.office_is_official ? 'official' : 'unofficial';
    byId('officeProfileManage').checked = row.office_can_manage_profiles;
    byId('officeProfileLink').checked = Boolean(row.office_can_link_profiles);
    byId('officeProfileFuelSettings').checked = Boolean(row.office_can_manage_fuel_settings);
    visible('officeProfileDesignationFields',admin);
    const assigned = row.office_permissions || [];
    const options = labels => labels.map(([key,label]) => {
      const option = document.createElement('label');
      const field = document.createElement('input');
      field.type = 'checkbox';
      field.name = 'permission';
      field.value = key;
      field.checked = assigned.includes(key);
      field.disabled = !admin && !has(key);
      option.append(field,' '+label);
      return option;
    });
    byId('officeProfilePermissionOptions').replaceChildren(...options(permissionLabels));
    byId('officeProfileDriverTabOptions').replaceChildren(...(admin ? options(driverTabLabels) : []));
    visible('officeProfileDriverTabFields',admin);
    passwordForm.reset();
    clearRateForm();
    if (admin || has('payroll')) {
      rateForm.classList.remove('hidden');
      rateForm.elements.effective_on.value = todayForZone(preferredZone);
      void loadHourlyRates(editing);
    }
    byId('officeProfileStatus').textContent = row.password_required ? 'A temporary password is required at sign-in.' : '';
    updateEditAccess();
    dialog.showModal();
  }

  function setBusy(value) {
    pending = value;
    const controls = [byId('officeProfileClose'),accessForm.querySelector('button[type=submit]'),passwordForm.querySelector('button[type=submit]')];
    for (const control of controls) control.disabled = value;
    rateSave.disabled = value || !editing?.rates;
    rateForm.elements.effective_on.disabled = rateForm.elements.hourly_rate.disabled = value;
  }

  async function saveChange(work, success) {
    const selection = editing;
    if (!selection || pending) return;
    setBusy(true);
    byId('officeProfileStatus').textContent = '';
    try {
      await work(selection);
      if (editing !== selection || currentUser !== selection.user) return;
      byId('officeProfileStatus').textContent = success(selection);
      await loadRoster(selection.prefix,selection.fleet);
    } catch (error) {
      if (editing === selection && currentUser === selection.user) byId('officeProfileStatus').textContent = error.message || 'Could not save the profile.';
    } finally { setBusy(false); }
  }

  accessForm.addEventListener('submit', event=>{
    event.preventDefault();
    const settings = { permissions:[...accessForm.querySelectorAll('[name=permission]:checked')].map(input=>input.value) };
    if (editing?.admin) {
      settings.is_official = byId('officeProfileDesignation').value === 'official';
      settings.can_manage_profiles = byId('officeProfileManage').checked;
      settings.can_link_profiles = settings.is_official && byId('officeProfileLink').checked;
      settings.can_manage_fuel_settings = byId('officeProfileFuelSettings').checked;
    }
    void saveChange(selection=>rpc('edit',selection.fleet,selection.row,settings),()=> 'Access updated.');
  });

  byId('officeGeneratePassword').addEventListener('click',()=>{
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(15));
    temporaryPassword.value = '9a!' + Array.from(bytes,byte=>alphabet[byte % alphabet.length]).join('');
    temporaryPassword.focus();
    temporaryPassword.select();
  });

  byId('officeCopyPassword').addEventListener('click',async ()=>{
    if (!temporaryPassword.value) return;
    try {
      await navigator.clipboard.writeText(temporaryPassword.value);
      byId('officeProfileStatus').textContent = 'Temporary password copied.';
    } catch {
      temporaryPassword.select();
      byId('officeProfileStatus').textContent = 'Select and copy the temporary password.';
    }
  });

  passwordForm.addEventListener('submit', event=>{
    event.preventDefault();
    const password = temporaryPassword.value;
    if (!meetsPasswordRequirements(password)) {
      byId('officeProfileStatus').textContent = passwordRequirements;
      return;
    }
    void saveChange(async selection=>{
      const {error} = await supabaseClient.functions.invoke('create-fleet-employee',{body:{
        action:'reset_password',fleetId:selection.fleet,employeeId:selection.row.employee_id,password
      }});
      if (error) {
        const result = await error.context?.json?.().catch(()=>null);
        throw Error(result?.message || 'Could not reset the password.');
      }
    },selection=> 'Temporary password set for ' + selection.fleet + '-' + selection.row.employee_id + '.');
  });

  byId('officeProfileClose').addEventListener('click',()=>dialog.close());
  byId('officeProfileHrTaxForms').addEventListener('click',() => {
    const selection = editing;
    if (!selection || pending || !hrTaxForms.canManage()) return;
    const pageId = document.querySelector('.page.active')?.id;
    dialog.close();
    void hrTaxForms.open(selection.fleet,{kind:'office',number:selection.row.employee_id},() => showPage(pageId));
  });
  dialog.addEventListener('cancel',event=>{ if (pending) event.preventDefault(); });
  dialog.addEventListener('close',()=>{
    editing = null;
    passwordForm.reset();
    clearRateForm();
    byId('officeProfileStatus').textContent = '';
  });

  async function openHourly() {
    const user = currentUser;
    const fleet = employee?.fleet_id;
    if (fleet && has('payroll')) return officePayroll.open(fleet);
    showPage('officeHourlyPage');
    const status = byId('officeHourlyStatus');
    const list = byId('officeHourlyRows');
    status.textContent = 'Loading office employee shifts…';
    list.replaceChildren();
    try {
      const {data,error} = await supabaseClient.rpc('fleet_employee_time_clock',{
        action:'hourly_roster', target_fleet:fleet,
        params:{from:byId('officePayrollFrom').value,to:byId('officePayrollTo').value}
      });
      if (error) throw error;
      if (user !== currentUser || fleet !== employee?.fleet_id) return;
      const people = data?.employees || [];
      const rows = people.flatMap(person => (person.shifts || []).map(shift => {
        const row = document.createElement('article');
        row.className = 'dispatch-load-row';
        const name = document.createElement('strong');
        name.textContent = person.name + ' · ' + data.fleet_id + '-' + person.employee_id;
        const times = document.createElement('span');
        times.textContent = clock.format(new Date(shift.started_at)) + ' → ' +
          (shift.ended_at ? clock.format(new Date(shift.ended_at)) : 'Clocked in');
        row.append(name,times);
        return row;
      }));
      status.textContent = rows.length ? '' : 'No office employee shifts recorded in this period.';
      list.replaceChildren(...rows);
    } catch (error) {
      if (user === currentUser) status.textContent = error.message || 'Could not load hourly office shifts.';
    }
  }
  function openProfileLink() {
    if (!canLinkProfiles()) return;
    fleetSection = 'links';
    resetFleetLinkForm();
    renderFleetSections();
    showPage('fleetWorkspace');
  }

  async function issueRpc(fleet, action, target, payload) {
    const { data, error } = await supabaseClient.rpc('file_office_review_issue', {
      target_fleet: fleet, action, ...(target ? { target_driver:target } : {}),
      ...(payload ? { payload } : {})
    });
    if (error) throw error;
    return data;
  }

  async function openReviewIssue(driverId, driverName) {
    if (!employee || employee.password_required || issueDialog.open) return;
    const request = { user:currentUser, fleet:employee.fleet_id, driverId, id:crypto.randomUUID() };
    issueRequest = request;
    issueForm.reset();
    byId('officeReviewIssueClose').disabled = false;
    byId('officeReviewIssueContext').textContent = driverName || '';
    const status = byId('officeReviewIssueStatus');
    const choices = byId('officeReviewIssueChoices');
    choices.replaceChildren();
    status.textContent = 'Loading officials…';
    byId('officeReviewIssueSubmit').disabled = true;
    issueDialog.showModal();
    try {
      const reviewers = await issueRpc(request.fleet, 'reviewers');
      if (issueRequest !== request || currentUser !== request.user || !issueDialog.open) return;
      choices.replaceChildren(...reviewers.map(reviewer => {
        const label = document.createElement('label');
        const control = document.createElement('input');
        control.type = 'checkbox';
        control.name = 'reviewer';
        control.value = reviewer.id;
        label.append(control, ' ' + reviewer.name);
        return label;
      }));
      status.textContent = reviewers.length ? '' : 'No active officials are available for review.';
      byId('officeReviewIssueSubmit').disabled = !reviewers.length;
    } catch (error) {
      if (issueRequest === request && currentUser === request.user) status.textContent = error.message || 'Could not load officials.';
    }
  }

  byId('officeReviewIssueClose').addEventListener('click', () => issueDialog.close());
  issueDialog.addEventListener('cancel', event => {
    if (issueRequest?.saving) event.preventDefault();
  });
  issueDialog.addEventListener('close', () => {
    issueRequest = null;
    issueForm.reset();
    byId('officeReviewIssueChoices').replaceChildren();
  });
  issueForm.addEventListener('submit', async event => {
    event.preventDefault();
    const request = issueRequest;
    if (!request || request.saving || currentUser !== request.user) return;
    const data = new FormData(issueForm);
    const title = data.get('title').trim();
    const description = data.get('description').trim();
    const reviewers = data.getAll('reviewer');
    const status = byId('officeReviewIssueStatus');
    if (!title || !description || !reviewers.length) {
      status.textContent = 'Enter a title and description, and choose at least one official.';
      return;
    }
    const submit = byId('officeReviewIssueSubmit');
    const close = byId('officeReviewIssueClose');
    close.disabled = submit.disabled = request.saving = true;
    status.textContent = 'Filing issue…';
    try {
      await issueRpc(request.fleet, 'file', request.driverId, { id:request.id, title, description, reviewers });
      if (issueRequest !== request || currentUser !== request.user) return;
      issueDialog.close();
      showToast('Issue filed for the selected officials.');
    } catch (error) {
      if (issueRequest === request && currentUser === request.user) status.textContent = error.message || 'Could not file the issue. Try again.';
    } finally {
      if (issueRequest === request) close.disabled = submit.disabled = request.saving = false;
    }
  });

  const routes = {
    'link-profiles':openProfileLink,'review-issue':()=>openReviewIssue(),
    hr:()=>hrTaxForms.open(employee.fleet_id),
    bol_payments:()=>fleetBolPayments.open(employee.fleet_id),
    office_messages:()=>fleetOfficeCommunications.open(),
    dispatch:()=>showOfficeDispatch('current'),drivers:()=>showOfficeDispatch('drivers'),
    equipment:()=>showOfficeDispatch('equipment'),assets:()=>showOfficeDispatch('equipment'),
    messages:()=>companyMessaging.open(),payroll:()=>officePayroll.open(),
    settlements:()=>companyDriverTools.openPayroll('Load Settlements'),safety:()=>companySafety.open(),
    hourly:openHourly,profiles:()=>{ showPage('officeProfilesPage'); return loadRoster('officeProfiles',employee.fleet_id); }
  };
  for (const tab of tabs) tab.addEventListener('click',()=>{
    if (tab.classList.contains('hidden') || !employee) return;
    const open = routes[tab.dataset.officeTool];
    if (open) void open();
    else notAvailable(tab.firstChild.textContent.trim());
  });

  function reset() {
    employee = null;
    editing = null;
    issueRequest = null;
    if (issueDialog.open) issueDialog.close();
    requests.clear();
    employeeRequest = null;
    clockRequest = null;
    clockWrite = null;
    officeShift = null;
    byId('officeClockWidget').classList.add('hidden');
    if (dialog.open) dialog.close();
    passwordForm.reset();
    clearRateForm();
    for (const id of ['officeProfilesRows','officeHourlyRows','officeProfilePermissionOptions']) byId(id).replaceChildren();
    visible('officeDashboardTools',false);
    renderTools();
  }

  return { has,canLinkProfiles,fuelSettingsFleet,readEmployee,setEmployee,refreshEmployee,messagesAllowed,openDashboard,openReviewIssue,dispatchFleet,equipmentFleet,dispatchAccess,loadRoster,updateCreateAccess,clockStatus,updateClock,reset };
})();
