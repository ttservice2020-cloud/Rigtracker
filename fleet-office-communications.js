const fleetOfficeCommunications = (() => {
  const byId = id => document.getElementById(id);
  const online = byId('fleetOnlineEmployees');
  const onlineStatus = byId('fleetOnlineStatus');
  const onlineList = byId('fleetOnlineList');
  const onlineRefresh = byId('fleetOnlineRefresh');
  const page = byId('fleetOfficeMessagesPage');
  const picker = byId('fleetOfficeContacts');
  const contactsButton = byId('fleetOfficeContactsButton');
  const contactsStatus = byId('fleetOfficeContactsStatus');
  const contactsRetry = byId('fleetOfficeContactsRetry');
  const contacts = byId('fleetOfficeContactList');
  const contactsContent = byId('fleetOfficeContactsContent');
  const desktopColumn = byId('fleetOfficeContactsColumn');
  const mobileContacts = byId('fleetOfficeContactsMobile');
  const desktop = window.matchMedia('(min-width: 760px)');
  const title = byId('fleetOfficeConversationTitle');
  const status = byId('fleetOfficeMessageStatus');
  const refreshButton = byId('fleetOfficeMessageRefresh');
  const list = byId('fleetOfficeMessageList');
  const form = byId('fleetOfficeMessageForm');
  const body = byId('fleetOfficeMessageBody');
  const send = byId('fleetOfficeMessageSend');
  const notice = byId('fleetOfficeMessageNotice');
  const announcement = byId('fleetOfficeMessageAnnouncement');
  const unreadBadges = [...document.querySelectorAll('[data-office-unread]')];
  const moment = new Intl.DateTimeFormat(undefined, { dateStyle:'short', timeStyle:'short' });
  let onlineRequest;
  let workspace;
  let noticeState;
  let noticeRequest;
  let pendingNotice;
  let noticeTimeout;

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
    send.disabled = body.disabled = contactsButton.disabled = pending;
  }

  function contactsFrom(data) {
    if (data.employee_id === null) return data.contacts;
    return [{ employee_id:null, office_role:'Fleet Admin', last_message:data.admin_last_message,
      unread_message_id:data.admin_unread_message_id }, ...data.contacts];
  }

  function updateBadges(count) {
    for (const badge of unreadBadges) {
      badge.textContent = count || '';
      badge.classList.toggle('hidden', !count);
      if (count) badge.parentElement.setAttribute('aria-label', 'Office Messages, ' + count + ' unread');
      else badge.parentElement.removeAttribute('aria-label');
    }
  }

  function dismissNotice() {
    clearTimeout(noticeTimeout);
    pendingNotice = null;
    notice.classList.add('hidden');
    notice.textContent = announcement.textContent = '';
  }

  function updateNotifications(scope, employees) {
    const unread = employees.filter(employee => employee.unread_message_id);
    updateBadges(unread.length);
    const sameAccount = noticeState?.userId === scope.user.id && noticeState.fleetId === scope.fleetId;
    if (!sameAccount) noticeState = { userId:scope.user.id, fleetId:scope.fleetId, messages:new Map() };
    if (pendingNotice && !unread.some(employee => employee.unread_message_id === pendingNotice.messageId)) dismissNotice();
    const fresh = unread.filter(employee => noticeState.messages.get(employee.employee_id) !== employee.unread_message_id);
    for (const employee of unread) noticeState.messages.set(employee.employee_id, employee.unread_message_id);
    if (!sameAccount || document.hidden) return;
    const next = fresh.find(employee => !(workspace && active(workspace) && !picker.open && workspace.contactId === employee.employee_id));
    if (!next) return;
    dismissNotice();
    pendingNotice = { user:scope.user, employeeId:next.employee_id, messageId:next.unread_message_id };
    notice.textContent = announcement.textContent = 'New office message from ' + name(next, scope.fleetId);
    notice.classList.remove('hidden');
    noticeTimeout = setTimeout(dismissNotice, 8000);
  }

  async function refreshNotifications(force = false) {
    const user = currentUser;
    if (!user || document.hidden) return;
    const role = accountTypeFor(user);
    if (!['fleet','employee'].includes(role) || (role === 'fleet' && !adminFleetId)) return;
    if (workspace && active(workspace)) return loadContacts(workspace, force);
    if (noticeRequest?.user === user && !force) return;
    const requestedFleet = role === 'fleet' ? adminFleetId : null;
    const request = { user };
    noticeRequest = request;
    try {
      const { data, error } = await supabaseClient.rpc('fleet_office_message_contacts', { requested_fleet_id:requestedFleet });
      if (error || !data || currentUser !== user || noticeRequest !== request || (workspace && active(workspace))) return;
      if (requestedFleet && requestedFleet !== adminFleetId) return;
      updateNotifications({ user, fleetId:data.fleet_id }, contactsFrom(data));
    } catch {
      // The next visible refresh will retry.
    } finally {
      if (noticeRequest === request) noticeRequest = null;
    }
  }

  notice.addEventListener('click', () => {
    const selection = pendingNotice;
    dismissNotice();
    if (selection && selection.user === currentUser) void open(selection.employeeId);
  });

  function paintContacts(scope) {
    const signature = JSON.stringify([scope.contactId, scope.employees]);
    if (scope.contactsSignature === signature) return;
    scope.contactsSignature = signature;
    const focusedContact = contacts.contains(document.activeElement) && document.activeElement.dataset.contact;
    const ordered = [...scope.employees].sort((a,b) =>
      (Date.parse(b.last_message?.created_at) || 0) - (Date.parse(a.last_message?.created_at) || 0));
    const groups = new Map();
    for (const employee of ordered) {
      const role = employee.office_role?.trim() || 'Office';
      const label = name(employee, scope.fleetId);
      if (!groups.has(role)) {
        const group = node('section', '', 'office-contact-role');
        group.append(node('h3', role));
        groups.set(role, group);
      }
      const contact = node('button', '', 'office-contact-row');
      contact.type = 'button';
      contact.dataset.contact = employee.employee_id ?? 'admin';
      contact.dataset.unread = String(Boolean(employee.unread_message_id));
      contact.setAttribute('aria-label', label);
      contact.setAttribute('aria-pressed', String(scope.contactId === employee.employee_id));
      contact.append(node('strong', label));
      if (employee.last_message?.body) {
        const message = employee.last_message;
        const preview = node('small', (message.own ? 'You: ' : '') + message.body.trim().replace(/\s+/g, ' '));
        preview.id = 'officeContactPreview-' + contact.dataset.contact;
        contact.setAttribute('aria-describedby', preview.id);
        contact.append(preview);
      }
      if (employee.unread_message_id) {
        const unread = node('span', 'Unread message');
        unread.hidden = true;
        unread.id = 'officeContactUnread-' + contact.dataset.contact;
        contact.append(unread);
        contact.setAttribute('aria-describedby', [unread.id, contact.getAttribute('aria-describedby')].filter(Boolean).join(' '));
      }
      contact.addEventListener('click', () => {
        if (!active(scope) || scope.sending) return;
        if (picker.open) picker.close();
        if (scope.contactId !== employee.employee_id) void select(scope, employee);
        if (!desktop.matches) title.focus();
      });
      groups.get(role).append(contact);
    }
    const sections = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
    contacts.replaceChildren(...sections.map(([, section]) => section));
    if (focusedContact) {
      [...contacts.querySelectorAll('button')].find(button => button.dataset.contact === focusedContact)?.focus({ preventScroll:true });
    }
  }

  function atLatestMessage() {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  async function markDisplayed(scope) {
    if (!active(scope) || document.hidden || picker.open || !atLatestMessage() || !scope.latestMessage ||
        scope.marking || scope.lastMarked === scope.latestMessage) return;
    const messageId = scope.latestMessage;
    const thread = scope.thread;
    scope.marking = messageId;
    try {
      const { error } = await supabaseClient.rpc('mark_fleet_office_message_read', { displayed_message_id:messageId });
      if (!error && active(scope) && scope.thread === thread) {
        scope.lastMarked = messageId;
        void loadContacts(scope, true);
      }
    } catch {
      // Retry when the conversation refreshes.
    } finally {
      if (scope.marking === messageId) scope.marking = null;
    }
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
        const following = scope.signature == null || atLatestMessage();
        scope.signature = signature;
        list.replaceChildren(...data.slice().reverse().map(row => {
          const card = node('li');
          const own = row.sender_id === scope.user.id;
          card.dataset.own = String(own);
          const sender = own ? 'You' : scope.contact;
          const date = Date.parse(row.created_at);
          card.append(node('strong', sender));
          if (Number.isFinite(date)) card.append(node('span', ' · ' + moment.format(date), 'muted'));
          card.append(node('p', row.body));
          return card;
        }));
        if (following) list.scrollTop = list.scrollHeight;
      }
      status.textContent = data.length ? '' : 'No messages yet.';
      scope.latestMessage = data[0]?.id;
      void markDisplayed(scope);
    } catch {
      if (current()) status.textContent = 'Could not load messages. Try refreshing.';
    } finally {
      if (scope.reading === request) scope.reading = null;
    }
  }

  function select(scope, employee) {
    scope.contactId = employee.employee_id;
    const members = [scope.self, scope.contactId].filter(id => id != null).sort();
    scope.thread = { employeeId:members[0], peerId:members[1] ?? null };
    scope.contact = name(employee, scope.fleetId);
    scope.reading = null;
    scope.latestMessage = scope.lastMarked = scope.marking = null;
    scope.signature = null;
    scope.messageIds.clear();
    title.textContent = scope.contact;
    body.value = '';
    list.replaceChildren();
    form.classList.remove('hidden');
    refreshButton.classList.remove('hidden');
    paintContacts(scope);
    return read(scope);
  }

  async function loadContacts(scope, force = false) {
    if (!active(scope) || (scope.contactsRequest && !force)) return;
    const request = {};
    scope.contactsRequest = request;
    const current = () => active(scope) && scope.contactsRequest === request;
    contactsRetry.classList.add('hidden');
    if (!scope.contactsLoaded) contactsStatus.textContent = 'Loading office contacts…';
    try {
      const { data, error } = await supabaseClient.rpc('fleet_office_message_contacts', {
        requested_fleet_id:scope.requestedFleet
      });
      if (!current()) return;
      if (error) throw error;
      scope.fleetId = data.fleet_id;
      scope.self = data.employee_id;
      scope.employees = contactsFrom(data);
      scope.contactsLoaded = true;
      contactsStatus.textContent = scope.employees.length ? '' : 'No active office contacts yet.';
      paintContacts(scope);
      updateNotifications(scope, scope.employees);
    } catch {
      if (!current()) return;
      contactsStatus.textContent = 'Could not load office contacts.';
      contactsRetry.classList.remove('hidden');
    } finally {
      if (scope.contactsRequest === request) scope.contactsRequest = null;
    }
  }

  function openPicker() {
    const scope = workspace;
    if (!scope || !active(scope) || scope.sending || picker.open || desktop.matches) return;
    contactsButton.focus({ preventScroll:true });
    picker.showModal();
    byId('fleetOfficeContactsTitle').focus();
  }

  function placeContacts() {
    if (desktop.matches && picker.open) picker.close();
    (desktop.matches ? desktopColumn : mobileContacts).append(contactsContent);
  }
  desktop.addEventListener('change', placeContacts);
  placeContacts();

  async function open(employeeId) {
    const user = currentUser;
    const role = accountTypeFor(user);
    if (!user || !['fleet','employee'].includes(role)) return;
    if (role === 'fleet' && !adminFleetId) return showToast('Set up your Fleet ID to use office messages.');
    const scope = { user, requestedFleet:role === 'fleet' ? adminFleetId : null, employees:[], messageIds:new Map() };
    workspace = scope;
    if (picker.open) picker.close();
    contacts.replaceChildren();
    form.classList.add('hidden');
    refreshButton.classList.add('hidden');
    title.textContent = body.value = '';
    status.textContent = 'Choose an office contact to open a conversation.';
    list.replaceChildren();
    showPage('fleetOfficeMessagesPage');
    setSendPending(scope, false);
    if (employeeId === undefined) {
      openPicker();
      return loadContacts(scope);
    }
    await loadContacts(scope);
    if (!active(scope) || picker.open) return;
    const chosen = scope.employees.find(row => row.employee_id === employeeId);
    if (!chosen) return openPicker();
    const conversation = select(scope, chosen);
    title.focus();
    return conversation;
  }

  contactsButton.addEventListener('click', openPicker);
  byId('fleetOfficeContactsClose').addEventListener('click', () => picker.close());
  contactsRetry.addEventListener('click', () => { if (workspace) void loadContacts(workspace); });
  list.addEventListener('scroll', () => { if (workspace) void markDisplayed(workspace); });
  picker.addEventListener('close', () => { if (!picker.open && workspace) void markDisplayed(workspace); });

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
      if (active(scope)) await Promise.all([read(scope), loadContacts(scope, true)]);
    } catch {
      if (active(scope)) status.textContent = 'Could not send the message. Your draft is still here.';
    } finally {
      setSendPending(scope, false);
    }
  });

  function back() {
    if (picker.open) picker.close();
    if (accountTypeFor(currentUser) === 'fleet') void showFleetSection('dashboard');
    else void officeTools.openDashboard();
  }
  byId('fleetOfficeMessageBack').addEventListener('click', back);
  refreshButton.addEventListener('click', () => {
    if (workspace) void Promise.all([read(workspace), loadContacts(workspace, true)]);
  });
  function messageArrived() {
    const scope = workspace;
    if (!scope || !active(scope)) return refreshNotifications(true);
    scope.reading = null;
    return Promise.all([read(scope, true), refreshNotifications(true)]);
  }

  setInterval(() => {
    if (document.hidden || !messageRealtime.shouldPoll('office_message')) return;
    void refreshNotifications();
    if (workspace && !workspace.sending) void read(workspace, true);
  }, 20000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    void refreshNotifications();
    if (workspace) void read(workspace, true);
  });

  function reset() {
    workspace = null;
    noticeRequest = noticeState = null;
    dismissNotice();
    updateBadges(0);
    if (online.open) online.close();
    if (picker.open) picker.close();
    clearOnline();
    contacts.replaceChildren();
    list.replaceChildren();
    title.textContent = status.textContent = body.value = '';
  }

  return { open, refreshNotifications, messageArrived, onlineOpen:() => online.open, refreshOnline, reset };
})();
