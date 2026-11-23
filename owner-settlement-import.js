const ownerSettlementImport = (() => {
  const find = id => document.getElementById(id);
  const panel = find('ownerSettlementImport');
  const documents = find('ownerSettlementDocuments');
  const uploadStatus = find('ownerSettlementUploadStatus');
  const input = find('ownerSettlementFiles');
  const status = find('ownerSettlementImportStatus');
  const records = find('ownerSettlementSavedList');
  const preview = find('ownerSettlementPreview');
  const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const formatMoney = cents => Number.isFinite(cents) ? currency.format(cents / 100) : '—';
  const formatMiles = miles => Number.isFinite(miles) ? miles.toLocaleString('en-US') : '—';
  const formatDate = date => date
    ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
  let view;
  let reading;

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

  function reset() {
    view = null;
    reading = null;
    togglePanel(false);
    input.value = '';
    input.disabled = false;
    status.textContent = '';
    uploadStatus.textContent = '';
    records.replaceChildren();
    preview.replaceChildren();
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

  function showSpreadsheet(data) {
    const summary = data.summary;
    const totals = [['Order pay', summary.orderPay], ['Fuel surcharge', summary.fuelSurcharge],
      ['Gross earnings', summary.gross], ['Driver deductions and credits', summary.driver],
      ['Driver subtotal', summary.gross + summary.driver], ['Carrier deductions and credits', summary.carrier],
      ['Printed net payout', summary.printedNet], ['Difference', summary.printedNet == null ? null : summary.net - summary.printedNet],
      ['Year-to-date earnings', summary.yearEarnings]];
    const title = node('h3', data.carrier);
    const facts = node('p', formatDate(data.periodStart) + ' – ' + formatDate(data.periodEnd) +
      ' · Pay date ' + formatDate(data.payDate), 'muted');
    const issues = data.issues?.length ? node('ul') : null;
    if (issues) issues.append(...data.issues.map(issue => node('li', issue)));
    const amounts = table('Settlement Summary', ['Pay item', 'Amount'],
      totals.map(([label, amount]) => [label, formatMoney(amount)]));
    const loads = table('Loads & Earnings', ['Load #', 'Origin', 'Destination', 'Shipped', 'Delivered', 'Tractor', 'Mileage',
      'Miles', 'Gross linehaul', 'Rate', 'Order pay', 'Fuel surcharge', 'Load total', 'Page'], data.loads.map(load => [
      load.number, load.origin || '—', load.destination || '—', formatDate(load.shipped), formatDate(load.delivered),
      load.tractor || '—', load.mileageType || '—', formatMiles(load.miles), formatMoney(load.gross),
      Number.isFinite(load.rate) ? load.rate + '%' : '—', formatMoney(load.pay), formatMoney(load.surcharge ?? 0),
      formatMoney(load.total), load.page
    ]));
    const charges = table('Deductions & Credits', ['Posted', 'Group', 'Description', 'Amount', 'Page'],
      data.charges.map(charge => [formatDate(charge.posted), charge.group, charge.description, formatMoney(charge.amount), charge.page]));
    const widgets = [title, facts, node('p', (issues ? 'Calculated payout ' : 'Net payout ') +
      formatMoney(summary.net), 'owner-settlement-payout')];
    if (issues) widgets.push(issues);
    widgets.push(amounts, node('p', data.loads.length + ' loads · ' + formatMiles(summary.loadedMiles) +
      ' loaded miles · ' + formatMiles(summary.emptyMiles) + ' empty miles', 'muted'), loads, charges);
    if (data.reserve.balance != null) {
      widgets.push(table('Repair Reserve', ['Balance detail', 'Amount'],
        [['Previous balance', formatMoney(data.reserve.prior)], ['Deposit this period', formatMoney(data.reserve.deposit)],
          ['New balance', formatMoney(data.reserve.balance)]]));
      widgets.push(node('p', 'The reserve deposit is included in the carrier deductions.', 'muted'));
    }
    preview.replaceChildren(...widgets);
  }

  function paintRecords(saved) {
    records.replaceChildren();
    for (const row of saved) {
      const action = node('button', formatDate(row.data.payDate) + ' · ' + formatMoney(row.data.summary.net), 'outline');
      action.type = 'button';
      action.addEventListener('click', () => {
        if (reading || currentUser !== view?.user) return;
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
      paintRecords(data);
    }
  }

  async function open() {
    if (!currentUser || accountTypeFor(currentUser) !== 'driver') return reset();
    if (view?.user === currentUser) return;
    reset();
    const request = { user: currentUser, saved: [] };
    view = request;
    const { data, error } = await supabaseClient.from('owner_settlement_import_access')
      .select('user_id').maybeSingle();
    if (request !== view || currentUser !== request.user) return;
    if (error) { view = null; return; }
    if (!data) return;
    togglePanel(true);
    try { await loadRecords(request); }
    catch (error) { if (request === view && currentUser === request.user) status.textContent = error.message; }
  }

  function revealSpreadsheet() {
    if (find('settlementPage').classList.contains('active')) showPage('spreadsheetPage');
    if (find('spreadsheetPage').classList.contains('active')) {
      documents.scrollIntoView?.({ block: 'start' });
    }
  }

  input.addEventListener('change', async () => {
    const request = view;
    const file = input.files?.[0];
    if (!request || currentUser !== request.user || reading || !file || panel.classList.contains('hidden')) return;
    const job = {};
    reading = job;
    input.disabled = true;
    const active = () => view === request && currentUser === request.user && reading === job;
    uploadStatus.textContent = 'Opening the statement…';
    preview.replaceChildren();
    try {
      const { statementFingerprint, readStatementPages } = await import('./owner-settlement-ocr.mjs?v=1');
      const documentHash = await statementFingerprint(file);
      if (!active()) return;
      const saved = request.saved.find(row => row.document_hash === documentHash);
      if (saved) {
        showSpreadsheet(saved.data);
        status.textContent = 'This statement was already imported.';
        revealSpreadsheet();
        return;
      }
      const pages = await readStatementPages(file, (page, total) => {
        if (active()) uploadStatus.textContent = 'Reading page ' + page + ' of ' + total + '…';
      });
      if (!active()) return;
      const { parseLavalleStatement } = await import('./owner-settlement-reader.mjs?v=1');
      const data = parseLavalleStatement(pages);
      if (!active()) return;
      showSpreadsheet(data);
      if (data.issues.length) {
        status.textContent = 'Needs Review. Choose the full, readable PDF and try again.';
        revealSpreadsheet();
        return;
      }
      uploadStatus.textContent = 'Payout matches. Saving the spreadsheet…';
      const { error } = await supabaseClient.from('owner_settlement_imports')
        .insert({ document_hash: documentHash, data });
      if (!active()) return;
      if (error && error.code !== '23505') throw new Error('The totals match, but the spreadsheet could not be saved. Choose the statement again to retry.');
      status.textContent = 'Spreadsheet saved. Payout matches the statement.';
      revealSpreadsheet();
      await loadRecords(request);
    } catch (error) {
      if (active()) {
        const message = error.message;
        uploadStatus.textContent = /^(Choose|This pilot reads|The totals match|Could not open your saved)/.test(message)
          ? message : 'Could not read the file. Try the original settlement PDF.';
      }
    } finally {
      if (active()) {
        reading = null;
        input.disabled = false;
        input.value = '';
        if (!find('settlementPage').classList.contains('active')) uploadStatus.textContent = '';
      }
    }
  });

  return { open, reset };
})();
