const loadPaperworkPacket = (() => {
  const byId = id => document.getElementById(id);
  const dialog = byId('loadPaperworkPacketDialog');
  const title = byId('loadPaperworkPacketTitle');
  const broker = byId('loadPaperworkPacketBroker');
  const choices = byId('loadPaperworkPacketChoices');
  const documents = byId('loadPaperworkPacketDocuments');
  const missing = byId('loadPaperworkPacketMissing');
  const status = byId('loadPaperworkPacketStatus');
  const collect = byId('loadPaperworkPacketCollect');
  const save = byId('loadPaperworkPacketSave');
  const email = byId('loadPaperworkPacketEmail');
  let view;

  function active(scope) {
    return view === scope && dialog.open && scope.isCurrent();
  }

  function listDocuments(load) {
    const files = [];
    if (load.rate_confirmation) {
      files.push({ bucket:'dispatch-rate-confirmations', path:load.rate_confirmation, label:'Rate Confirmation' });
    }
    for (const file of load.paperwork) {
      const kind = file.kind === 'delivery' ? 'Proof of Delivery' : 'Signed BOL';
      files.push({
        bucket:'driver-load-documents', path:file.path,
        label:[kind, file.bol, file.company].filter(Boolean).join(' · ')
      });
    }
    return files.filter((file, index) => files.findIndex(other => other.bucket === file.bucket && other.path === file.path) === index);
  }

  function open(load, pro, isCurrent) {
    if (dialog.open || !isCurrent()) return;
    const files = listDocuments(load);
    const address = load.broker_email?.trim();
    const recipient = /^[^\s<>,;:@]+@[^\s<>,;:@]+\.[^\s<>,;:@]+$/.test(address || '') ? address : '';
    view = { files, pro, recipient, reference:load.broker_load_number, isCurrent };
    title.textContent = pro + ' Paperwork';
    broker.textContent = [load.broker_name, recipient, load.broker_load_number && 'Broker load # ' + load.broker_load_number]
      .filter(Boolean).join(' · ');
    broker.classList.toggle('hidden', !broker.textContent);
    const absent = [];
    if (!load.rate_confirmation) absent.push('No rate confirmation attached.');
    if (!load.paperwork.length) absent.push('No signed BOL or proof of delivery attached.');
    missing.textContent = absent.join(' ');
    missing.classList.toggle('hidden', !absent.length);
    choices.replaceChildren(...files.map((file, index) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = String(index);
      input.checked = true;
      label.append(input, document.createTextNode(file.label));
      return label;
    }));
    documents.classList.toggle('hidden', !files.length);
    documents.disabled = false;
    collect.disabled = !files.length;
    save.disabled = email.disabled = true;
    status.textContent = files.length ? 'Choose the documents to include in the PDF.' : 'No paperwork to collect for this load.';
    dialog.showModal();
  }

  function selectedFiles(scope) {
    return [...choices.querySelectorAll('input:checked')].map(input => scope.files[Number(input.value)]);
  }

  choices.addEventListener('change', () => {
    if (!view || !active(view)) return;
    view.pdf = null;
    const hasSelection = Boolean(selectedFiles(view).length);
    collect.disabled = !hasSelection;
    save.disabled = email.disabled = true;
    status.textContent = hasSelection ? 'Collect the selected documents to prepare the PDF.' : 'Select at least one document.';
  });

  collect.addEventListener('click', async () => {
    const scope = view;
    if (!scope || !active(scope) || scope.busy) return;
    const selected = selectedFiles(scope);
    if (!selected.length) return;
    scope.busy = true;
    scope.pdf = null;
    documents.disabled = collect.disabled = save.disabled = email.disabled = true;
    try {
      const files = [];
      for (const [index, file] of selected.entries()) {
        status.textContent = 'Collecting document ' + (index + 1) + ' of ' + selected.length + '…';
        const { data, error } = await supabaseClient.storage.from(file.bucket).download(file.path);
        if (!active(scope)) return;
        if (error || !data?.size) throw new Error('Could not retrieve ' + file.label + '.');
        files.push({ ...file, original:data });
      }
      status.textContent = 'Preparing the PDF…';
      const pdf = await driverPaperwork.buildPdf(files);
      if (!active(scope)) return;
      scope.pdf = new File([pdf], scope.pro + '-Paperwork.pdf', { type:'application/pdf' });
      save.disabled = email.disabled = false;
      status.textContent = 'PDF ready with ' + selected.length + (selected.length === 1 ? ' document.' : ' documents.');
    } catch (error) {
      if (active(scope)) status.textContent = (error.message || 'Could not prepare the PDF.') + ' Check the selected documents and try again.';
    } finally {
      if (active(scope)) {
        scope.busy = false;
        documents.disabled = collect.disabled = false;
      }
    }
  });

  function download(file, name) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function mimeBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('error', () => reject(reader.error), { once:true });
      reader.addEventListener('load', () => {
        const encoded = reader.result.slice(reader.result.indexOf(',') + 1);
        resolve(encoded.match(/.{1,76}/g).join('\r\n'));
      }, { once:true });
      reader.readAsDataURL(blob);
    });
  }

  async function emailDraft(scope, pdf, subject, message) {
    const boundary = 'RigTracker-' + crypto.randomUUID();
    const [text, attachment] = await Promise.all([mimeBase64(new Blob([message])), mimeBase64(pdf)]);
    const headers = [
      'X-Unsent: 1',
      ...(scope.recipient ? ['To: ' + scope.recipient] : []),
      'Subject: ' + subject,
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="' + boundary + '"'
    ];
    return new Blob([[
      ...headers, '', '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64', '', text,
      '--' + boundary, 'Content-Type: application/pdf; name="' + pdf.name + '"',
      'Content-Disposition: attachment; filename="' + pdf.name + '"',
      'Content-Transfer-Encoding: base64', '', attachment, '--' + boundary + '--', ''
    ].join('\r\n')], { type:'message/rfc822' });
  }

  save.addEventListener('click', () => {
    if (view && active(view) && view.pdf) download(view.pdf, view.pdf.name);
  });

  email.addEventListener('click', async () => {
    const scope = view;
    if (!scope || !active(scope) || !scope.pdf || scope.busy) return;
    const pdf = scope.pdf;
    const subject = 'Paperwork for ' + scope.pro;
    const reference = scope.reference ? '\nBroker load #: ' + scope.reference : '';
    const message = 'Attached is the paperwork for ' + scope.pro + '.' + reference;
    const share = { files:[pdf], title:subject, text:message };
    scope.busy = true;
    documents.disabled = collect.disabled = email.disabled = true;
    try {
      if (typeof navigator.share === 'function' && navigator.canShare?.({ files:share.files })) {
        try {
          await navigator.share(share);
          return;
        } catch (error) {
          if (error.name === 'AbortError') return;
        }
      }
      if (!active(scope)) return;
      const draft = await emailDraft(scope, pdf, subject, message);
      if (!active(scope)) return;
      download(draft, scope.pro + '-Paperwork.eml');
      status.textContent = 'Email draft downloaded with the PDF attached. Open the draft in your email app to send it.';
    } catch {
      if (active(scope)) status.textContent = 'Could not prepare the email. You can still save the PDF and attach it in your email app.';
    } finally {
      if (active(scope)) {
        scope.busy = false;
        documents.disabled = collect.disabled = email.disabled = false;
      }
    }
  });

  function reset() {
    view = null;
    if (dialog.open) dialog.close();
  }

  byId('loadPaperworkPacketClose').addEventListener('click', reset);
  dialog.addEventListener('close', () => { if (!dialog.open) view = null; });

  return { open, reset };
})();
