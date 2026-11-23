const officePayroll = (() => {
  const byId = id => document.getElementById(id);
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const payrollDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  const currency = new Intl.NumberFormat(undefined, { style:'currency', currency:'USD' });
  const dialog = byId('officePayrollShiftDialog');
  const shiftForm = byId('officePayrollShiftForm');
  const shiftSave = byId('officePayrollShiftSave');
  const shiftCancel = byId('officePayrollShiftCancel');
  const shiftStatus = byId('officePayrollShiftStatus');
  let editing;
  let request;
  let data;
  let origin;
  let fleet;

  function hours(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }

  function localDate(date) {
    const year = date.getFullYear();
    return year + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function open(targetFleet = null) {
    if (!currentUser) return;
    origin = accountTypeFor(currentUser) === 'fleet' ? 'fleet' : 'employee';
    fleet = targetFleet;
    byId('officePayrollTaxUpdates').hidden = true;
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    byId('officePayrollFrom').value ||= localDate(first);
    byId('officePayrollTo').value ||= localDate(now);
    showPage('officePayrollPage');
    return refresh();
  }

  function back() {
    if (origin === 'fleet') return showFleetSection('dashboard');
    return officeTools.openDashboard();
  }

  async function refresh(savedShift) {
    const user = currentUser;
    if (!user) return;
    const token = {};
    request = token;
    const status = byId('officePayrollStatus');
    const host = byId('officePayrollRows');
    const expanded = new Set([...host.querySelectorAll('.office-payroll-day[open]')].map(day => day.dataset.payrollDay));
    const savedKey = savedShift && savedShift.employee + ':' + savedShift.date;
    if (savedKey) expanded.add(savedKey);
    data = null;
    status.textContent = 'Loading hourly employee records…';
    host.replaceChildren();
    byId('officePayrollTotal').textContent = '';
    try {
      const { data: result, error } = await supabaseClient.rpc('fleet_employee_time_clock', {
        action: 'payroll_roster', target_fleet: fleet,
        params: { from: byId('officePayrollFrom').value, to: byId('officePayrollTo').value }
      });
      if (error) throw error;
      if (user !== currentUser || request !== token || !byId('officePayrollPage').classList.contains('active')) return;
      data = result;
      fleet = result?.fleet_id || fleet;
      payrollTaxUpdates.buttonFor(fleet,byId('officePayrollTaxUpdates'));
      const people = result?.employees || [];
      const picker = byId('officePayrollEmployee');
      const selected = picker.value;
      picker.replaceChildren(new Option('All Hourly Employees', ''), ...people.map(person =>
        new Option(person.name + ' · ' + result.fleet_id + '-' + person.employee_id, person.user_id)));
      if (people.some(person => person.user_id === selected)) picker.value = selected;
      paint(expanded);
      status.textContent = savedShift ? 'Shift saved for ' + payrollDateLabel(savedShift.date) + '.'
        : people.length ? '' : 'No hourly employees or shifts for this period.';
      if (savedKey) {
        const day = [...host.querySelectorAll('.office-payroll-day')].find(row => row.dataset.payrollDay === savedKey);
        day?.scrollIntoView({ block:'nearest' });
      }
    } catch (error) {
      if (user === currentUser && request === token) status.textContent = savedShift
        ? 'Shift saved for ' + payrollDateLabel(savedShift.date) + '. Could not reload payroll hours.'
        : error.message || 'Could not load office payroll hours.';
    }
  }

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function action(label, callback) {
    const button = element('button', label, 'outline');
    button.type = 'button';
    button.addEventListener('click', callback);
    return button;
  }

  function localDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    return localDate(date) + 'T' + String(date.getHours()).padStart(2, '0') + ':' +
      String(date.getMinutes()).padStart(2, '0');
  }

  function payrollDateLabel(date) {
    return payrollDateFormat.format(new Date(date + 'T00:00:00Z'));
  }

  function shiftError(message) {
    shiftStatus.textContent = message;
    shiftStatus.classList.toggle('hidden', !message);
  }

  function openShift(person, shift) {
    if (!fleet || !currentUser || dialog.open) return;
    const started = localDateTime(shift?.started_at);
    const ended = localDateTime(shift?.ended_at);
    editing = { user:currentUser, fleet, person, shift, started, ended, id:shift?.id || crypto.randomUUID() };
    byId('officePayrollShiftTitle').textContent = (shift ? 'Edit shift · ' : 'Add missed shift · ') + person.name;
    shiftForm.elements.payroll_date.value = shift?.payroll_date || byId('officePayrollTo').value || localDate(new Date());
    shiftForm.elements.started_at.value = started;
    shiftForm.elements.ended_at.value = ended;
    shiftSave.textContent = 'Save Shift';
    shiftError('');
    dialog.showModal();
  }

  shiftCancel.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => { if (editing?.saving) event.preventDefault(); });
  dialog.addEventListener('close', () => { editing = null; });
  shiftForm.addEventListener('input', event => {
    shiftError('');
    if (!editing) return;
    if (editing.shift) {
      const fields = shiftForm.elements;
      const dateOnly = fields.payroll_date.value !== editing.shift.payroll_date &&
        fields.started_at.value === editing.started && fields.ended_at.value === editing.ended;
      shiftSave.textContent = dateOnly ? 'Save Date' : 'Save Shift';
      return;
    }
    if (event.target.name === 'payroll_date') editing.dateChosen = true;
    if (event.target.name === 'started_at' && event.target.value && !editing.dateChosen) {
      shiftForm.elements.payroll_date.value = event.target.value.split('T')[0];
    }
  });
  shiftForm.addEventListener('submit', async event => {
    event.preventDefault();
    const edit = editing;
    if (!edit || edit.saving || !shiftForm.reportValidity()) return;
    const active = () => editing === edit && edit.user === currentUser && edit.fleet === fleet &&
      byId('officePayrollPage').classList.contains('active');
    const { payroll_date, started_at, ended_at } = Object.fromEntries(new FormData(shiftForm));
    const { shift } = edit;
    const started = started_at === edit.started ? shift?.started_at : new Date(started_at).toISOString();
    const ended = ended_at === edit.ended ? shift?.ended_at ?? null : ended_at ? new Date(ended_at).toISOString() : null;
    edit.saving = shiftSave.disabled = shiftCancel.disabled = true;
    shiftError('');
    try {
      const { data: saved, error } = await supabaseClient.rpc('fleet_employee_time_clock', {
        action:'save_payroll_shift', target_fleet:edit.fleet,
        params:{
          shift_id:edit.id, employee_user_id:edit.person.user_id, payroll_date,
          started_at:started, ended_at:ended, expected_started_at:shift?.started_at,
          expected_ended_at:shift?.ended_at, expected_payroll_date:shift?.payroll_date
        }
      });
      if (error) throw error;
      if (!active()) return;
      const date = saved?.payroll_date || payroll_date;
      const from = byId('officePayrollFrom');
      const through = byId('officePayrollTo');
      if (date < from.value || date > through.value) from.value = through.value = date;
      shiftSave.disabled = shiftCancel.disabled = false;
      dialog.close();
      void refresh({ employee:edit.person.user_id, date });
    } catch (error) {
      if (active()) shiftError(error.message || 'Could not save the shift.');
    } finally {
      edit.saving = false;
      if (editing === edit) shiftSave.disabled = shiftCancel.disabled = false;
    }
  });

  function dailyPayForm(person, date, shifts, total, saved, headline) {
    const form = element('form', '', 'office-payroll-daily-pay');
    const label = element('label', 'Hourly rate ($)', 'field');
    const rate = element('input');
    Object.assign(rate, { type:'number', min:'0', max:'9999999.99', step:'0.01', placeholder:'Optional' });
    rate.value = saved?.hourly_rate ?? '';
    label.append(rate);
    const button = element('button', 'Save Day', 'outline');
    button.type = 'submit';
    const status = element('p', '', 'muted');
    status.setAttribute('role', 'status');
    const open = shifts.some(shift => !shift.ended_at);
    const paintSaved = () => {
      const changed = saved && (Number(saved.worked_seconds) !== total || open);
      const pay = saved?.gross_pay == null || changed ? '' : ' · ' + currency.format(Number(saved.gross_pay));
      headline.textContent = hours(total) + pay;
      status.textContent = open ? 'Enter a clock-out time before saving this day.'
        : changed ? 'Hours changed since this day was saved. Save Day to update the total.'
        : saved ? 'Day saved.' : '';
    };
    button.disabled = open;
    paintSaved();
    form.append(label, button, status);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (button.disabled || !currentUser || !fleet || !form.reportValidity()) return;
      const user = currentUser;
      const targetFleet = fleet;
      const active = () => currentUser === user && fleet === targetFleet && form.isConnected &&
        byId('officePayrollPage').classList.contains('active');
      const hourlyRate = rate.value ? Number(rate.value).toFixed(2) : '';
      button.disabled = rate.disabled = true;
      status.textContent = 'Saving payroll day…';
      try {
        const { data: record, error } = await supabaseClient.rpc('fleet_employee_time_clock', {
          action:'save_payroll_day', target_fleet:targetFleet,
          params:{ employee_user_id:person.user_id, payroll_date:date, hourly_rate:hourlyRate,
            expected_seconds:total, expected_updated_at:saved?.updated_at }
        });
        if (error) throw error;
        if (!active()) return;
        saved = record;
        person.payroll_days = [...(person.payroll_days || []).filter(day => day.payroll_date !== date), record];
        paintSaved();
      } catch (error) {
        if (active()) status.textContent = error.message || 'Could not save this payroll day.';
      } finally {
        button.disabled = rate.disabled = false;
      }
    });
    return form;
  }

  function daysFor(person, expanded) {
    const days = new Map();
    const saved = new Map((person.payroll_days || []).map(day => [day.payroll_date, day]));
    for (const date of saved.keys()) days.set(date, []);
    for (const shift of person.shifts || []) {
      const key = shift.payroll_date;
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(shift);
    }
    return [...days].sort(([a], [b]) => b.localeCompare(a)).map(([date, shifts]) => {
      const day = element('details', '', 'office-payroll-day');
      day.dataset.payrollDay = person.user_id + ':' + date;
      day.open = expanded.has(day.dataset.payrollDay);
      const summary = element('summary');
      const total = shifts.reduce((sum, shift) => sum + (Number(shift.seconds) || 0), 0);
      const headline = element('strong');
      summary.append(element('time', payrollDateLabel(date)), headline);
      summary.querySelector('time').dateTime = date;
      day.append(summary);
      day.append(dailyPayForm(person, date, shifts, total, saved.get(date), headline));
      for (const shift of shifts) {
        const start = new Date(shift.started_at);
        const end = shift.ended_at ? new Date(shift.ended_at) : null;
        const describe = value => (localDate(value) !== date ? dateFormat.format(value) + ' ' : '') + timeFormat.format(value);
        const row = element('div', '', 'office-payroll-shift');
        row.append(element('span', describe(start) + ' – ' + (end ? describe(end) : 'Clocked in')),
          element('span', hours(shift.seconds)), action('Edit Shift', () => openShift(person, shift)));
        day.append(row);
      }
      return day;
    });
  }

  function paint(expanded = new Set()) {
    const people = data?.employees || [];
    const selected = byId('officePayrollEmployee').value;
    const rows = selected ? people.filter(person => person.user_id === selected) : people;
    const totalSeconds = rows.reduce((sum, person) => sum + (Number(person.seconds) || 0), 0);
    byId('officePayrollTotal').textContent = 'Hours in this period: ' + hours(totalSeconds);

    const cards = rows.map(person => {
      const card = document.createElement('section');
      card.className = 'panel office-payroll-employee';
      const heading = document.createElement('div');
      heading.className = 'office-payroll-employee-heading';
      const name = document.createElement('h2');
      name.textContent = person.name;
      const total = document.createElement('strong');
      total.textContent = hours(person.seconds);
      heading.append(name, total);
      card.append(heading);
      const identity = document.createElement('p');
      identity.className = 'muted';
      identity.textContent = [data.fleet_id + '-' + person.employee_id, person.office_role].filter(Boolean).join(' · ');
      card.append(identity);
      const actions = element('div', '', 'dispatch-actions');
      const taxEmployee = { kind:'office', reference:person.user_id, fleet:data.fleet_id, name:person.name };
      actions.append(action('Add Missed Shift', () => openShift(person)),
        action('Tax Information', () => payrollTaxPreview.open(taxEmployee)),
        action('Estimate Payroll Taxes', () => payrollTaxPreview.open({ ...taxEmployee,mode:'preview' })));
      card.append(actions);
      const days = daysFor(person, expanded);
      if (days.length) {
        const list = element('div', '', 'office-payroll-shifts');
        list.append(...days);
        card.append(list);
      } else card.append(element('p', 'No clock entries in this period.', 'muted'));
      return card;
    });
    byId('officePayrollRows').replaceChildren(...(cards.length ? cards : [
      Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No hourly employee records to display.' })
    ]));
  }

  byId('officePayrollEmployee').addEventListener('change', () => paint());
  byId('officePayrollFrom').addEventListener('change', () => void refresh());
  byId('officePayrollTo').addEventListener('change', () => void refresh());
  byId('officePayrollRefresh').addEventListener('click', () => void refresh());
  return { open, refresh, back };
})();
