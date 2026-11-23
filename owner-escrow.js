const ownerEscrow = (() => {
  const byId = id => document.getElementById(id);
  const page = byId('ownerEscrowPage');
  const picker = byId('ownerEscrowAccount');
  const form = byId('ownerEscrowTransactionForm');
  const typeForm = byId('ownerEscrowTypeForm');
  const status = byId('ownerEscrowStatus');
  const typeNames = { owner_operator: 'Owner-Operator', lease_operator: 'Lease Operator' };
  const kindNames = { opening: 'Opening balance', deposit: 'Deposit', interest: 'Interest', withdrawal: 'Withdrawal', refund: 'Refund' };
  const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  let view;

  async function rpc(action, account, payload) {
    const { data, error } = await supabaseClient.rpc('owner_operator_escrow', {
      action,
      ...(account?.fleet_id ? { target_fleet: account.fleet_id } : {}),
      ...(account?.owner_id ? { target_owner: account.owner_id } : {}),
      ...(payload ? { payload } : {})
    });
    if (error) throw error;
    return data;
  }

  const active = request => view === request && currentUser === request.user && page.classList.contains('active');

  function manage(enabled, busy = false) {
    for (const panel of [form, typeForm]) {
      panel.classList.toggle('hidden', !enabled);
      panel.querySelector('fieldset').disabled = busy;
    }
    picker.disabled = busy;
  }

  function clearLedger() {
    byId('ownerEscrowAccountLabel').textContent = '';
    byId('ownerEscrowBalance').textContent = '—';
    byId('ownerEscrowEntries').replaceChildren();
    byId('ownerEscrowLedger').classList.add('hidden');
  }

  function reset() {
    view = null;
    status.textContent = '';
    byId('ownOwnerEscrowButton').classList.add('hidden');
    picker.replaceChildren();
    clearLedger();
    form.reset();
    typeForm.reset();
    manage(false);
  }

  function paintLedger(account, entries) {
    byId('ownerEscrowAccountLabel').textContent = [account.driver_name, typeNames[account.operator_type], account.fleet_id,
      account.active ? null : 'Former link'].filter(Boolean).join(' · ');
    byId('ownerEscrowBalance').textContent = dollars.format(Number(entries[0]?.balance ?? 0));
    typeForm.elements.operator_type.value = account.operator_type;
    form.elements.kind.querySelector('option[value=opening]').disabled = entries.length > 0;
    if (form.elements.kind.value === 'opening' && entries.length) form.elements.kind.value = 'deposit';
    const body = byId('ownerEscrowEntries');
    body.replaceChildren();
    for (const entry of entries) {
      const row = body.insertRow();
      const posted = new Date(entry.posted_on + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      for (const value of [posted, kindNames[entry.kind], entry.description, entry.settlement_reference ?? '—',
        dollars.format(Number(entry.amount)), dollars.format(Number(entry.balance))]) row.insertCell().textContent = value;
    }
    byId('ownerEscrowLedger').classList.remove('hidden');
  }

  async function loadLedger(request, notice = '') {
    const account = request.account;
    if (!account) return;
    const query = {};
    request.query = query;
    manage(account.can_manage, true);
    status.textContent = 'Loading escrow activity…';
    try {
      const entries = await rpc('ledger', account);
      if (!active(request) || request.query !== query) return;
      paintLedger(account, entries);
      status.textContent = notice || (entries.length ? '' : 'No escrow activity recorded yet.');
    } catch (error) {
      if (active(request) && request.query === query) status.textContent = error.message || 'Could not load the escrow account.';
    } finally {
      if (active(request) && request.query === query) manage(account.can_manage);
    }
  }

  function selectAccount(request) {
    clearLedger();
    request.retry = null;
    request.account = request.targets[Number(picker.value)];
    if (!request.account) return;
    form.reset();
    form.elements.posted_on.value = todayForZone(preferredZone);
    form.elements.posted_on.max = form.elements.posted_on.value;
    void loadLedger(request);
  }

  async function open(options = {}) {
    const user = currentUser;
    if (!user) return;
    const origin = document.querySelector('.page.active')?.id || 'rigTrackerProfilePage';
    const request = { user, origin };
    view = request;
    picker.replaceChildren();
    byId('ownerEscrowPicker').classList.add('hidden');
    clearLedger();
    manage(false);
    status.textContent = 'Loading escrow accounts…';
    showPage('ownerEscrowPage');
    try {
      const targets = await rpc('targets', { fleet_id: options.fleet });
      if (!active(request)) return;
      request.targets = targets.filter(account => options.roster ? account.roster_id === options.roster
        : accountTypeFor(user) === 'driver' ? account.owner_id === user.id : account.can_manage);
      if (!request.targets.length) {
        status.textContent = 'No linked owner-operator or lease operator escrow accounts found.';
        return;
      }
      picker.replaceChildren(...request.targets.map((account, index) =>
        new Option(account.driver_name + ' · ' + account.fleet_id + (account.active ? '' : ' · Former link'), String(index))));
      byId('ownerEscrowPicker').classList.toggle('hidden', request.targets.length < 2);
      selectAccount(request);
    } catch (error) {
      if (active(request)) status.textContent = error.message || 'Could not open escrow.';
    }
  }

  picker.addEventListener('change', () => { if (view && active(view)) selectAccount(view); });
  byId('ownerEscrowBack').addEventListener('click', () => showPage(view?.origin || 'rigTrackerProfilePage'));

  typeForm.addEventListener('submit', async event => {
    event.preventDefault();
    const request = view;
    if (!request || !active(request) || !request.account?.can_manage || request.saving) return;
    request.saving = true;
    const operatorType = typeForm.elements.operator_type.value;
    manage(true, true);
    try {
      const result = await rpc('classify', request.account, { operator_type: operatorType });
      if (!active(request)) return;
      request.account.operator_type = result.operator_type;
      await loadLedger(request, 'Operator type saved.');
    } catch (error) {
      if (active(request)) status.textContent = error.message || 'Could not save the operator type.';
    } finally {
      request.saving = false;
      if (active(request)) manage(true);
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const request = view;
    if (!request || !active(request) || !request.account?.can_manage || request.saving) return;
    const values = Object.fromEntries(new FormData(form));
    const signature = JSON.stringify(values);
    request.retry = request.retry?.signature === signature ? request.retry : { signature, id: crypto.randomUUID() };
    request.saving = true;
    manage(true, true);
    try {
      await rpc('record', request.account, { ...values, id: request.retry.id });
      if (!active(request)) return;
      request.retry = null;
      form.reset();
      form.elements.posted_on.value = todayForZone(preferredZone);
      await loadLedger(request, 'Escrow transaction recorded.');
    } catch (error) {
      if (active(request)) status.textContent = error.message || 'Could not record the escrow transaction.';
    } finally {
      request.saving = false;
      if (active(request)) manage(true);
    }
  });

  return { open, reset };
})();
