const companyMessaging = (() => {
  const byId = id => document.getElementById(id);
  const teamChannels = ['dispatch', 'safety', 'maintenance'];
  const channels = { dispatch: 'Dispatch', maintenance: 'Maintenance', safety: 'Safety', private: 'Private' };
  const badges = ['companyDriverMessagesButton','companyFleetMessagesButton','companyDispatchMessagesButton','companyOfficeMessagesButton'];
  const boardLabel = id => {
    if (id === 'companyDispatchMessagesButton') return 'Driver Message Board';
    if (id === 'companyFleetMessagesButton' || id === 'companyOfficeMessagesButton') return 'Driver Messages';
    return 'Messages';
  };
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
  let driverListSignature;
  let personalBoard;
  let linkedBoardFleet;
  let department;

  function personal() {
    return personalBoard ?? ['company','driver'].includes(accountTypeFor(currentUser));
  }

  function visibleThreads() {
    return (data?.threads || []).filter(thread => thread.kind !== 'private' &&
      (personal() ? thread.mine === true : thread.mine !== true));
  }

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
    for (const driver of contacts?.drivers || []) accounts.set(driver.profile_id, driver.name);
    for (const thread of visibleThreads()) {
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
    }) : [element('p', 'No driver contacts yet.', 'muted')]));
    byId('companyMessageWatchForm').querySelector('[type="submit"]').disabled = !accounts.size;
  }

  function showBadges() {
    const unreadThreads = visibleThreads().filter(thread => thread.unread);
    const unread = personal() ? unreadThreads : watchedThreads(unreadThreads);
    const ids = new Set(unread.map(thread => thread.last_message?.id || thread.id));
    const fresh = initialized ? unread.filter(thread => !noticeIds.has(thread.last_message?.id || thread.id)) : [];
    noticeIds = ids;
    initialized = true;
    if (typeof rigTrackerApp !== 'undefined') rigTrackerApp.badge('messages', unread.length, 'unread conversations');
    for (const id of [...badges, 'mechanicMessagesButton']) {
      const control = byId(id);
      if (control) control.textContent = boardLabel(id) + (unread.length ? ' (' + unread.length + ')' : '');
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

  function crew() {
    if (personal()) return null;
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

  function closeThread() {
    teamRequest = null;
    selected = null;
    clearPhoto();
    byId('companyMessageThread').classList.add('hidden');
  }

  function paintDepartments(member) {
    const host = byId('companyMessageDepartments');
    const allowed = teamChannels.filter(kind => member?.scope.includes(kind));
    host.classList.toggle('hidden', !allowed.length);
    if (!allowed.length) return;
    if (!allowed.includes(department)) department = allowed[0];
    const unread = watchedThreads(visibleThreads()).filter(thread => thread.unread && thread.fleet_id === member.id);
    const oldButtons = [...host.children];
    if (oldButtons.map(button => button.dataset.kind).join() !== allowed.join()) {
      host.replaceChildren(...allowed.map(kind => {
        const button = element('button', channels[kind]);
        button.type = 'button';
        button.dataset.kind = kind;
        button.addEventListener('click', () => {
          if (department === kind) return;
          department = kind;
          closeThread();
          paintConversationList();
        });
        return button;
      }));
    }
    for (const button of host.children) {
      const kind = button.dataset.kind;
      const count = unread.filter(thread => thread.kind === kind).length;
      button.textContent = channels[kind] + (count ? ` (${count})` : '');
      button.setAttribute('aria-pressed', String(kind === department));
    }
  }

  function paintDriverConversations(host, member) {
    const groups = new Map();
    for (const thread of watchedThreads(visibleThreads())) {
      if (thread.kind !== department || thread.fleet_id !== member.id) continue;
      const key = threadDriverKey(thread);
      groups.set(key, { key, name: thread.contact || 'Driver', fleet: thread.fleet_id, thread });
    }
    const profiles = watchedProfiles();
    const drivers = member.scope.includes(department) ? contacts?.drivers || [] : [];
    for (const driver of drivers) {
      if (profiles && !profiles.has(driver.profile_id)) continue;
      const key = driverKey(member.id, driver.profile_id);
      groups.set(key, { ...groups.get(key), key, fleet: member.id, name: driver.name, driver });
    }
    const query = byId('companyMessageDriverSearch').value.trim().toLowerCase();
    const rows = [...groups.values()].map(group => ({ ...group,
      role: group.driver?.profile_type === 'driver' ? 'Owner Ops' : group.driver ? 'Company Drivers' : 'Previous Conversations'
    })).filter(group => [group.name, group.role].some(value => value.toLowerCase().includes(query)))
      .sort((a,b) => Number(Boolean(b.thread?.unread)) - Number(Boolean(a.thread?.unread)) || a.name.localeCompare(b.name));
    const signature = JSON.stringify([member.id, department, query, selected?.id, rows.map(group =>
      [group.key, group.name, group.role, group.thread?.id, group.thread?.unread, group.thread?.last_message?.id])]);
    if (driverListSignature === signature) return;
    driverListSignature = signature;
    const focusedKey = document.activeElement?.dataset.driverKey;
    const sections = new Map();
    for (const group of rows) {
      if (!sections.has(group.role)) {
        const section = element('section', '', 'dispatch-load-list');
        section.append(element('h3', group.role));
        sections.set(group.role, section);
      }
      const contact = element('button', group.name, 'outline message-contact');
      contact.type = 'button';
      contact.dataset.driverKey = group.key;
      contact.setAttribute('aria-pressed', String(Boolean(selected && threadDriverKey(selected) === group.key)));
      if (group.thread?.unread) markUnread(contact, group.name);
      if (group.thread?.last_message?.body) contact.append(element('small', group.thread.last_message.body, 'message-contact-preview muted'));
      const kind = department;
      contact.addEventListener('click', () => void jumpToTeam(group.fleet, kind, group.driver, group.thread));
      sections.get(group.role).append(contact);
    }
    host.replaceChildren(...(sections.size ? sections.values() : [element('p', query || profiles ? 'No matching driver contacts.' : 'No driver contacts yet.', 'muted')]));
    if (focusedKey) [...host.querySelectorAll('[data-driver-key]')].find(button => button.dataset.driverKey === focusedKey)?.focus({ preventScroll:true });
  }

  function paintConversationList() {
    const host = byId('companyMessageThreads');
    const driverFleet = byId('companyMessageDriverFleet');
    const driverSearch = byId('companyMessageDriverSearchField');
    const linked = data.linked_fleets || [];
    const member = crew();
    byId('companyMessageDriverFleetField').classList.toggle('hidden', !personal() || linked.length < 2);
    driverSearch.classList.toggle('hidden', !member);
    paintDepartments(member);
    if (personal()) {
      byId('companyMessageCrewFleetField').classList.add('hidden');
      if (!linked.includes(linkedBoardFleet)) linkedBoardFleet = linked[0];
      setOptions('companyMessageDriverFleet', linked.map(id => [id,id]), 'Choose your fleet');
      driverFleet.value = linkedBoardFleet || '';
      const threads = visibleThreads();
      const signature = JSON.stringify([linkedBoardFleet, selected?.id, threads.map(row => [row.id, row.unread, row.last_message?.id])]);
      if (driverListSignature === signature) return;
      driverListSignature = signature;
      host.replaceChildren(...teamChannels.map(kind => {
        const thread = threads.find(row => row.fleet_id === linkedBoardFleet && row.kind === kind);
        const row = element('article', '', 'dispatch-load-row');
        const label = element('button', channels[kind], 'outline');
        label.type = 'button';
        label.disabled = !linkedBoardFleet;
        label.setAttribute('aria-pressed', String(selected?.kind === kind && selected.fleet_id === linkedBoardFleet));
        if (thread?.unread) markUnread(label, channels[kind]);
        label.addEventListener('click', () => void jumpToTeam(linkedBoardFleet, kind, null, thread));
        row.append(label);
        if (thread?.last_message) row.append(element('p', thread.last_message.body));
        return row;
      }));
      if (!linkedBoardFleet) host.append(element('p', 'Link your profile to a fleet to open these chats.', 'muted'));
      return;
    }
    const fleets = data.mechanic_fleets || [];
    const chooseFleet = member && !data.staff_fleet && fleets.length > 1;
    byId('companyMessageCrewFleetField').classList.toggle('hidden', !chooseFleet);
    if (chooseFleet) {
      setOptions('companyMessageCrewFleet', fleets.map(id => [id,id]), 'Select fleet');
      byId('companyMessageCrewFleet').value = mechanicFleet;
    }
    if (member) return paintDriverConversations(host, member);
    driverListSignature = null;
    const threads = visibleThreads();
    host.replaceChildren(...(threads.length ? threads.map(thread => {
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

  function paint() {
    const fleet = data.staff_fleet;
    byId('companyMessageWatchSettings').classList.toggle('hidden', !fleet || personal());
    const profiles = watchedProfiles();
    byId('companyMessageWatchSettings').querySelector('summary').textContent = profiles ? `Filter drivers (${profiles.size})` : 'Filter drivers';
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
          const own = message.sender_id === user.id;
          row.dataset.own = String(own);
          row.append(element('strong', own ? 'You' : message.sender_name),
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
    const allowed = ['driver','company','fleet','employee','mechanic'].includes(accountTypeFor(user));
    if (!user || !allowed || (!force && listRequest)) return;
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
      const contactFleet = viewing && !personal() && (result.staff_fleet?.id || selectedFleet);
      const contactRows = contactFleet ? await rpc('contacts',contactFleet) : null;
      if (user !== currentUser || listRequest !== request) return;
      data = result;
      contacts = contactRows;
      mechanicFleet = selectedFleet;
      showBadges();
      if (viewing) {
        byId('companyMessagesStatus').textContent = '';
        if (force || !page.contains(document.activeElement) || !document.activeElement.closest('form')) paint();
      }
    } catch (error) {
      if (user === currentUser && viewing) byId('companyMessagesStatus').textContent = error.message || 'Could not load messages.';
    } finally { if (listRequest === request) listRequest = null; }
  }

  function open(mode) {
    const role = accountTypeFor(currentUser);
    const isPersonal = ['company','driver'].includes(role) && mode !== 'fleet';
    if (role === 'employee' && !officeTools.messagesAllowed()) return;
    if (personal() !== isPersonal) closeThread();
    personalBoard = isPersonal;
    if (!byId('companyMessagesPage').classList.contains('active')) returnPage = document.querySelector('.page.active')?.id;
    showPage('companyMessagesPage');
    byId('companyMessagesTitle').textContent = isPersonal || role === 'mechanic' ? 'Messages' : 'Driver Message Board';
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
    if (!user || !['company','driver'].includes(accountTypeFor(user)) || !teamChannels.includes(kind)) return;
    await open();
    if (user !== currentUser || !byId('companyMessagesPage').classList.contains('active')) return;
    if (!data?.linked_fleets?.length) {
      showToast('Link to a fleet to contact ' + channels[kind] + '.');
      return;
    }
    await jumpToTeam(linkedBoardFleet || data.linked_fleets[0],kind);
  }

  async function jumpToTeam(fleet, kind, driver, thread) {
    const user = currentUser;
    const token = {};
    teamRequest = token;
    try {
      const profile = driver?.profile_id;
      const existing = thread || visibleThreads().find(thread => thread.fleet_id===fleet && thread.kind===kind &&
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
    await open('fleet');
    if (currentUser !== user || !byId('companyMessagesPage').classList.contains('active')) return;
    const driver = contacts?.drivers.find(row => dispatchId ? row.dispatch_driver_id===dispatchId : row.profile_id===profileId);
    const member = crew();
    if (!driver || !member) { showToast('Link the driver’s RigTracker profile to open their conversations.'); return; }
    const kind = channel || department;
    if (member.scope.includes(kind)) await jumpToTeam(member.id, kind, driver);
    else showToast('This account can’t open the requested conversation.');
  }

  async function openThread(thread) {
    const switching = selected?.id !== thread.id;
    selected = thread;
    if (crew()) department = thread.kind;
    paintConversationList();
    if (switching) {
      threadRequest = null;
      historySignature = '';
      draftId = null; draftBody = null;
      clearPhoto();
      byId('companyMessageBody').value = '';
      byId('companyMessageHistory').replaceChildren();
      byId('companyMessageReply').classList.add('hidden');
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
    const current = visibleThreads().find(thread => thread.id === threadId);
    if (current) await openThread(current);
  });
  byId('companyMessageWatchSettings').addEventListener('toggle', event => {
    if (event.currentTarget.open) paintWatchChoices();
  });
  function applyDriverFilter(profiles) {
    try {
      const key = 'rigtracker-message-watch:' + currentUser.id;
      if (profiles === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(profiles));
    } catch {}
    if (profiles && selected?.profile_id && !profiles.includes(selected.profile_id)) closeThread();
    byId('companyMessageWatchSettings').open = false;
    showBadges();
    paint();
  }

  byId('companyMessageWatchForm').addEventListener('submit', event => {
    event.preventDefault();
    const choices = [...byId('companyMessageWatchChoices').querySelectorAll('input')];
    const ids = choices.filter(input => input.checked).map(input => input.value);
    applyDriverFilter(ids.length === choices.length ? null : ids);
  });
  byId('companyMessageShowAllDrivers').addEventListener('click', () => applyDriverFilter(null));
  byId('companyMessageDriverSearch').addEventListener('input', () => { if (data) paintConversationList(); });
  byId('companyMessageDriverFleet').addEventListener('change', event => {
    linkedBoardFleet = event.target.value;
    closeThread();
    paintConversationList();
  });
  byId('companyMessageCrewFleet').addEventListener('change', event => {
    if (!data.mechanic_fleets?.includes(event.target.value)) return;
    mechanicFleet = event.target.value;
    contacts = null;
    closeThread();
    void refresh(true);
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
    personalBoard = linkedBoardFleet = null;
    byId('companyMessageDriverSearch').value = '';
    noticeIds = new Set(); initialized = false; historySignature = ''; draftBody = null; draftId = null;
    mechanicFleet = null; teamRequest = null; department = null; driverListSignature = null;
    byId('companyMessageCrewFleet').replaceChildren();
    byId('companyMessageCrewFleetField').classList.add('hidden');
    byId('companyMessageBody').value = '';
    clearPhoto();
    byId('companyMessageThreads').replaceChildren();
    byId('companyMessageHistory').replaceChildren();
    byId('companyMessageThread').classList.add('hidden');
    byId('companyMessageWatchSettings').open = false;
    byId('companyMessageWatchSettings').classList.add('hidden');
    for (const id of badges) byId(id).textContent = boardLabel(id);
    if (byId('mechanicMessagesButton')) byId('mechanicMessagesButton').textContent = 'Messages';
  }
  function messageArrived() {
    threadRequest = null;
    return refresh(true);
  }

  setInterval(() => {
    if (!document.hidden && messageRealtime.shouldPoll('driver_message')) void refresh();
  },10000);
  return { open, openTeam, openDriver, dispatchRecipients, sendDispatchMessage, back, refresh, messageArrived, reset };
})();
