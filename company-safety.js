const companySafety = (() => {
  const byId = id => document.getElementById(id);
  const form = byId('companySafetyForm');
  const storageBucket = 'company-safety-documents';
  const kinds = { dot_inspection: 'DOT inspection', ticket: 'Ticket or citation', accident: 'Accident', other: 'Other safety report' };
  const extensions = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
    'image/heif': 'heif', 'application/pdf': 'pdf'
  };
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  let request;
  let draft;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(label, action) {
    const control = element('button', label, 'outline');
    control.type = 'button';
    control.addEventListener('click', () => void action(control));
    return control;
  }

  async function rpc(action, id, payload) {
    const args = { action, ...(id ? { report_id: id } : {}), ...(payload ? { payload } : {}) };
    const { data, error } = await supabaseClient.rpc('company_safety', args);
    if (error) throw error;
    return data;
  }

  async function openAttachment(path) {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { showToast('Allow a new tab to view the attachment.'); return; }
    tab.opener = null;
    const user = currentUser;
    try {
      const { data, error } = await supabaseClient.storage.from(storageBucket).createSignedUrl(path,120);
      if (error || !data?.signedUrl || user !== currentUser) throw error || new Error();
      tab.location.replace(data.signedUrl);
    } catch {
      tab.close();
      if (user === currentUser) showToast('Could not open the attachment.');
    }
  }

  async function review(control, report) {
    const user = currentUser;
    control.disabled = true;
    try {
      await rpc('review', report.id);
      if (user === currentUser) {
        showToast('Report marked reviewed.');
        await refresh();
      }
    } catch (error) {
      if (user === currentUser) showToast(error.message || 'Could not mark the report reviewed.');
    } finally { control.disabled = false; }
  }

  function paint(result) {
    const select = byId('companySafetyFleet');
    const previous = select.value;
    const fleets = result.linked_fleets;
    const rows = result.reports.map(report => {
      const card = element('article', '', 'dispatch-load-row company-safety-row');
      const details = element('div');
      const day = new Date(report.incident_date + 'T00:00:00Z');
      const title = result.staff ? report.driver_name + ' · ' + kinds[report.category] : kinds[report.category];
      details.append(element('strong', title), element('p',
        [report.fleet_id, date.format(day), report.reviewed_at ? 'Reviewed' : 'Awaiting fleet review'].join(' · ')));
      if (report.notes) details.append(element('p', report.notes, 'company-safety-notes'));
      card.append(details);
      const actions = element('div', '', 'dispatch-actions');
      if (report.document) actions.append(button('Open Attachment', () => openAttachment(report.document)));
      if (result.staff && !report.reviewed_at) actions.append(button('Mark Reviewed', control => review(control, report)));
      if (actions.childElementCount) card.append(actions);
      return card;
    });
    form.classList.toggle('hidden', result.staff || !fleets.length);
    select.replaceChildren(new Option('Choose a fleet', ''), ...fleets.map(fleet => new Option(fleet, fleet)));
    select.value = fleets.includes(previous) ? previous : fleets.length === 1 ? fleets[0] : '';
    byId('companySafetyStatus').textContent = result.staff || fleets.length ? '' : 'Link to a fleet to send a safety report.';
    byId('companySafetyListTitle').textContent = result.staff ? 'Fleet safety reports' : 'Your safety reports';
    byId('companySafetyReports').replaceChildren(...(rows.length ? rows : [element('p', 'No safety reports yet.', 'muted')]));
  }

  async function refresh() {
    const user = currentUser;
    if (!user || !byId('companySafetyPage').classList.contains('active')) return;
    const token = {};
    request = token;
    try {
      const result = await rpc('list');
      if (user === currentUser && token === request) paint(result);
    } catch (error) {
      if (user === currentUser && token === request) byId('companySafetyStatus').textContent = error.message || 'Could not load safety reports.';
    }
  }

  function open() {
    const role = accountTypeFor(currentUser);
    if (!currentUser || !['company','driver','fleet','employee'].includes(role)) return;
    const hasReports = role !== 'driver';
    byId('companySafetyReportPanel').classList.toggle('hidden', !hasReports);
    byId('companySafetyRefresh').classList.toggle('hidden', !hasReports);
    byId('companySafetyStatus').textContent = hasReports ? 'Loading safety reports…' : '';
    showPage('companySafetyPage');
    void hazmatReference.search();
    if (hasReports) return refresh();
  }

  function back() {
    const role = accountTypeFor(currentUser);
    if (role === 'fleet') return showFleetSection('dashboard');
    if (role === 'driver') return showPage('dashboardPage');
    showPage(role === 'company' ? 'rigTrackerProfilePage' : 'fleetEmployeePage');
  }

  async function refreshOfficeAccess() {
    const user = currentUser;
    if (!user || accountTypeFor(user) !== 'employee') return;
    try {
      const allowed = await rpc('access');
      if (user === currentUser) byId('companyOfficeSafetyButton').classList.toggle('hidden', !allowed);
    } catch {
      if (user === currentUser) byId('companyOfficeSafetyButton').classList.add('hidden');
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const user = currentUser;
    const control = form.querySelector('button[type="submit"]');
    if (!user || accountTypeFor(user) !== 'company' || control.disabled) return;
    const {fleet, category, incident_date, notes: enteredNotes} = Object.fromEntries(new FormData(form));
    const notes = enteredNotes.trim();
    const file = byId('companySafetyFile').files[0];
    const extension = extensions[file?.type];
    if (file && (!extension || !file.size || file.size > 10485760)) { showToast('Choose a supported photo or PDF up to 10 MB.'); return; }
    if (!notes && !file) { showToast('Add notes or attach a document.'); return; }
    const signature = JSON.stringify([fleet,category,incident_date,notes]);
    if (!draft || draft.signature !== signature || draft.file !== file) {
      const id = crypto.randomUUID();
      draft = {id, signature, file, path: file ? fleet + '/' + user.id + '/' + id + '.' + extension : null, uploaded: false};
    }
    const pending = draft;
    control.disabled = true;
    try {
      if (file && !pending.uploaded) {
        const { error } = await supabaseClient.storage.from(storageBucket).upload(pending.path,file,{contentType:file.type});
        if (error && error.statusCode !== '409') throw error;
        pending.uploaded = true;
      }
      if (user !== currentUser || draft !== pending) return;
      await rpc('report', pending.id, {fleet,category,incident_date,notes,document:pending.path});
      if (user !== currentUser || draft !== pending) return;
      draft = null;
      form.reset();
      showToast('Safety report sent to ' + fleet + '.');
      await refresh();
    } catch (error) {
      if (user === currentUser) showToast(error.message || 'Could not send the safety report.');
    } finally { control.disabled = false; }
  });

  function reset() {
    draft = null;
    request = null;
    form.reset();
    form.classList.add('hidden');
    byId('companyOfficeSafetyButton').classList.add('hidden');
    byId('companySafetyFleet').replaceChildren();
    byId('companySafetyReports').replaceChildren();
    byId('companySafetyStatus').textContent = '';
    hazmatReference.reset();
  }

  return { open, back, refresh, refreshOfficeAccess, reset };
})();
