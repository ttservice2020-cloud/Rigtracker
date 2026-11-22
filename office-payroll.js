const officePayroll = (() => {
  const byId = id => document.getElementById(id);
  const dateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const payrollDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  const pendingDates = new Set();
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

  async function refresh() {
    const user = currentUser;
    if (!user) return;
    const token = {};
    request = token;
    const status = byId('officePayrollStatus');
    const host = byId('officePayrollRows');
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
      const people = result?.employees || [];
      const picker = byId('officePayrollEmployee');
      const selected = picker.value;
      picker.replaceChildren(new Option('All Hourly Employees', ''), ...people.map(person =>
        new Option(person.name + ' · ' + result.fleet_id + '-' + person.employee_id, person.user_id)));
      if (people.some(person => person.user_id === selected)) picker.value = selected;
      paint();
      status.textContent = people.length ? '' : 'No hourly employees or shifts for this period.';
    } catch (error) {
      if (user === currentUser && request === token) status.textContent = error.message || 'Could not load office payroll hours.';
    }
  }

  function editPayrollDate(shift) {
    const originalDate = shift.payroll_date;
    const form = document.createElement('form');
    form.className = 'office-payroll-date-editor';
    const label = document.createElement('label');
    label.className = 'field';
    label.textContent = 'Payroll date';
    const date = document.createElement('input');
    date.type = 'date';
    date.value = originalDate;
    date.required = true;
    label.append(date);
    const save = document.createElement('button');
    save.type = 'submit';
    save.className = 'outline';
    save.textContent = 'Save date';
    const feedback = document.createElement('span');
    feedback.setAttribute('role', 'alert');
    const updateControls = () => {
      date.disabled = pendingDates.has(shift.id);
      save.disabled = date.disabled || !date.value || date.value === originalDate;
    };
    updateControls();
    date.addEventListener('input', () => {
      feedback.textContent = '';
      updateControls();
    });
    form.append(label, save, feedback);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (save.disabled || !currentUser || !fleet) return;
      const user = currentUser;
      const targetFleet = fleet;
      const selectedDate = date.value;
      const current = () => currentUser === user && fleet === targetFleet && byId('officePayrollPage').classList.contains('active');
      pendingDates.add(shift.id);
      updateControls();
      feedback.textContent = '';
      try {
        const { error } = await supabaseClient.rpc('fleet_employee_time_clock', {
          action: 'set_payroll_date', target_fleet: targetFleet,
          params: { shift_id: shift.id, payroll_date: selectedDate, expected_payroll_date: originalDate }
        });
        if (error) throw error;
        if (!current()) return;
        pendingDates.delete(shift.id);
        const formatted = payrollDateFormat.format(new Date(selectedDate + 'T00:00:00Z'));
        showToast('Shift assigned to ' + formatted + '.');
        await refresh();
      } catch (error) {
        if (current()) feedback.textContent = error.message || 'Could not save the payroll date.';
      } finally {
        pendingDates.delete(shift.id);
        updateControls();
      }
    });
    return form;
  }

  function paint() {
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
      const shifts = person.shifts || [];
      if (!shifts.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'No clock entries in this period.';
        card.append(empty);
      } else {
        const list = document.createElement('div');
        list.className = 'office-payroll-shifts';
        for (const shift of shifts) {
          const line = document.createElement('div');
          line.className = 'office-payroll-shift';
          const start = new Date(shift.started_at);
          const end = shift.ended_at ? new Date(shift.ended_at) : null;
          const date = document.createElement('strong');
          date.textContent = dateFormat.format(start);
          const range = document.createElement('span');
          const endDate = end && localDate(end) !== localDate(start) ? dateFormat.format(end) + ' ' : '';
          range.textContent = timeFormat.format(start) + ' – ' + (end ? endDate + timeFormat.format(end) : 'Clocked in');
          const elapsed = document.createElement('span');
          elapsed.textContent = hours(shift.seconds);
          line.append(date, range, elapsed);
          if (shift.payroll_date) line.append(editPayrollDate(shift));
          list.append(line);
        }
        card.append(list);
      }
      return card;
    });
    byId('officePayrollRows').replaceChildren(...(cards.length ? cards : [
      Object.assign(document.createElement('p'), { className: 'muted', textContent: 'No hourly employee records to display.' })
    ]));
  }

  byId('officePayrollEmployee').addEventListener('change', paint);
  byId('officePayrollFrom').addEventListener('change', () => void refresh());
  byId('officePayrollTo').addEventListener('change', () => void refresh());
  byId('officePayrollRefresh').addEventListener('click', () => void refresh());
  return { open, refresh, back };
})();
