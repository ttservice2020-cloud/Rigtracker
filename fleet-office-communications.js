const fleetOfficeCommunications = (() => {
  const byId = id => document.getElementById(id);
  const online = byId('fleetOnlineEmployees');
  const onlineStatus = byId('fleetOnlineStatus');
  const onlineList = byId('fleetOnlineList');
  const onlineRefresh = byId('fleetOnlineRefresh');
  const page = byId('fleetOfficeMessagesPage');
  const recipient = byId('fleetOfficeRecipient');
  const contacts = byId('fleetOfficeContactList');
  const title = byId('fleetOfficeConversationTitle');
  const status = byId('fleetOfficeMessageStatus');
  const list = byId('fleetOfficeMessageList');
  const form = byId('fleetOfficeMessageForm');
  const body = byId('fleetOfficeMessageBody');
  const send = byId('fleetOfficeMessageSend');
  const moment = new Intl.DateTimeFormat(undefined, { dateStyle:'short', timeStyle:'short' });
  let onlineRequest;
  let workspace;

  function node(tag, text, className) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  }

  function name(employee, fleetId) {
    if (employee.employee_id === null) return 'Fleet Admin';
    return [employee.first_name, employee.last_name].filter(Boolean).join(' ') || fleetId + '-' + employee.employee_id;
  }

  async function refreshOnline() {
    const user = currentUser;
    const fleetId = adminFleetId;
    if (!online.open || onlineRequest || accountTypeFor(user) !== 'fleet' || !fleetId) return;
    const request = {};
    onlineRequest = request;
    const active = () => onlineRequest === request && online.open && currentUser === user && adminFleetId === fleetId;
    onlineRefresh.disabled = true;
    if (!onlineList.childElementCount) onlineStatus.textContent = 'Loading online employees…';
    try {
      const { data, error } = await supabaseClient.rpc('fleet_online_employees', { requested_fleet_id:fleetId });
      if (!active()) return;
      if (error) throw error;
      onlineList.replaceChildren(...data.map(employee => {
        const row = node('article', '', 'dispatch-load-row');
        const label = name(employee, fleetId);
        const info = node('div');
        info.append(node('strong', label));
        if (employee.office_role) info.append(node('p', employee.office_role, 'muted'));
        const message = node('button', 'Message', 'outline');
        message.type = 'button';
        message.setAttribute('aria-label', 'Message ' + label);
        message.addEventListener('click', () => {
          online.close();
          void open(employee.employee_id);
        });
        row.append(info, message);
        return row;
      }));
      byId('fleetDashboardOnlineCount').textContent = String(data.length);
      onlineStatus.textContent = data.length ? 'Activity in the last two minutes.' : 'No employees are online.';
    } catch {
      if (active()) onlineStatus.textContent = 'Could not load online employees. Try refreshing.';
    } finally {
      if (onlineRequest === request) {
        onlineRequest = null;
        onlineRefresh.disabled = false;
      }
    }
  }

  function clearOnline() {
    onlineRequest = null;
    onlineList.replaceChildren();
    onlineStatus.textContent = '';
    onlineRefresh.disabled = false;
  }

  byId('fleetDashboardOnlineButton').addEventListener('click', () => {
    if (accountTypeFor(currentUser) !== 'fleet' || !adminFleetId || online.open) return;
    clearOnline();
    online.showModal();
    void refreshOnline();
  });
  byId('fleetOnlineClose').addEventListener('click', () => online.close());
  byId('fleetOnlineRefresh').addEventListener('click', () => void refreshOnline());
  online.addEventListener('close', () => { if (!online.open) clearOnline(); });

  function active(scope) {
    return workspace === scope && currentUser === scope.user && page.classList.contains('active');
  }

  function setSendPending(scope, pending) {
    scope.sending = pending;
    if (workspace !== scope || currentUser !== scope.user) return;
    send.disabled = body.disabled = recipient.disabled = pending;
  }

  function paintContacts(scope) {
    const query = recipient.value.trim().toLowerCase();
    const groups = new Map();
    for (const employee of scope.employees) {
      const role = employee.office_role || 'Office';
      const label = name(employee, scope.fleetId);
      if (![label, role].some(value => value.toLowerCase().includes(query))) continue;
      if (!groups.has(role)) {
        const group = node('section', '', 'dispatch-load-list');
        group.append(node('h3', role));
        groups.set(role, group);
      }
      const contact = node('button', label, 'outline message-contact');
      contact.type = 'button';
      contact.setAttribute('aria-pressed', String(scope.contactId === employee.employee_id));
      contact.addEventListener('click', () => {
        if (!active(scope) || scope.sending || scope.contactId === employee.employee_id) return;
        void select(scope, employee);
      });
      groups.get(role).append(contact);
    }
    contacts.replaceChildren(...(groups.size ? groups.values() : [node('p', 'No matching office contacts.', 'muted')]));
  }

  async function read(scope, quiet = false) {
    if (!active(scope) || !scope.thread || scope.reading) return;
    const { employeeId, peerId } = scope.thread;
    const request = {};
    scope.reading = request;
    const current = () => active(scope) && scope.reading === request;
    if (!quiet) status.textContent = 'Loading messages…';
    try {
      const rows = supabaseClient.from('fleet_office_messages')
        .select('id,sender_id,body,created_at').eq('fleet_id', scope.fleetId).eq('employee_id', employeeId);
      const { data, error } = await (peerId ? rows.eq('peer_employee_id', peerId) : rows.is('peer_employee_id', null))
        .order('created_at', { ascending:false }).order('id', { ascending:false }).limit(100);
      if (!current()) return;
      if (error) throw error;
      const signature = data.map(row => row.id).join(',');
      if (signature !== scope.signature) {
        scope.signature = signature;
        list.replaceChildren(...data.slice().reverse().map(row => {
          const card = node('article', '', 'panel');
          const sender = row.sender_id === scope.user.id ? 'You' : scope.contact;
          const date = Date.parse(row.created_at);
          card.append(node('strong', sender), node('p', row.body, 'fleet-office-message-body'));
          if (Number.isFinite(date)) card.append(node('p', moment.format(date), 'muted'));
          return card;
        }));
      }
      status.textContent = data.length ? '' : 'No messages yet.';
    } catch {
      if (current()) status.textContent = 'Could not load messages. Try refreshing.';
    } finally {
      if (scope.reading === request) scope.reading = null;
    }
  }

  function select(scope, employee) {
    scope.contactId = employee?.employee_id;
    const members = [scope.self, scope.contactId].filter(id => id != null).sort();
    scope.thread = employee ? { employeeId:members[0], peerId:members[1] ?? null } : null;
    scope.contact = employee ? name(employee, scope.fleetId) : '';
    scope.reading = null;
    scope.signature = null;
    scope.messageIds.clear();
    title.textContent = scope.contact;
    body.value = '';
    list.replaceChildren();
    form.classList.toggle('hidden', !employee);
    paintContacts(scope);
    if (employee) return read(scope);
    status.textContent = scope.employees.length ? 'Choose an office contact to open a conversation.' : 'No active office contacts yet.';
  }

  async function open(employeeId = '') {
    const user = currentUser;
    const role = accountTypeFor(user);
    if (!user || !['fleet','employee'].includes(role)) return;
    if (role === 'fleet' && !adminFleetId) return showToast('Set up your Fleet ID to use office messages.');
    const fromDrivers = byId('companyMessagesPage').classList.contains('active');
    const scopeIsCurrent = workspace?.user === user && workspace.employees.length &&
      (role === 'employee' || workspace.fleetId === adminFleetId);
    if (fromDrivers && scopeIsCurrent && !employeeId) {
      showPage('fleetOfficeMessagesPage');
      byId('fleetOfficeMessagesTab').focus();
      return read(workspace, true);
    }
    const scope = { user, fleetId:adminFleetId, employees:[], messageIds:new Map() };
    workspace = scope;
    byId('fleetOfficeDriverMessagesTab').disabled = role === 'employee' && !officeTools.messagesAllowed();
    recipient.value = '';
    contacts.replaceChildren();
    form.classList.add('hidden');
    title.textContent = body.value = '';
    list.replaceChildren();
    showPage('fleetOfficeMessagesPage');
    if (fromDrivers) byId('fleetOfficeMessagesTab').focus();
    setSendPending(scope, false);
    status.textContent = 'Loading office message board…';
    try {
      const { data, error } = await supabaseClient.rpc('fleet_office_message_contacts', {
        requested_fleet_id:role === 'fleet' ? scope.fleetId : null
      });
      if (!active(scope)) return;
      if (error) throw error;
      scope.fleetId = data.fleet_id;
      scope.self = data.employee_id;
      scope.employees = scope.self === null ? data.contacts : [{ employee_id:null, office_role:'Fleet Admin' }, ...data.contacts];
      const chosen = scope.employees.find(row => row.employee_id === (scope.self !== null && employeeId === '' ? null : employeeId));
      return select(scope, chosen);
    } catch {
      if (active(scope)) status.textContent = 'Could not open Office Messages. Reopen the board to try again.';
    }
  }

  recipient.addEventListener('input', () => {
    const scope = workspace;
    if (!scope || !active(scope)) return;
    paintContacts(scope);
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const scope = workspace;
    const message = body.value.trim();
    if (!scope || !active(scope) || scope.sending || !scope.thread || !message) return;
    if (!scope.messageIds.has(message)) scope.messageIds.set(message, crypto.randomUUID());
    setSendPending(scope, true);
    try {
      const { error } = await supabaseClient.from('fleet_office_messages').insert({
        id:scope.messageIds.get(message), fleet_id:scope.fleetId,
        employee_id:scope.thread.employeeId, peer_employee_id:scope.thread.peerId, body:message
      });
      if (workspace !== scope || currentUser !== scope.user) return;
      if (error && error.code !== '23505') throw error;
      body.value = '';
      scope.messageIds.clear();
      scope.reading = null;
      if (active(scope)) await read(scope);
    } catch {
      if (active(scope)) status.textContent = 'Could not send the message. Your draft is still here.';
    } finally {
      setSendPending(scope, false);
    }
  });

  function back() {
    if (accountTypeFor(currentUser) === 'fleet') void showFleetSection('dashboard');
    else void officeTools.openDashboard();
  }
  byId('fleetOfficeMessageBack').addEventListener('click', back);
  byId('fleetOfficeMessageRefresh').addEventListener('click', () => {
    if (workspace) void read(workspace);
  });
  setInterval(() => {
    if (workspace && !document.hidden && !workspace.sending) void read(workspace, true);
  }, 20000);

  function reset() {
    workspace = null;
    if (online.open) online.close();
    clearOnline();
    recipient.value = '';
    contacts.replaceChildren();
    list.replaceChildren();
    title.textContent = status.textContent = body.value = '';
  }

  return { open, back, onlineOpen:() => online.open, refreshOnline, reset };
})();
