const fleetBolPayments = (() => {
  const byId = id => document.getElementById(id);
  const page = byId('fleetBolPaymentsPage');
  const status = byId('fleetBolStatus');
  const search = byId('fleetBolSearch');
  const more = byId('fleetBolMore');
  const dialog = byId('fleetBolPaymentDialog');
  const paymentDate = byId('fleetBolPaymentDate');
  const paymentStatus = byId('fleetBolPaymentStatus');
  const confirmPayment = byId('fleetBolPaymentSubmit');
  const cancelPayment = byId('fleetBolPaymentCancel');
  const tabs = [byId('fleetBolAttentionTab'), byId('fleetBolCompletedTab')];
  const lists = [byId('fleetBolAttentionList'), byId('fleetBolCompletedList')];
  const deliveredDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const paidDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
  const pageSize = 30;
  let workspace = null;
  let selected = 0;
  let filter = null;
  let cursor = null;
  let request = null;
  let payment = null;

  function node(tag, label, className) {
    const element = document.createElement(tag);
    element.textContent = label;
    if (className) element.className = className;
    return element;
  }

  function button(label, action) {
    const control = node('button', label, 'outline');
    control.type = 'button';
    control.addEventListener('click', action);
    return control;
  }

  function active(scope) {
    return workspace === scope && currentUser?.id === scope.userId && page.classList.contains('active');
  }

  function pro(load) {
    return (load.return_load ? 'B-' : 'A-') + load.pro_number;
  }

  function loadRow(load) {
    const row = node('article', '', 'panel');
    row.append(node('h2', pro(load)));
    if (load.destination) row.append(node('p', load.destination));
    const dates = [];
    const delivered = Date.parse(load.delivered_at);
    if (Number.isFinite(delivered)) dates.push('Delivered ' + deliveredDate.format(delivered));
    if (load.paid_on) dates.push('Paid ' + paidDate.format(Date.parse(load.paid_on)));
    if (dates.length) row.append(node('p', dates.join(' · '), 'muted'));

    if (load.paperwork.length) {
      const paperwork = node('div', '', 'bol-paperwork');
      load.paperwork.forEach((file, index) => {
        const entry = node('div', '');
        const label = file.kind === 'delivery' ? 'Proof of Delivery' : 'BOL';
        const context = [label, file.bol, file.company].filter(Boolean).join(' · ');
        entry.append(node('strong', context));
        const actions = node('div', '', 'dispatch-actions');
        actions.append(button('View ' + label, () => driverLoadWorkflow.openDocument(file.path)));
        const extension = file.path.match(/\.([a-z0-9]+)$/i)?.[1] || 'pdf';
        const fileName = pro(load) + '-' + (file.kind === 'delivery' ? 'POD' : 'BOL') + '-' + (index + 1) + '.' + extension;
        actions.append(button('Download ' + label, () => driverLoadWorkflow.downloadDocument(file.path, fileName)));
        entry.append(actions);
        paperwork.append(entry);
      });
      row.append(paperwork);
    } else {
      row.append(node('p', 'No BOL or proof of delivery uploaded.', 'muted'));
    }
    if (!load.paid_on) {
      const actions = node('div', '', 'dispatch-actions');
      actions.append(button('Mark Paid', () => openPayment(load)));
      row.append(actions);
    }
    return row;
  }

  async function read(append = false) {
    const scope = workspace;
    if (!scope || !active(scope)) return;
    const current = {};
    request = current;
    const list = lists[selected];
    const paid = selected === 1;
    const before = append ? cursor : null;
    if (!append) {
      cursor = null;
      list.replaceChildren();
    }
    more.disabled = true;
    if (!append) more.classList.add('hidden');
    status.textContent = 'Loading loads…';
    try {
      const { data, error } = await supabaseClient.rpc('list_fleet_bol_payments', {
        target_fleet: scope.fleetId,
        paid,
        target_pro: filter?.[2] ?? null,
        pro_prefix: filter?.[1] ?? null,
        before_date: before?.paid_on ?? null,
        before_time: before?.sort_at ?? null,
        before_load: before?.load_id ?? null
      });
      if (request !== current || !active(scope)) return;
      if (error) throw error;
      const rows = data.slice(0, pageSize);
      list.append(...rows.map(loadRow));
      cursor = rows.at(-1) ?? null;
      more.classList.toggle('hidden', data.length <= pageSize);
      status.textContent = rows.length ? '' : filter ? 'No matching PRO in this tab.'
        : paid ? 'No paid loads yet.' : 'No loads need attention.';
    } catch (error) {
      if (request === current && active(scope)) {
        status.textContent = error.code === '42501' ? 'BOLs & Payments access is required.'
          : 'Could not load records. Try refreshing.';
      }
    } finally {
      if (request === current && active(scope)) {
        more.disabled = false;
        request = null;
      }
    }
  }

  function selectTab(index) {
    selected = index;
    tabs.forEach((tab, position) => {
      const isSelected = position === index;
      tab.setAttribute('aria-selected', String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      byId(tab.getAttribute('aria-controls')).classList.toggle('hidden', !isSelected);
    });
    return read();
  }

  function openPayment(load) {
    if (dialog.open || !workspace || !active(workspace)) return;
    const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    paymentDate.max = todayForZone(localZone);
    paymentDate.value = paymentDate.max;
    byId('fleetBolPaymentLoad').textContent = 'Confirm the customer paid ' + pro(load) + ' in full.';
    paymentStatus.textContent = '';
    payment = { workspace, load, pending: false };
    dialog.showModal();
  }

  byId('fleetBolPaymentForm').addEventListener('submit', async event => {
    event.preventDefault();
    const selection = payment;
    if (!selection || selection.pending || !active(selection.workspace)) return;
    selection.pending = true;
    confirmPayment.disabled = true;
    cancelPayment.disabled = true;
    paymentStatus.textContent = '';
    try {
      const { error } = await supabaseClient.rpc('mark_fleet_load_paid', {
        target_fleet: selection.workspace.fleetId,
        target_load: selection.load.load_id,
        received_on: paymentDate.value
      });
      if (payment !== selection || !active(selection.workspace)) return;
      if (error) throw error;
      dialog.close();
      tabs[selected].focus();
      showToast(pro(selection.load) + ' moved to Completed.');
      void read();
    } catch (error) {
      if (payment === selection && active(selection.workspace)) {
        paymentStatus.textContent = error.code === '42501' ? 'BOLs & Payments access is required.'
          : 'Could not record payment. Try again.';
      }
    } finally {
      if (payment === selection) {
        selection.pending = false;
        confirmPayment.disabled = false;
        cancelPayment.disabled = false;
      }
    }
  });
  cancelPayment.addEventListener('click', () => dialog.close());
  dialog.addEventListener('cancel', event => {
    if (payment?.pending) event.preventDefault();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    payment = null;
    confirmPayment.disabled = false;
    cancelPayment.disabled = false;
  });

  function clearSearch() {
    filter = null;
    search.value = '';
    byId('fleetBolClearSearch').classList.add('hidden');
  }

  byId('fleetBolSearchForm').addEventListener('submit', event => {
    event.preventDefault();
    const value = search.value.trim().toUpperCase();
    const match = /^(?:([AB])-)?([0-9]{1,19})$/.exec(value);
    if (value && !match) {
      status.textContent = 'Enter a PRO number such as A-10001.';
      return;
    }
    filter = match;
    byId('fleetBolClearSearch').classList.toggle('hidden', !match);
    void read();
  });
  byId('fleetBolClearSearch').addEventListener('click', () => {
    clearSearch();
    search.focus();
    void read();
  });
  byId('fleetBolRefresh').addEventListener('click', () => void read());
  more.addEventListener('click', () => { if (cursor) void read(true); });
  tabs.forEach((tab, index) => tab.addEventListener('click', () => void selectTab(index)));
  byId('fleetBolTabs').addEventListener('keydown', event => {
    const index = tabs.indexOf(event.target);
    if (index === -1) return;
    const next = { ArrowLeft: 1 - index, ArrowRight: 1 - index, Home: 0, End: 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    tabs[next].focus();
    void selectTab(next);
  });

  function reset() {
    workspace = null;
    request = null;
    cursor = null;
    payment = null;
    if (dialog.open) dialog.close();
    lists.forEach(list => list.replaceChildren());
    clearSearch();
    status.textContent = '';
    more.classList.add('hidden');
  }

  function open(fleetId) {
    if (!currentUser) return;
    if (!fleetId) return showToast('Set your Fleet ID in Fleet Settings to open BOLs & Payments.');
    reset();
    workspace = { userId: currentUser.id, fleetId };
    showPage('fleetBolPaymentsPage');
    return selectTab(0);
  }

  byId('fleetBolBack').addEventListener('click', () => {
    reset();
    if (accountTypeFor(currentUser) === 'employee') void officeTools.openDashboard();
    else void showFleetSection('dashboard');
  });

  return { open, reset };
})();
