const companyMessaging = (() => {
  const byId = id => document.getElementById(id);
  const channels = { dispatch: 'Dispatch', maintenance: 'Maintenance', private: 'Private' };
  const badges = ['companyDriverMessagesButton','companyFleetMessagesButton','companyDispatchMessagesButton','companyOfficeMessagesButton'];
  const when = new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
  let data;
  let contacts;
  let returnPage;
  let selected;
  let listRequest;
  let threadRequest;
  let noticeIds = new Set();
  let initialized = false;
  let draftId;
  let draftBody;
  let historySignature = '';

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function setOptions(id, choices, placeholder) {
    const select = byId(id);
    const previous = select.value;
    select.replaceChildren(new Option(placeholder, ''), ...choices.map(([value, label]) => new Option(label, value)));
    select.value = choices.some(([value]) => value === previous) ? previous : choices.length === 1 ? choices[0][0] : '';
  }

  async function rpc(action, fleet, thread, params) {
    const request = { action, ...(fleet ? {fleet} : {}), ...(thread ? {thread} : {}), ...(params ? {params} : {}) };
    const { data, error } = await supabaseClient.rpc('company_messaging',request);
    if (error) throw error;
    return data;
  }

  function showBadges() {
    const unread = (data?.threads || []).filter(thread => thread.unread);
    const ids = new Set(unread.map(thread => thread.last_message?.id || thread.id));
    if (initialized && [...ids].some(id => !noticeIds.has(id))) showToast('New company driver message.');
    noticeIds = ids;
    initialized = true;
    for (const id of badges) byId(id).textContent = unread.length ? 'Messages (' + unread.length + ')' : 'Messages';
  }

  function paintChannelChoices() {
    const fleet = data?.staff_fleet;
    const driver = contacts?.drivers.find(row => row.profile_id === byId('companyMessageRecipient').value);
    const allowed = fleet
      ? ['dispatch','maintenance'].filter(channel => fleet.scope.includes(channel)).concat(driver?.private_enabled ? ['private'] : [])
      : ['dispatch','maintenance'];
    setOptions('companyMessageChannel', allowed.map(value => [value,channels[value]]), allowed.length ? 'Choose a conversation' : 'No conversation access');
  }

  function paintAccess() {
    const profile = byId('companyPrivateDriver').value;
    const staff = byId('companyPrivateStaff').value;
    const granted = contacts?.grants.some(record => record.profile_id === profile && record.staff_id === staff) || false;
    const control = byId('companyPrivateSwitch');
    control.setAttribute('aria-pressed', String(granted));
    control.disabled = !profile || !staff;
    control.textContent = granted ? 'Revoke private messaging' : 'Grant private messaging';
    byId('companyPrivateStatus').textContent = profile && staff
      ? granted ? 'This staff member can privately message this driver.' : 'This staff member needs a grant for this driver.'
      : 'Choose a driver and a staff member.';
  }

  function paint() {
    const fleet = data.staff_fleet;
    const drivers = contacts?.drivers || [];
    byId('companyMessageStartPanel').classList.toggle('hidden', fleet ? !drivers.length : !data.linked_fleets.length);
    byId('companyMessageRecipientLabel').textContent = fleet ? 'Driver' : 'Fleet';
    setOptions('companyMessageRecipient', fleet ? drivers.map(driver => [driver.profile_id,driver.name])
      : data.linked_fleets.map(id => [id,id]), fleet ? 'Select a driver' : 'Select a fleet');
    paintChannelChoices();
    byId('companyPrivateAccessPanel').classList.toggle('hidden', !fleet?.scope.includes('official'));
    if (fleet?.scope.includes('official')) {
      setOptions('companyPrivateDriver', drivers.map(driver => [driver.profile_id,driver.name]), 'Select a driver');
      setOptions('companyPrivateStaff', contacts.staff.map(staff => [staff.id,staff.name]), 'Select a staff member');
      paintAccess();
    }
    byId('companyMessageThreads').replaceChildren(...(data.threads.length ? data.threads.map(thread => {
      const row = element('article', '', 'dispatch-load-row');
      const summary = element('div');
      summary.append(element('strong', thread.contact), element('p', [thread.fleet_id, channels[thread.kind],
        thread.unread ? 'Unread' : ''].filter(Boolean).join(' · '), 'muted'));
      if (thread.last_message) summary.append(element('p', thread.last_message.body));
      const open = element('button','Open','outline');
      open.type = 'button';
      open.addEventListener('click', () => void openThread(thread));
      row.append(summary,open);
      return row;
    }) : [element('p','No conversations yet.','muted')]));
  }

  async function readThread() {
    const user = currentUser;
    const target = selected;
    if (!user || !target || !byId('companyMessagesPage').classList.contains('active') || document.hidden) return;
    const request = {};
    threadRequest = request;
    try {
      const result = await rpc('thread',null,target.id,{mark_read:true});
      if (user !== currentUser || selected !== target || request !== threadRequest) return;
      byId('companyThreadStatus').textContent = result.can_send ? '' : 'This conversation is closed for new messages.';
      byId('companyMessageReply').classList.toggle('hidden', !result.can_send);
      const signature = JSON.stringify(result.messages.map(message => message.id));
      if (signature !== historySignature) {
        byId('companyMessageHistory').replaceChildren(...result.messages.map(message => {
          const row = element('li');
          row.dataset.own = String(message.sender_id === user.id);
          row.append(element('strong',message.sender_name),
            element('span',' · '+when.format(new Date(message.created_at)),'muted'),element('p',message.body));
          return row;
        }));
        historySignature = signature;
      }
    } catch (error) {
      if (user === currentUser && selected === target) byId('companyThreadStatus').textContent = error.message || 'Could not open this conversation.';
    } finally { if (threadRequest === request) threadRequest = null; }
  }

  async function refresh(force = false) {
    const user = currentUser;
    if (!user || !['company','fleet','employee'].includes(accountTypeFor(user)) || (!force && listRequest)) return;
    const request = {};
    listRequest = request;
    const page = byId('companyMessagesPage');
    const viewing = page.classList.contains('active') && !document.hidden;
    try {
      if (viewing && selected && !threadRequest) await readThread();
      if (user !== currentUser || listRequest !== request) return;
      const result = await rpc('list');
      const staff = viewing && result.staff_fleet;
      const contactRows = staff ? await rpc('contacts',staff.id) : null;
      if (user !== currentUser || listRequest !== request) return;
      data = result;
      contacts = contactRows;
      showBadges();
      if (viewing) {
        byId('companyMessagesStatus').textContent = '';
        if (force || !page.contains(document.activeElement) || !document.activeElement.closest('form')) paint();
      }
    } catch (error) {
      if (user === currentUser && viewing) byId('companyMessagesStatus').textContent = error.message || 'Could not load messages.';
    } finally { if (listRequest === request) listRequest = null; }
  }

  function open() {
    if (!byId('companyMessagesPage').classList.contains('active')) returnPage = document.querySelector('.page.active')?.id;
    showPage('companyMessagesPage');
    byId('companyMessagesStatus').textContent = 'Loading messages…';
    return refresh(true);
  }

  function back() {
    showPage(returnPage || (accountTypeFor(currentUser)==='fleet' ? 'fleetWorkspace' :
      accountTypeFor(currentUser)==='employee' ? 'fleetEmployeePage' : 'rigTrackerProfilePage'));
  }

  async function openThread(thread) {
    const switching = selected?.id !== thread.id;
    selected = thread;
    if (switching) {
      historySignature = '';
      draftId = null; draftBody = null;
      byId('companyMessageBody').value = '';
      byId('companyMessageHistory').replaceChildren();
    }
    byId('companyMessageThreadTitle').textContent = thread.contact + ' · ' + channels[thread.kind];
    byId('companyMessageThread').classList.remove('hidden');
    byId('companyThreadStatus').textContent = 'Loading conversation…';
    await refresh(true);
  }

  async function submit(control, run) {
    if (control.disabled) return;
    const user = currentUser;
    control.disabled = true;
    try { await run(user); } catch (error) {
      if (user === currentUser) showToast(error.message || 'Could not save the message update.');
    } finally { control.disabled = false; }
  }

  byId('companyMessageRecipient').addEventListener('change',paintChannelChoices);
  for (const id of ['companyPrivateDriver','companyPrivateStaff']) byId(id).addEventListener('change',paintAccess);
  byId('companyMessageStart').addEventListener('submit',event => {
    event.preventDefault();
    const control = event.currentTarget.querySelector('button[type="submit"]');
    void submit(control,async user => {
      const staff = data?.staff_fleet;
      const recipient = byId('companyMessageRecipient').value;
      const kind = byId('companyMessageChannel').value;
      const { id } = await rpc('start',staff?.id || recipient,null,{kind,...(staff ? {profile_id:recipient} : {})});
      if (user === currentUser) await openThread({ id, kind,
        contact: staff ? contacts.drivers.find(driver => driver.profile_id===recipient)?.name || 'Driver' : channels[kind] });
    });
  });
  byId('companyPrivateAccessForm').addEventListener('submit',event => {
    event.preventDefault();
    const control = byId('companyPrivateSwitch');
    void submit(control,async user => {
      const enabled = control.getAttribute('aria-pressed') !== 'true';
      await rpc('set_private_access',data.staff_fleet.id,null,{
        profile_id:byId('companyPrivateDriver').value,staff_id:byId('companyPrivateStaff').value,enabled
      });
      if (user === currentUser) {
        showToast(enabled ? 'Private messaging granted for this driver.' : 'Private messaging access revoked.');
        await refresh(true);
      }
    });
  });
  byId('companyMessageReply').addEventListener('submit',event => {
    event.preventDefault();
    const control = event.currentTarget.querySelector('button[type="submit"]');
    void submit(control,async user => {
      const target = selected;
      const input = byId('companyMessageBody');
      const body = input.value.trim();
      if (!body || !target) return;
      if (draftBody !== body || !draftId) { draftBody = body; draftId = crypto.randomUUID(); }
      await rpc('send',null,target.id,{body,message_id:draftId});
      if (currentUser === user && selected === target) {
        if (input.value.trim()===body) input.value='';
        draftBody = null; draftId = null;
        await refresh(true);
      }
    });
  });

  function reset() {
    data = null; contacts = null; selected = null; returnPage = null; listRequest = null; threadRequest = null;
    noticeIds = new Set(); initialized = false; historySignature = ''; draftBody = null; draftId = null;
    byId('companyMessageBody').value = '';
    byId('companyMessageThreads').replaceChildren();
    byId('companyMessageHistory').replaceChildren();
    byId('companyMessageThread').classList.add('hidden');
    for (const id of badges) byId(id).textContent = 'Messages';
  }
  setInterval(() => { if (!document.hidden) void refresh(); },10000);
  return { open, back, refresh, reset };
})();
