const ownerSettlementImport = (() => {
  const find = id => document.getElementById(id);
  const panel = find('ownerSettlementImport');
  const documents = find('ownerSettlementDocuments');
  const uploadStatus = find('ownerSettlementUploadStatus');
  const input = find('ownerSettlementFiles');
  const status = find('ownerSettlementImportStatus');
  const records = find('ownerSettlementSavedList');
  const preview = find('ownerSettlementPreview');
  const saveButton = find('ownerSettlementSave');
  const chooseFile = find('ownerSettlementChooseFile');
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const formatMoney = cents => Number.isFinite(cents) ? currency.format(cents / 100) : '—';
  const formatMiles = miles => Number.isFinite(miles) ? miles.toLocaleString('en-US') : '—';
  const formatDate = date => date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
  let view;
  let reading;
  let saving;
  let pending;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function togglePanel(visible) {
    panel.classList.toggle('hidden', !visible);
    documents.classList.toggle('hidden', !visible);
  }

  function setPending(draft) {
    pending = draft;
    saveButton.classList.toggle('hidden', !draft);
    saveButton.disabled = Boolean(saving);
  }

  function reset() {
    view = null;
    reading = null;
    saving = null;
    setPending(null);
    togglePanel(false);
    input.value = '';
    input.disabled = false;
    chooseFile.disabled = false;
    status.textContent = '';
    uploadStatus.textContent = '';
    records.replaceChildren();
    preview.replaceChildren();
    find('ownerSettlementDeductionsContext').textContent = '';
    find('ownerSettlementDeductionsTotal').textContent = '—';
    find('ownerSettlementDeductionsTables').replaceChildren();
  }

  function table(heading, headers, rows) {
    const wrapper = node('div', undefined, 'table-shell');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('aria-label', heading);
    const grid = node('table');
    const caption = node('caption', heading);
    const head = grid.createTHead().insertRow();
    for (const text of headers) {
      const header = node('th', text);
      header.scope = 'col';
      head.append(header);
    }
    const body = grid.createTBody();
    for (const cells of rows) {
      const row = body.insertRow();
      for (const value of cells) row.insertCell().textContent = value;
    }
    grid.prepend(caption);
    wrapper.append(grid);
    return wrapper;
  }

  function statementLabel(data) {
    return data.carrier + (data.reference ? ' · Statement #' + data.reference : '');
  }

  function reserveTable(reserve) {
    const panel = node('div');
    panel.append(table('Repair Reserve', ['Balance detail', 'Amount'],
      [['Previous balance', formatMoney(reserve.prior)], ['Deposit this period', formatMoney(reserve.deposit)],
        ['New balance', formatMoney(reserve.balance)]]),
    node('p', 'The reserve deposit is included in the carrier deductions.', 'muted'));
    return panel;
  }

  function showDeductions(data) {
    const categories = ['Fuel Purchases', 'Tolls', 'Fuel Card Fees', 'Other Driver Deductions', 'Carrier Deductions'];
    const groups = new Map(categories.map(category => [category, []]));
    for (const charge of data.charges) {
      const category = charge.group === 'Carrier' ? 'Carrier Deductions'
        : ({ Fuel: 'Fuel Purchases', Tolls: 'Tolls', 'Fuel card fees': 'Fuel Card Fees' })[
          ownerSettlementRecords.expenseCategory(charge.description)] ?? 'Other Driver Deductions';
      groups.get(category).push(charge);
    }
    const driver = node('div');
    const carrier = node('div');
    for (const [category, charges] of groups) {
      if (!charges.length) continue;
      const subtotal = charges.reduce((sum, charge) => sum + charge.amount, 0);
      const rows = charges.map(charge => [formatDate(charge.posted), charge.description, formatMoney(charge.amount), charge.page]);
      const section = table(category + ' · ' + formatMoney(subtotal), ['Posted', 'Description', 'Amount', 'Page'], rows);
      (category === 'Carrier Deductions' ? carrier : driver).append(section);
    }
    if (!data.charges.length) driver.append(node('p', 'No deductions recorded.', 'muted'));
    else driver.append(node('p', 'Driver deductions subtotal ' + formatMoney(data.summary.driver), 'owner-settlement-payout'));
    if (data.reserve.balance != null) carrier.append(reserveTable(data.reserve));
    find('ownerSettlementDeductionsContext').textContent = statementLabel(data) +
      ' · ' + formatDate(data.periodStart) + ' – ' + formatDate(data.periodEnd);
    find('ownerSettlementDeductionsTotal').textContent = formatMoney(data.summary.driver + data.summary.carrier);
    find('ownerSettlementDeductionsTables').replaceChildren(driver, carrier);
    showPage('ownerSettlementDeductionsPage');
  }

  function showSpreadsheet(data) {
    const summary = data.summary;
    const totals = [['Owner’s linehaul pay', summary.orderPay], ['Fuel surcharge', summary.fuelSurcharge],
      ['Gross earnings', summary.gross], ['Printed net payout', summary.printedNet],
      ['Difference', summary.printedNet == null ? null : summary.net - summary.printedNet], ['Year-to-date earnings', summary.yearEarnings]];
    const title = node('h3', statementLabel(data));
    const facts = node('p', formatDate(data.periodStart) + ' – ' + formatDate(data.periodEnd) +
      ' · Pay date ' + formatDate(data.payDate), 'muted');
    const issues = data.issues?.length ? node('ul') : null;
    if (issues) issues.append(...data.issues.map(issue => node('li', issue)));
    const amounts = table('Pay Summary', ['Pay item', 'Amount'], totals.map(([label, amount]) => [label, formatMoney(amount)]));
    const deductionButton = node('button', 'View Deductions · ' + formatMoney(summary.driver + summary.carrier), 'outline');
    deductionButton.type = 'button';
    deductionButton.addEventListener('click', () => showDeductions(data));
    const payout = node('p', (issues ? 'Calculated payout ' : 'Net payout ') + formatMoney(summary.net), 'owner-settlement-payout');
    const earnings = table('Loads & Earnings', ['Load #', 'Origin', 'Destination', 'Shipped', 'Delivered', 'Tractor', 'Mileage',
      'Miles', 'Gross linehaul', 'Rate', 'Owner pay', 'Fuel surcharge', 'Load total', 'Page'], data.loads.map(load => [
      load.number, load.origin || '—', load.destination || '—', formatDate(load.shipped), formatDate(load.delivered),
      load.tractor || '—', load.mileageType || '—', formatMiles(load.miles), formatMoney(load.gross),
      Number.isFinite(load.rate) ? load.rate + '%' : '—', formatMoney(load.pay), formatMoney(load.surcharge ?? 0),
      formatMoney(load.total), load.page
    ]));
    const loads = node('div');
    loads.append(node('p', data.loads.length + ' loads · ' + formatMiles(summary.loadedMiles) +
      ' loaded miles · ' + formatMiles(summary.emptyMiles) + ' empty miles', 'muted'), earnings);
    const overview = node('div', undefined, 'owner-statement-grid');
    const pay = node('div', undefined, 'panel owner-statement-summary');
    pay.append(payout, amounts, deductionButton);
    overview.append(loads, pay);
    if (data.reserve.balance != null) loads.append(reserveTable(data.reserve));
    preview.replaceChildren(title, facts, ...(issues ? [issues] : []), overview);
  }

  function paintRecords(saved) {
    records.replaceChildren();
    for (const row of saved) {
      const label = [row.data.reference, formatDate(row.data.payDate), formatMoney(row.data.summary.net)].filter(Boolean);
      const action = node('button', label.join(' · '), 'outline');
      action.type = 'button';
      action.addEventListener('click', () => {
        if (reading || saving || currentUser !== view?.user) return;
        setPending(null);
        showSpreadsheet(row.data);
        status.textContent = 'Saved settlement spreadsheet.';
      });
      records.append(action);
    }
  }

  async function loadRecords(request) {
    const { data, error } = await supabaseClient.from('owner_settlement_imports')
      .select('id,document_hash,data').order('created_at', { ascending: false });
    if (error) throw new Error('Could not open your saved spreadsheets. Try opening this page again.');
    if (request === view && currentUser === request.user) {
      request.saved = data;
      request.state = 'ready';
      paintRecords(data);
    }
  }

  function renderTaxIfOpen() {
    if (find('taxPage').classList.contains('active')) renderTax();
  }

  function taxRecords() {
    return view?.user === currentUser ? view : { state: 'unavailable', saved: [] };
  }

  async function open() {
    if (!currentUser || accountTypeFor(currentUser) !== 'driver') return reset();
    if (view?.user === currentUser && view.state !== 'error') return;
    reset();
    const request = { user: currentUser, saved: [], state: 'loading' };
    view = request;
    input.disabled = true;
    const active = () => request === view && currentUser === request.user;
    try {
      const { data, error } = await supabaseClient.from('owner_settlement_import_access')
        .select('user_id').maybeSingle();
      if (error) throw error;
      if (!active()) return;
      if (!data) {
        request.state = 'unavailable';
        return;
      }
      togglePanel(true);
      await loadRecords(request);
      if (active()) input.disabled = false;
    } catch {
      if (active()) {
        request.state = 'error';
        status.textContent = uploadStatus.textContent = 'Could not open your saved spreadsheets. Reopen this page to retry.';
      }
    } finally {
      if (active()) renderTaxIfOpen();
    }
  }

  function showExistingStatement(existing, data) {
    setPending(null);
    if (!data || ownerSettlementRecords.sameAmounts(existing.data, data)) {
      showSpreadsheet(existing.data);
      status.textContent = 'This statement was already imported.';
    } else {
      showSpreadsheet(existing.data);
      status.textContent = 'Needs Review. This statement number is saved with different figures. The saved spreadsheet is shown below.';
    }
    revealSpreadsheet();
  }

  function revealSpreadsheet() {
    if (find('settlementPage').classList.contains('active')) showPage('spreadsheetPage');
    if (find('spreadsheetPage').classList.contains('active')) {
      documents.scrollIntoView?.({ block: 'start' });
    }
  }

  chooseFile.addEventListener('click', () => {
    showPage('settlementPage');
    input.focus();
    if (!input.disabled) input.click();
  });

  input.addEventListener('change', async () => {
    const request = view;
    const file = input.files?.[0];
    if (!request || currentUser !== request.user || reading || saving || !file || panel.classList.contains('hidden')) return;
    const job = {};
    reading = job;
    input.disabled = chooseFile.disabled = true;
    const active = () => view === request && currentUser === request.user && reading === job;
    uploadStatus.textContent = 'Opening the statement…';
    status.textContent = '';
    setPending(null);
    preview.replaceChildren();
    try {
      const { statementFingerprint, readStatementPages } = await import('./owner-settlement-ocr.mjs?v=1');
      const documentHash = await statementFingerprint(file);
      if (!active()) return;
      const saved = request.saved.find(row => row.document_hash === documentHash);
      if (saved) {
        showExistingStatement(saved);
        return;
      }
      const pages = await readStatementPages(file, (page, total) => {
        if (active()) uploadStatus.textContent = 'Reading page ' + page + ' of ' + total + '…';
      });
      if (!active()) return;
      const { parseLavalleStatement } = await import('./owner-settlement-reader.mjs?v=reference-1');
      const data = parseLavalleStatement(pages);
      if (!active()) return;
      showSpreadsheet(data);
      if (data.issues.length) {
        status.textContent = 'Needs Review. Check the issues below. Choose the original PDF or enter the settlement manually.';
        revealSpreadsheet();
        return;
      }
      const previous = request.saved.find(row => ownerSettlementRecords.sameStatement(row.data, data));
      if (previous) return showExistingStatement(previous, data);
      setPending({ request, documentHash, data });
      status.textContent = 'Payout matches. Review the spreadsheet and select Save Settlement.';
      revealSpreadsheet();
    } catch (error) {
      if (active()) {
        const message = error.message;
        uploadStatus.textContent = /^(Choose|This pilot reads)/.test(message)
          ? message : 'Could not read the file. Try the original settlement PDF.';
      }
    } finally {
      if (active()) {
        reading = null;
        input.disabled = chooseFile.disabled = false;
        input.value = '';
        if (!find('settlementPage').classList.contains('active')) uploadStatus.textContent = '';
      }
    }
  });

  saveButton.addEventListener('click', async () => {
    if (!pending || reading || saving) return;
    const { request, documentHash, data } = pending;
    if (view !== request || currentUser !== request.user) return;
    const job = {};
    saving = job;
    const active = () => view === request && currentUser === request.user && saving === job;
    input.disabled = chooseFile.disabled = saveButton.disabled = true;
    status.textContent = 'Saving settlement…';
    try {
      const { data: saved, error } = await supabaseClient.from('owner_settlement_imports')
        .insert({ document_hash: documentHash, data }).select('id,document_hash,data').single();
      if (!active()) return;
      if (error?.code === '23505') {
        await loadRecords(request);
        if (!active()) return;
        const existing = request.saved.find(row => row.document_hash === documentHash ||
          ownerSettlementRecords.sameStatement(row.data, data));
        if (existing) {
          renderTaxIfOpen();
          return showExistingStatement(existing, data);
        }
      }
      if (error || !saved) throw new Error('Settlement save failed.');
      request.saved = [saved, ...request.saved.filter(row => row.id !== saved.id)];
      paintRecords(request.saved);
      setPending(null);
      status.textContent = 'Settlement saved. You can find it in Saved Settlement Documents.';
      renderTaxIfOpen();
    } catch {
      if (active()) status.textContent = 'Could not save the settlement. Your preview is still here. Select Save Settlement to try again.';
    } finally {
      if (active()) {
        saving = null;
        input.disabled = chooseFile.disabled = saveButton.disabled = false;
      }
    }
  });

  return { open, reset, taxRecords };
})();
