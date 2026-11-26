const driverPaperwork = (() => {
  const dialog = document.getElementById('driverPaperworkDialog');
  const bucket = 'driver-load-documents';
  const maxFiles = 20;
  const maxBytes = 10 * 1024 * 1024;
  const maxPhotoBytes = 32 * 1024 * 1024;
  const mimeByExtension = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf'
  };
  const extensionByMime = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf'
  };
  const acceptedFiles = Object.keys(extensionByMime).join(',') + ',.heic,.heif';
  let session;
  let pdfLibrary;

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function button(text, action, className = 'outline') {
    const control = element('button', text, className);
    control.type = 'button';
    control.addEventListener('click', action);
    return control;
  }

  function release() {
    if (!session) return;
    session.cancelScan?.();
    session.urls.forEach(url => URL.revokeObjectURL(url));
    document.body.classList.remove('printing-driver-paperwork');
    session = null;
    dialog.replaceChildren();
  }

  function close() {
    if (dialog.open) dialog.close();
    release();
  }

  dialog.addEventListener('close', () => {
    if (!dialog.open) release();
  });

  function show(title, subtitle) {
    close();
    const content = element('section', '', 'driver-paperwork-screen');
    const heading = element('h2', title);
    heading.id = 'driverPaperworkTitle';
    const header = element('header');
    header.append(button('Back', close, 'back'), heading);
    if (subtitle) header.append(element('p', subtitle, 'muted'));
    const body = element('div');
    content.append(header, body);
    dialog.replaceChildren(content);
    const view = { body, urls: new Set() };
    session = view;
    dialog.showModal();
    dialog.scrollTop = 0;
    return view;
  }

  function objectUrl(view, blob) {
    const url = URL.createObjectURL(blob);
    view.urls.add(url);
    return url;
  }

  function photo(src, description, fallbackText) {
    const img = element('img');
    img.alt = description;
    const preview = element('div', '', 'driver-paperwork-photo');
    preview.append(img);
    img.addEventListener('error', () => {
      preview.replaceChildren(element('span', fallbackText, 'muted'));
    }, { once: true });
    img.src = src;
    return preview;
  }

  function fileMime(file) {
    const extension = file.name.split('.').at(-1).toLowerCase();
    return file.type && file.type !== 'application/octet-stream' ? file.type : mimeByExtension[extension];
  }

  function edit(draft, title, subtitle, onChange, options = {}) {
    const view = show(title, subtitle);
    const limit = options.limit ?? maxFiles;
    const content = element('div');
    const gallery = element('ol', '', 'driver-paperwork-grid');
    const count = element('p', '', 'muted');
    count.setAttribute('role', 'status');
    const error = element('p', '', 'driver-paperwork-error');
    error.setAttribute('role', 'alert');
    let scanning = false;

    function paint() {
      gallery.replaceChildren(...draft.files.map(({ file, mime, scan }, index) => {
        const position = index + 1;
        const card = element('li', '', 'driver-paperwork-card');
        const thumb = mime === 'application/pdf' && !scan
          ? element('div', 'PDF', 'driver-paperwork-photo')
          : photo(objectUrl(view, scan || file), 'Page ' + position + ' preview', 'Preview unavailable');
        if (scan) thumb.firstElementChild.dataset.scan = '';
        card.append(thumb, element('p', position + '. ' + file.name));
        const remove = button('Remove', () => {
          draft.files.splice(index, 1);
          error.textContent = '';
          update();
          (gallery.children[Math.min(index, gallery.children.length - 1)]?.querySelector('button') || add).focus();
        });
        remove.setAttribute('aria-label', 'Remove ' + file.name);
        remove.disabled = Boolean(draft.saving) || scanning;
        card.append(remove);
        return card;
      }));
      const total = draft.files.length;
      count.textContent = scanning ? 'Preparing page…'
        : total ? total + (total === 1 ? ' file selected' : ' files selected') : 'No files selected';
      add.disabled = take.disabled = Boolean(draft.saving) || scanning || total >= limit;
      done.disabled = scanning || Boolean(options.save && (draft.saving || !total));
    }

    function update() {
      view.urls.forEach(url => URL.revokeObjectURL(url));
      view.urls.clear();
      paint();
      onChange();
    }

    function filePicker(accept) {
      const picker = element('input');
      picker.type = 'file';
      picker.accept = accept;
      picker.hidden = true;
      picker.addEventListener('change', async () => {
        if (session !== view || !dialog.open || draft.saving || scanning) return;
        const selected = [...picker.files];
        picker.value = '';
        if (!selected.length) return;
        const errors = new Set();
        scanning = Boolean(options.scan);
        if (scanning) {
          error.textContent = '';
          update();
        }
        for (const file of selected) {
          const mime = fileMime(file);
          const needsScan = Boolean(options.scan && mime?.startsWith('image/'));
          if (!Object.hasOwn(extensionByMime, mime) || !file.size) {
            errors.add(file.name + ' is not a supported photo or PDF.');
          } else if (file.size > (needsScan ? maxPhotoBytes : maxBytes)) {
            const maxSize = needsScan ? '32 MB for a photo you want to scan' : '10 MB per file';
            errors.add(file.name + ' exceeds ' + maxSize + '.');
          } else if (draft.files.length >= limit) {
            errors.add('You can add up to ' + limit + (limit === 1 ? ' more file.' : ' more files.'));
            break;
          } else {
            let entry = { file, mime };
            if (needsScan) {
              try {
                entry = await reviewScan(view, content, file, mime);
              } catch (failure) {
                errors.add('Could not scan ' + file.name + '. ' + (failure.message || '') +
                  ' Try again or choose an existing PDF.');
                continue;
              }
            }
            if (session !== view || !dialog.open) return;
            if (entry) draft.files.push(entry);
          }
        }
        if (session !== view || !dialog.open) return;
        scanning = false;
        error.textContent = [...errors].join(' ');
        update();
        if (options.scan) (draft.files.length && !done.disabled ? done : take).focus();
      });
      return picker;
    }

    const files = filePicker(acceptedFiles);
    files.multiple = true;
    const camera = filePicker('image/*');
    camera.setAttribute('capture', 'environment');
    const take = button(options.scan ? 'Scan Page' : 'Take photo', () => camera.click());
    const add = button('Add photos or PDF', () => files.click());
    const actions = element('div', '', 'driver-paperwork-actions');
    actions.append(take, add, camera, files);
    const footer = element('footer');
    const done = button(options.save ? 'Save Files' : 'Done', async () => {
      if (!options.save) return close();
      if (draft.saving || !draft.files.length || session !== view) return;
      draft.saving = true;
      error.textContent = '';
      done.textContent = 'Saving files…';
      update();
      try {
        await options.save();
        if (session === view) close();
      } catch (failure) {
        if (session === view) error.textContent = failure.message || 'Could not save the paperwork. Try again.';
      } finally {
        draft.saving = false;
        if (session === view) {
          done.textContent = 'Save Files';
          update();
        }
      }
    }, 'primary-btn');
    footer.append(done);
    content.append(actions);
    if (options.scan) content.append(element('p', 'Fit all four corners of the paper in the camera frame.', 'muted'));
    content.append(element('p', options.help || (options.save
      ? 'Choose files and save them to this stop.' : 'Files are attached when you save the stop.'), 'muted'),
    count, error, gallery, footer);
    view.body.append(content);
    paint();
  }

  function cornerEditor(source, points, message, onPreview, onDiscard) {
    const crop = element('div', '', 'driver-scan-crop');
    crop.style.width = `min(100%, ${source.width}px, ${60 * source.width / source.height}dvh)`;
    const canvas = element('canvas');
    const scale = Math.min(1, 900 / Math.max(source.width, source.height));
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    canvas.setAttribute('aria-hidden', 'true');
    crop.append(canvas);
    const context = canvas.getContext('2d');
    const status = element('p', '', 'driver-paperwork-error');
    status.setAttribute('role', 'status');
    const preview = button('Preview Scan', () => onPreview(points), 'primary-btn');
    const actions = element('div', '', 'driver-paperwork-actions');
    actions.append(button('Discard Photo', onDiscard), preview);
    const names = ['Top left', 'Top right', 'Bottom right', 'Bottom left'];
    const horizontal = source.width - 1;
    const vertical = source.height - 1;

    function paint() {
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const page = new Path2D();
      points.forEach(({ x, y }, index) => {
        const left = x * canvas.width / horizontal;
        const top = y * canvas.height / vertical;
        if (index === 0) page.moveTo(left, top);
        else page.lineTo(left, top);
        handles[index].style.left = `${100 * x / horizontal}%`;
        handles[index].style.top = `${100 * y / vertical}%`;
      });
      page.closePath();
      const outside = new Path2D(page);
      outside.rect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#0008';
      context.fill(outside, 'evenodd');
      context.lineWidth = 2;
      context.strokeStyle = '#5ce5ac';
      context.stroke(page);
      preview.disabled = !driverDocumentScan.validCorners(points, source);
      status.textContent = preview.disabled ? 'Keep the four corners in order around the page.' : '';
    }

    function move(index, x, y) {
      points[index] = { x: Math.max(0, Math.min(horizontal, x)), y: Math.max(0, Math.min(vertical, y)) };
      paint();
    }

    const handles = names.map((name, index) => {
      const handle = button('', () => {}, 'driver-scan-corner');
      handle.setAttribute('aria-label', name + ' corner. Use arrow keys to adjust.');
      handle.addEventListener('pointerdown', event => {
        if (event.button === 0) handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove', event => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        const bounds = canvas.getBoundingClientRect();
        move(index, (event.clientX - bounds.left) / bounds.width * horizontal,
          (event.clientY - bounds.top) / bounds.height * vertical);
      });
      handle.addEventListener('keydown', event => {
        const changes = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        if (!Object.hasOwn(changes, event.key)) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.05 : 0.01;
        const [dx, dy] = changes[event.key];
        move(index, points[index].x + dx * step * horizontal, points[index].y + dy * step * vertical);
      });
      crop.append(handle);
      return handle;
    });
    paint();
    return [element('h3', 'Adjust Page Corners'), element('p', message, 'muted'),
      crop, status, actions];
  }

  async function reviewScan(view, content, file, mime) {
    const source = await driverDocumentScan.read(file);
    if (session !== view || !dialog.open) return null;
    const detected = driverDocumentScan.detect(source);
    let points = detected || driverDocumentScan.fullPage(source);
    const editor = element('section', '', 'driver-scan-review');
    content.hidden = true;
    view.body.append(editor);
    dialog.scrollTop = 0;
    const active = () => session === view && dialog.open && editor.isConnected;
    let previewUrl;

    function clearPreview() {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }

    return new Promise(resolve => {
      function finish(entry = null) {
        clearPreview();
        editor.remove();
        content.hidden = false;
        view.cancelScan = null;
        resolve(entry);
      }
      view.cancelScan = finish;

      function adjust(message = 'Move the handles to the four corners of the paper.') {
        clearPreview();
        editor.replaceChildren(...cornerEditor(source, points, message, next => {
          points = next;
          void preview();
        }, () => finish()));
        dialog.scrollTop = 0;
        editor.querySelector('.driver-scan-corner').focus({ preventScroll: true });
      }

      async function preview() {
        const status = element('p', 'Straightening and cleaning the page…', 'muted');
        status.setAttribute('role', 'status');
        const img = element('img', '', 'driver-scan-preview');
        img.alt = 'Cleaned and straightened scan preview';
        img.hidden = true;
        const corners = button('Adjust Corners', () => adjust());
        const discard = button('Discard Photo', () => finish());
        const actions = element('div', '', 'driver-paperwork-actions');
        let scan;
        const use = button('Use Scan', async () => {
          use.disabled = corners.disabled = true;
          status.textContent = 'Creating PDF…';
          try {
            const pdf = await buildPdf([{ mime, scan }]);
            if (!active()) return;
            if (pdf.size > maxBytes) throw new Error('This PDF scan exceeds 10 MB.');
            const name = file.name.replace(/\.[^.]+$/, '') + '-scan.pdf';
            finish({ file: new File([pdf], name, { type: pdf.type }), mime: pdf.type, scan });
          } catch (failure) {
            if (!active()) return;
            status.textContent = failure.message || 'Could not create the PDF. Try again.';
            use.disabled = corners.disabled = false;
          }
        }, 'primary-btn');
        use.disabled = true;
        actions.append(discard, corners, use);
        editor.replaceChildren(element('h3', 'Scan Preview'), img, status, actions);
        dialog.scrollTop = 0;
        try {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (!active() || !editor.contains(img)) return;
          scan = await blobJpeg(driverDocumentScan.scan(source, points));
          if (!active() || !editor.contains(img)) return;
          previewUrl = URL.createObjectURL(scan);
          img.src = previewUrl;
          img.hidden = false;
          status.textContent = '';
          use.disabled = false;
          use.focus({ preventScroll: true });
        } catch (failure) {
          if (active() && editor.contains(img)) status.textContent = failure.message || 'Could not prepare the page. Adjust the corners and try again.';
        }
      }

      if (detected) void preview();
      else adjust('Could not detect the page edges. Move the handles to the four corners of the paper.');
    });
  }

  async function upload(loadId, userId, entry) {
    entry.path ??= loadId + '/' + userId + '/' + crypto.randomUUID() + (entry.scan ? '-scan' : '') + '.' + extensionByMime[entry.mime];
    if (!entry.uploaded) {
      const { error } = await supabaseClient.storage.from(bucket).upload(entry.path, entry.file, { contentType: entry.mime });
      if (error && String(error.statusCode ?? error.status) !== '409' && error.error !== 'Duplicate') throw error;
      entry.uploaded = true;
    }
    return entry.path;
  }

  function blobJpeg(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('This photo could not be prepared for printing.'));
    }, 'image/jpeg', 0.88));
  }

  async function scanPhoto(url) {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 2200 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const gray = pixels.data[index] * 0.299 + pixels.data[index + 1] * 0.587 + pixels.data[index + 2] * 0.114;
      const adjusted = (gray - 128) * 1.32 + 147;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = adjusted;
    }
    context.putImageData(pixels, 0, 0);
    return blobJpeg(canvas);
  }

  async function loadPdfLibrary() {
    if (window.PDFLib) return window.PDFLib.PDFDocument;
    pdfLibrary ??= new Promise((resolve, reject) => {
      const script = element('script');
      script.src = 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js';
      script.integrity = 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI';
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve(window.PDFLib.PDFDocument);
      script.onerror = () => reject(new Error('Could not load the PDF tools.'));
      document.head.append(script);
    }).catch(error => {
      pdfLibrary = null;
      throw error;
    });
    return pdfLibrary;
  }

  async function buildPdf(files) {
    const PDFDocument = await loadPdfLibrary();
    const pdf = await PDFDocument.create();
    for (const { mime, original, scan } of files) {
      if (mime === 'application/pdf') {
        const source = await PDFDocument.load(new Uint8Array(await original.arrayBuffer()));
        for (const page of await pdf.copyPages(source, source.getPageIndices())) pdf.addPage(page);
        continue;
      }
      if (!scan) throw new Error('A photo can’t be converted to PDF on this device. You can still download the originals.');
      const image = await pdf.embedJpg(new Uint8Array(await scan.arrayBuffer()));
      const page = pdf.addPage(image.width > image.height ? [792, 612] : [612, 792]);
      const { width, height } = image.scaleToFit(page.getWidth() - 48, page.getHeight() - 48);
      page.drawImage(image, { x: (page.getWidth() - width) / 2, y: (page.getHeight() - height) / 2, width, height });
    }
    return new Blob([await pdf.save()], { type: 'application/pdf' });
  }

  function printPhotos() {
    document.body.classList.add('printing-driver-paperwork');
    window.addEventListener('afterprint', () => document.body.classList.remove('printing-driver-paperwork'), { once: true });
    window.print();
  }

  async function open(paths, title = 'Stop paperwork') {
    const documents = Array.isArray(paths) ? paths : [paths];
    if (!documents.length) return;
    const user = currentUser;
    const view = show(title);
    const status = element('p', 'Loading paperwork…', 'muted');
    status.setAttribute('role', 'status');
    const actions = element('div', '', 'driver-paperwork-actions');
    const pages = element('ol', '', 'driver-paperwork-pages');
    view.body.append(actions, status, pages);
    const current = () => session === view && dialog.open && currentUser === user;
    const files = [];
    const fileNameBase = title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'paperwork';
    try {
      for (const [index, path] of documents.entries()) {
        status.textContent = 'Opening file ' + (index + 1) + ' of ' + documents.length + '…';
        const { data, error } = await supabaseClient.storage.from(bucket).download(path);
        if (!current()) return;
        if (error || !data) throw new Error('Could not open file ' + (index + 1) + '.');
        const extension = path.split('.').at(-1).toLowerCase();
        const mime = mimeByExtension[extension] || 'application/octet-stream';
        const original = data.slice(0, data.size, mime);
        const url = objectUrl(view, original);
        const page = element('li');
        const originalLink = element('a', 'Download original ' + (index + 1), 'outline driver-paperwork-download');
        originalLink.href = url;
        originalLink.download = fileNameBase + '-' + (index + 1) + '.' + extension;
        let scan = null;
        if (mime.startsWith('image/')) {
          if (path.endsWith('-scan.jpg')) scan = original;
          else try { scan = await scanPhoto(url); } catch {}
          if (!current()) return;
          page.append(photo(scan ? objectUrl(view, scan) : url, 'Page ' + (index + 1),
            'This photo can be downloaded to view on your device.'));
        } else if (mime === 'application/pdf') {
          const preview = element('iframe', '', 'driver-paperwork-pdf');
          preview.title = 'Original PDF ' + (index + 1);
          preview.src = url;
          page.append(preview);
        }
        page.append(originalLink);
        pages.append(page);
        files.push({ mime, original, scan });
      }
      const photosOnly = files.every(file => file.scan);
      const print = button('Print', printPhotos);
      if (photosOnly) actions.append(print);
      status.textContent = 'Preparing printable PDF…';
      const pdf = files.length === 1 && files[0].mime === 'application/pdf' ? files[0].original : await buildPdf(files);
      if (!current()) return;
      const pdfUrl = objectUrl(view, pdf);
      const download = element('a', 'Download PDF', 'outline driver-paperwork-download');
      download.href = pdfUrl;
      download.download = fileNameBase + '.pdf';
      actions.append(download);
      if (!photosOnly) {
        const frame = element('iframe', '', 'driver-paperwork-print-frame');
        frame.title = 'Printable paperwork';
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        const printPdf = button('Print', () => {
          try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
          } catch {
            status.textContent = 'Open the downloaded PDF to print it.';
          }
        });
        printPdf.disabled = true;
        frame.addEventListener('load', () => { printPdf.disabled = false; }, { once: true });
        frame.src = pdfUrl;
        view.body.append(frame);
        actions.prepend(printPdf);
      }
      status.textContent = '';
    } catch (error) {
      if (current()) status.textContent = files.length === documents.length
        ? 'Could not prepare the full PDF. Use the original files below.' : (error.message || 'Could not open the paperwork.');
    }
  }

  return { edit, upload, open, close, loadPdfLibrary };
})();
