const companyMessaging = (() => {
  const byId = id => document.getElementById(id);
  const teamChannels = ['dispatch', 'maintenance', 'safety'];
  const channels = { dispatch: 'Dispatch', maintenance: 'Maintenance', safety: 'Safety', private: 'Private' };
  const badges = ['companyDriverMessagesButton','companyFleetMessagesButton','companyDispatchMessagesButton','companyOfficeMessagesButton'];
  const when = new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
  const imageBucket = 'company-message-images';
  const imageExtensions = { 'image/jpeg':'jpg', 'image/png':'png', 'image/webp':'webp', 'image/gif':'gif', 'image/heic':'heic', 'image/heif':'heif' };
  let data;
  let contacts;
  let returnPage;
  let selected;
  let listRequest;
  let threadRequest;
  let noticeIds = new Set();
  let noticeTimer;
  let notifiedThread;
  let initialized = false;
  let draftId;
  let draftBody;
  let draftPhoto;
  let historySignature = '';
  let mechanicFleet;
  let teamRequest;
  let expandedDriverKey;
  let driverListSignature;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function clearPhoto() {
    if (draftPhoto) URL.revokeObjectURL(draftPhoto.preview);
    draftPhoto = null;
    byId('companyMessagePhoto').value = '';
    byId('companyMessageCamera').value = '';
    showPhotoOptions(false);
    byId('companyMessagePhotoPreview').removeAttribute('src');
    byId('companyMessagePhotoDraft').classList.add('hidden');
  }

  function messagePhoto(url) {
    if (!url) return element('p', 'Photo unavailable.', 'muted');
    const button = element('button', '', 'company-message-image');
    button.type = 'button';
    button.setAttribute('aria-label', 'Enlarge photo');
    button.setAttribute('aria-expanded', 'false');
    const image = element('img');
    image.loading = 'lazy';
    image.alt = 'Message attachment';
    image.addEventListener('error', () => button.replaceWith(element('p', 'Photo unavailable.', 'muted')), { once: true });
    image.src = url;
    button.append(image);
    button.addEventListener('click', () => {
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded', String(expanded));
      button.setAttribute('aria-label', expanded ? 'Shrink photo' : 'Enlarge photo');
    });
    return button;
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

  async function dispatchRecipients(fleet) {
    const result = await rpc('contacts', fleet);
    return result.drivers;
  }

  async function sendDispatchMessage(fleet, profileId, body, messageId, isCurrent) {
    const { id } = await rpc('start', fleet, null, { kind: 'dispatch', profile_id: profileId });
    if (!isCurrent()) return;
    await rpc('send', null, id, { body, message_id: messageId });
  }

  function watchedProfiles() {
    try {
      const raw = localStorage.getItem('rigtracker-message-watch:' + (currentUser?.id || ''));
      return raw == null ? null : new Set(JSON.parse(raw));
    } catch { return null; }
  }

  function watchedThreads(threads) {
    const profiles = watchedProfiles();
    return profiles === null ? threads : threads.filter(thread => profiles.has(thread.profile_id));
  }

  function paintWatchChoices() {
    const host = byId('companyMessageWatchChoices');
    const profiles = watchedProfiles();
    const accounts = new Map();
    for (const thread of data?.threads || []) {
      if (thread.profile_id) accounts.set(thread.profile_id, thread.contact || 'Driver');
    }
    host.replaceChildren(...(accounts.size ? [...accounts].sort((a,b)=>a[1].localeCompare(b[1])).map(([id,label]) => {
      const wrapper = element('label', '', 'company-message-watch-choice');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = id;
      input.checked = profiles === null || profiles.has(id);
      wrapper.append(input, element('span', label));
      return wrapper;
    }) : [element('p', 'Open Messages once to load driver conversations for this account.', 'muted')]));
  }

  function showBadges() {
    const unread = watchedThreads((data?.threads || []).filter(thread => thread.unread));
    const ids = new Set(unread.map(thread => thread.last_message?.id || thread.id));
    const fresh = initialized ? unread.filter(thread => !noticeIds.has(thread.last_message?.id || thread.id)) : [];
    noticeIds = ids;
    initialized = true;
    if (typeof rigTrackerApp !== 'undefined') rigTrackerApp.badge('messages', unread.length, 'unread conversations');
    for (const id of [...badges, 'mechanicMessagesButton']) {
      const control = byId(id);
      if (control) control.textContent = unread.length ? 'Messages (' + unread.length + ')' : 'Messages';
    }
    const dispatch = byId('companyDispatchMessagesButton');
    if (!dispatch.closest('.page.active') || dispatch.classList.contains('hidden')) {
      dismissNotice();
      return;
    }
    if (fresh.length) announceThread(fresh[0]);
  }

  function dismissNotice() {
    clearTimeout(noticeTimer);
    notifiedThread = null;
    const notice = byId('companyMessageNotice');
    if (document.activeElement === notice) byId('companyDispatchMessagesButton').focus();
    notice.classList.add('hidden');
    notice.textContent = '';
    byId('companyMessageAnnouncement').textContent = '';
  }

  function announceThread(thread) {
    clearTimeout(noticeTimer);
    notifiedThread = thread.id;
    const name = thread.contact || 'Driver';
    const notice = byId('companyMessageNotice');
    notice.textContent = name;
    notice.classList.remove('hidden');
    byId('companyMessageAnnouncement').textContent = 'New message from ' + name;
    noticeTimer = setTimeout(dismissNotice, 2000);
  }

  function paintChannelChoices() {
    const fleet = data?.staff_fleet;
    const driver = contacts?.drivers.find(row => row.profile_id === byId('companyMessageRecipient').value);
    const allowed = fleet
      ? teamChannels.filter(channel => fleet.scope.includes(channel)).concat(driver?.private_enabled ? ['private'] : [])
      : teamChannels;
    setOptions('companyMessageChannel', allowed.map(value => [value,channels[value]]), allowed.length ? 'Choose a conversation' : 'No conversation access');
  }

  function crew() {
    if (data?.staff_fleet) return data.staff_fleet;
    if (mechanicFleet) return { id: mechanicFleet, scope: teamChannels };
    return null;
  }

  const driverKey = (fleet, profile, thread) => JSON.stringify([fleet, profile || null, profile ? null : thread]);
  const threadDriverKey = thread => driverKey(thread.fleet_id, thread.profile_id, thread.id);

  function markUnread(control, label) {
    const dot = element('span', '', 'company-message-unread');
    dot.setAttribute('aria-hidden', 'true');
    control.append(dot);
    control.setAttribute('aria-label', label + ', unread messages');
  }

  function paintExpandedDriver() {
    for (const row of byId('companyMessageThreads').querySelectorAll('[data-driver-key]')) {
      row.open = row.dataset.driverKey === expandedDriverKey;
    }
  }

  function paintDriverConversations(host, member) {
    const groups = new Map();
    for (const thread of data.threads) {
      const key = threadDriverKey(thread);
      if (!groups.has(key)) groups.set(key, { key, name: thread.contact || 'Driver', fleet: thread.fleet_id, threads: {} });
      const group = groups.get(key);
      group.threads[thread.kind] ??= thread;
    }
    const allowed = teamChannels.filter(kind => member.scope.includes(kind));
    for (const driver of contacts?.drivers || []) {
      const key = driverKey(member.id, driver.profile_id);
      if (!groups.has(key) && !allowed.length && !driver.private_enabled) continue;
      if (!groups.has(key)) groups.set(key, { key, fleet: member.id, threads: {} });
      const group = groups.get(key);
      group.name = driver.name;
      group.driver = driver;
      group.allowed = driver.private_enabled ? [...allowed, 'private'] : allowed;
    }
    const rows = [...groups.values()].map(group => ({ ...group, options: Object.keys(channels)
      .filter(kind => group.threads[kind] || group.allowed?.includes(kind)) }));
    const signature = JSON.stringify([member.id, rows.map(group => [group.key, group.name,
      group.options.map(kind => [kind, group.threads[kind]?.id, group.threads[kind]?.unread])])]);
    if (driverListSignature !== signature) {
      const focused = document.activeElement;
      const previous = focused?.closest('[data-driver-key]');
      const next = rows.map(group => {
        const row = element('details', '', 'company-message-driver');
        row.dataset.driverKey = group.key;
        const name = element('summary', group.name);
        if (group.fleet !== member.id) name.append(element('small', ' · ' + group.fleet, 'muted'));
        if (group.options.some(kind => group.threads[kind]?.unread)) markUnread(name, name.textContent);
        name.addEventListener('click', event => {
          event.preventDefault();
          if (expandedDriverKey === group.key) {
            expandedDriverKey = null;
            paintExpandedDriver();
          } else selectDriver(group.key);
        });
        const options = element('div', '', 'driver-page-actions company-message-driver-lines');
        options.setAttribute('role', 'group');
        options.setAttribute('aria-label', 'Message options for ' + group.name);
        for (const kind of group.options) {
          const control = element('button', channels[kind], 'outline');
          control.type = 'button';
          control.dataset.channel = kind;
          const thread = group.threads[kind];
          if (thread?.unread) markUnread(control, channels[kind]);
          control.addEventListener('click', () => void jumpToTeam(group.fleet, kind, group.driver, thread));
          options.append(control);
        }
        row.append(name, options);
        return row;
      });
      host.replaceChildren(...(next.length ? next : [element('p', 'No conversations yet.', 'muted')]));
      driverListSignature = signature;
      paintExpandedDriver();
      if (previous) {
        const row = next.find(item => item.dataset.driverKey === previous.dataset.driverKey);
        const control = row && [...row.querySelectorAll('[data-channel]')].find(item => item.dataset.channel === focused.dataset.channel);
        (control || row?.querySelector('summary'))?.focus({ preventScroll: true });
      }
    } else paintExpandedDriver();
  }

  function paintConversationList() {
    const host = byId('companyMessageThreads');
    const member = crew();
    const fleets = data.mechanic_fleets || [];
    const chooseFleet = member && !data.staff_fleet && fleets.length > 1;
    byId('companyMessageCrewFleetField').classList.toggle('hidden', !chooseFleet);
    if (chooseFleet) {
      setOptions('companyMessageCrewFleet', fleets.map(id => [id,id]), 'Select fleet');
      byId('companyMessageCrewFleet').value = mechanicFleet;
    }
    if (member) return paintDriverConversations(host, member);
    driverListSignature = null;
    host.replaceChildren(...(data.threads.length ? data.threads.map(thread => {
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
    const recipient = byId('companyMessageRecipient');
    byId('companyMessageWatchSettings').classList.toggle('hidden', !fleet);
    const canChooseFleet = accountTypeFor(currentUser) === 'mechanic';
    byId('companyMessageStartPanel').classList.toggle('hidden', Boolean(crew()) || !data.linked_fleets.length);
    byId('companyMessageRecipientLabel').textContent = fleet ? 'Driver' : canChooseFleet ? 'Fleet' : 'Linked fleet';
    setOptions('companyMessageRecipient', fleet ? drivers.map(driver => [driver.profile_id,driver.name])
      : data.linked_fleets.map(id => [id,id]), fleet ? 'Select a driver' : 'Select a fleet');
    recipient.disabled = !fleet && !canChooseFleet;
    if (!fleet && !canChooseFleet && data.linked_fleets.length) {
      recipient.value = data.linked_fleets[0];
    }
    paintChannelChoices();
    byId('companyPrivateAccessPanel').classList.toggle('hidden', !fleet?.scope.includes('official'));
    if (fleet?.scope.includes('official')) {
      setOptions('companyPrivateDriver', drivers.map(driver => [driver.profile_id,driver.name]), 'Select a driver');
      setOptions('companyPrivateStaff', contacts.staff.map(staff => [staff.id,staff.name]), 'Select a staff member');
      paintAccess();
    }
    paintConversationList();
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
        const paths = result.messages.map(message => message.image_path).filter(Boolean);
        const images = paths.length ? await supabaseClient.storage.from(imageBucket).createSignedUrls(paths, 600) : { data: [] };
        if (user !== currentUser || selected !== target || request !== threadRequest) return;
        const previews = new Map((images.data || []).map(image => [image.path, image.signedUrl]));
        byId('companyMessageHistory').replaceChildren(...result.messages.map(message => {
          const row = element('li');
          row.dataset.own = String(message.sender_id === user.id);
          row.append(element('strong',message.sender_name),
            element('span',' · '+when.format(new Date(message.created_at)),'muted'));
          if (message.body) row.append(element('p', message.body));
          if (message.image_path) row.append(messagePhoto(previews.get(message.image_path)));
          return row;
        }));
        if (!images.error) historySignature = signature;
      }
    } catch (error) {
      if (user === currentUser && selected === target) byId('companyThreadStatus').textContent = error.message || 'Could not open this conversation.';
    } finally { if (threadRequest === request) threadRequest = null; }
  }

  async function refresh(force = false) {
    const user = currentUser;
    if (!user || !['company','fleet','employee','mechanic'].includes(accountTypeFor(user)) || (!force && listRequest)) return;
    const request = {};
    listRequest = request;
    const page = byId('companyMessagesPage');
    const viewing = page.classList.contains('active') && !document.hidden;
    try {
      if (viewing && selected && !threadRequest) await readThread();
      if (user !== currentUser || listRequest !== request) return;
      const result = await rpc('list');
      const fleets = result.mechanic_fleets || [];
      const selectedFleet = fleets.includes(mechanicFleet) ? mechanicFleet : fleets[0];
      const contactFleet = viewing && (result.staff_fleet?.id || selectedFleet);
      const contactRows = contactFleet ? await rpc('contacts',contactFleet) : null;
      if (user !== currentUser || listRequest !== request) return;
      data = result;
      contacts = contactRows;
      mechanicFleet = selectedFleet;
      if (accountTypeFor(user) === 'employee' && typeof officeTools !== 'undefined') {
        officeTools.setPrivateThreads(data.threads.some(thread=>thread.kind==='private'));
      }
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
    if (accountTypeFor(currentUser) === 'company') void driverLoadWorkflow.refresh(true);
    return refresh(true);
  }

  function back() {
    showPage(returnPage || (accountTypeFor(currentUser)==='fleet' ? 'fleetWorkspace' :
      accountTypeFor(currentUser)==='employee' ? 'fleetEmployeePage' : 'rigTrackerProfilePage'));
  }

  async function openTeam(kind) {
    const user = currentUser;
    if (!user || accountTypeFor(user) !== 'company' || !teamChannels.includes(kind)) return;
    await open();
    if (user !== currentUser || !byId('companyMessagesPage').classList.contains('active')) return;
    if (!data?.linked_fleets.length) {
      showToast('Link to a fleet to contact ' + channels[kind] + '.');
      return;
    }
    if (data.linked_fleets.length > 1) {
      byId('companyMessageChannel').value = kind;
      byId('companyMessageStartPanel').scrollIntoView?.({ block: 'start' });
      byId('companyMessageRecipient').focus();
      return;
    }
    await jumpToTeam(data.linked_fleets[0],kind);
  }

  async function jumpToTeam(fleet, kind, driver, thread) {
    const user = currentUser;
    const token = {};
    teamRequest = token;
    try {
      const profile = driver?.profile_id;
      const existing = thread || data.threads.find(thread => thread.fleet_id===fleet && thread.kind===kind &&
        (!profile || thread.profile_id===profile));
      const target = existing || {
        ...await rpc('start',fleet,null,{kind,...(profile ? {profile_id:profile} : {})}),
        kind, contact:driver?.name || channels[kind], fleet_id:fleet, profile_id:profile
      };
      if (user !== currentUser || teamRequest !== token || !byId('companyMessagesPage').classList.contains('active')) return;
      await openThread(target);
      if (user === currentUser && selected === target) byId('companyMessageThread').scrollIntoView?.({ block: 'start' });
    } catch (error) {
      if (user === currentUser) showToast(error.message || 'Could not open the ' + channels[kind] + ' line.');
    }
  }

  async function openDriver({dispatchId, profileId, channel}) {
    const user = currentUser;
    await open();
    if (currentUser !== user || !byId('companyMessagesPage').classList.contains('active')) return;
    const driver = contacts?.drivers.find(row => dispatchId ? row.dispatch_driver_id===dispatchId : row.profile_id===profileId);
    const member = crew();
    if (!driver || !member) { showToast('Link the driver’s Company Driver profile to open their conversations.'); return; }
    const key = driverKey(member.id, driver.profile_id);
    selectDriver(key);
    if (channel) {
      if (member?.scope.includes(channel)) await jumpToTeam(member.id, channel, driver);
      else showToast('This account can’t open the requested conversation.');
      return;
    }
    const row = [...byId('companyMessageThreads').querySelectorAll('[data-driver-key]')].find(item => item.dataset.driverKey === key);
    row?.scrollIntoView?.({ block: 'nearest' });
  }

  function selectDriver(key) {
    teamRequest = null;
    expandedDriverKey = key;
    if (selected && threadDriverKey(selected) !== key) {
      selected = null;
      clearPhoto();
      byId('companyMessageThread').classList.add('hidden');
    }
    paintExpandedDriver();
  }

  async function openThread(thread) {
    const switching = selected?.id !== thread.id;
    selected = thread;
    if (crew()) {
      expandedDriverKey = threadDriverKey(thread);
      paintExpandedDriver();
    }
    if (switching) {
      threadRequest = null;
      historySignature = '';
      draftId = null; draftBody = null;
      clearPhoto();
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

  byId('companyMessageNotice').addEventListener('click', async () => {
    const threadId = notifiedThread;
    dismissNotice();
    if (!threadId) return;
    const user = currentUser;
    await open();
    if (user !== currentUser || !byId('companyMessagesPage').classList.contains('active')) return;
    const current = data?.threads.find(thread => thread.id === threadId);
    if (current) await openThread(current);
  });
  byId('companyMessageWatchSettings').addEventListener('toggle', event => {
    if (event.currentTarget.open) paintWatchChoices();
  });
  byId('companyMessageWatchForm').addEventListener('submit', event => {
    event.preventDefault();
    const selected = [...byId('companyMessageWatchChoices').querySelectorAll('input:checked')].map(input => input.value);
    try { localStorage.setItem('rigtracker-message-watch:' + (currentUser?.id || ''), JSON.stringify(selected)); } catch {}
    byId('companyMessageWatchSettings').open = false;
    showBadges();
  });
  byId('companyMessageRecipient').addEventListener('change',paintChannelChoices);
  byId('companyMessageCrewFleet').addEventListener('change', event => {
    if (!data.mechanic_fleets?.includes(event.target.value)) return;
    mechanicFleet = event.target.value;
    contacts = null;
    selectDriver(null);
    void refresh(true);
  });
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
  const photoPicker = byId('companyMessagePhoto');
  const cameraPicker = byId('companyMessageCamera');
  const addPhoto = byId('companyMessageAddPhoto');
  function showPhotoOptions(open) {
    addPhoto.setAttribute('aria-expanded', String(open));
    byId('companyMessagePhotoOptions').classList.toggle('hidden', !open);
  }
  addPhoto.addEventListener('click', () => showPhotoOptions(addPhoto.getAttribute('aria-expanded') !== 'true'));
  byId('companyMessageReply').addEventListener('keydown', event => {
    if (event.key !== 'Escape' || addPhoto.getAttribute('aria-expanded') !== 'true') return;
    showPhotoOptions(false);
    addPhoto.focus();
  });
  for (const [id, picker] of [['companyMessageTakePhoto', cameraPicker], ['companyMessageUploadPhoto', photoPicker]]) {
    byId(id).addEventListener('click', () => {
      showPhotoOptions(false);
      addPhoto.focus();
      picker.click();
    });
    picker.addEventListener('change', acceptPhoto);
  }
  byId('companyMessageRemovePhoto').addEventListener('click', () => {
    clearPhoto();
    draftId = null;
    byId('companyMessageAddPhoto').focus();
  });
  function acceptPhoto(event) {
    const picker = event.currentTarget;
    const file = picker.files[0];
    if (!file) return;
    const extension = file.name.split('.').at(-1).toLowerCase();
    const mime = imageExtensions[file.type] ? file.type : file.type && file.type !== 'application/octet-stream'
      ? '' : Object.keys(imageExtensions).find(type => imageExtensions[type] === (extension === 'jpeg' ? 'jpg' : extension));
    if (!mime || !file.size || file.size > 10485760) {
      picker.value = '';
      showToast('Choose a supported photo up to 10 MB.');
      return;
    }
    clearPhoto();
    draftId = null;
    draftPhoto = { file, mime, preview: URL.createObjectURL(file) };
    byId('companyMessagePhotoPreview').src = draftPhoto.preview;
    byId('companyMessagePhotoDraft').classList.remove('hidden');
  }
  byId('companyMessageReply').addEventListener('submit',event => {
    event.preventDefault();
    const control = event.currentTarget.querySelector('button[type="submit"]');
    void submit(control,async user => {
      const target = selected;
      const input = byId('companyMessageBody');
      const body = input.value.trim();
      const photo = draftPhoto;
      if ((!body && !photo) || !target || !user) return;
      if (draftBody !== body || !draftId) { draftBody = body; draftId = crypto.randomUUID(); }
      const id = draftId;
      let path;
      if (photo) {
        path = target.id + '/' + user.id + '/' + id + '.' + imageExtensions[photo.mime];
        if (photo.uploaded !== path) {
          const { error } = await supabaseClient.storage.from(imageBucket).upload(path, photo.file, { contentType: photo.mime });
          if (error && String(error.statusCode ?? error.status) !== '409' && error.error !== 'Duplicate') throw error;
          photo.uploaded = path;
        }
      }
      if (currentUser !== user || selected !== target || draftPhoto !== photo) return;
      await rpc('send',null,target.id,{body,message_id:id,...(path ? {image_path:path} : {})});
      if (currentUser === user && selected === target) {
        if (input.value.trim()===body) input.value='';
        if (draftPhoto === photo) clearPhoto();
        draftBody = null; draftId = null;
        await refresh(true);
      }
    });
  });

  function reset() {
    dismissNotice();
    data = null; contacts = null; selected = null; returnPage = null; listRequest = null; threadRequest = null;
    noticeIds = new Set(); initialized = false; historySignature = ''; draftBody = null; draftId = null;
    mechanicFleet = null; teamRequest = null; expandedDriverKey = null; driverListSignature = null;
    byId('companyMessageCrewFleet').replaceChildren();
    byId('companyMessageCrewFleetField').classList.add('hidden');
    byId('companyMessageBody').value = '';
    clearPhoto();
    byId('companyMessageThreads').replaceChildren();
    byId('companyMessageHistory').replaceChildren();
    byId('companyMessageThread').classList.add('hidden');
    byId('companyMessageWatchSettings').open = false;
    byId('companyMessageWatchSettings').classList.add('hidden');
    for (const id of badges) byId(id).textContent = 'Messages';
    if (byId('mechanicMessagesButton')) byId('mechanicMessagesButton').textContent = 'Messages';
  }
  setInterval(() => { if (!document.hidden) void refresh(); },10000);
  return { open, openTeam, openDriver, dispatchRecipients, sendDispatchMessage, back, refresh, reset };
})();
