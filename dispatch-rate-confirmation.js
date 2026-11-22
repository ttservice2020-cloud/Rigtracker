const dispatchRateConfirmation = (() => {
  const bucket = 'dispatch-rate-confirmations';
  const limit = 10 * 1024 * 1024;
  const types = {
    jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif'
  };
  const library = 'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/';
  let loading;

  function photo(file) {
    const extension = Object.keys(types).find(key => types[key] === file.type) ??
      /\.(jpe?g|png|webp|heic|heif)$/i.exec(file.name)?.[1].toLowerCase().replace(/^jpg$/, 'jpeg');
    if (!extension || (file.type && file.type !== 'application/octet-stream' && file.type !== types[extension])) {
      throw Error('Choose a JPEG, PNG, WebP, or HEIC photo.');
    }
    if (!file.size || file.size > limit) throw Error('Choose a photo under 10 MB.');
    return { file, extension, contentType: types[extension] };
  }

  function loadEngine() {
    loading ??= new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = library + 'tesseract.min.js';
      script.crossOrigin = 'anonymous';
      script.integrity = 'sha384-2BQ3U3OdKOb0Uczxqr41I9UvZkzr4V9Hv8uSzMMZAlmhsFClvdZX5wi5fDCzG+tM';
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => {
        script.remove();
        reject(Error('Could not load the photo scanner.'));
      };
      document.head.append(script);
    }).catch(error => { loading = null; throw error; });
    return loading;
  }

  function readField(lines, expression) {
    for (const line of lines) {
      const match = expression.exec(line);
      if (match) return match[1].trim();
    }
    return '';
  }

  function calendarDate(text) {
    const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(text);
    const iso = /^\d{4}-\d{2}-\d{2}\b/.exec(text);
    if (!us && !iso) return '';
    const value = iso ? iso[0] : [
      us[3].length === 2 ? '20' + us[3] : us[3],
      us[1].padStart(2, '0'), us[2].padStart(2, '0')
    ].join('-');
    const date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
  }

  function appointmentTime(text) {
    const match = /\b(\d{1,2}):([0-5]\d)\s*(am|pm)?\b/i.exec(text);
    if (!match) return '';
    let hours = Number(match[1]);
    const period = match[3]?.toLowerCase();
    if (period) {
      if (hours < 1 || hours > 12) return '';
      hours = hours % 12 + (period === 'pm' ? 12 : 0);
    }
    return hours < 24 ? String(hours).padStart(2, '0') + ':' + match[2] : '';
  }

  function parseStop(lines) {
    if (!lines.length) return {};
    const city = lines.map(line => /^(?:city\s*[:\-]\s*)?([\p{L}][\p{L} .'-]+)[, ]+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/u.exec(line)).find(Boolean);
    const date = readField(lines, /^(?:(?:pickup|delivery)\s+)?(?:date|appointment)\s*[:\-]\s*(.+)/i);
    return {
      company: readField(lines, /^(?:shipper|receiver|consignee|company|name)\s*[:\-]\s*(.+)/i),
      address: readField(lines, /^(?:street(?: address)?|address)\s*[:\-]\s*(\d+.+)/i) ||
        readField(lines, /^(\d+\s+.+\b(?:street|st|ave|avenue|road|rd|drive|dr|blvd|way|ln|lane|hwy|highway)\b.*)$/i),
      city: city?.[1].trim(), state: city?.[2], zip: city?.[3],
      date: calendarDate(date),
      from: appointmentTime(readField(lines, /^(?:(?:pickup|delivery)\s+)?(?:time|from)\s*[:\-]\s*(.+)/i) || date)
    };
  }

  function parse(text) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const money = readField(lines, /^(?:total(?: carrier)? rate|all[- ]in(?: rate)?|agreed rate|gross(?: broker)? rate|carrier rate|rate)\s*[:\-]\s*(?:USD\s*)?\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:USD)?$/i);
    const miles = readField(lines, /^(?:loaded miles|practical miles|mileage)\s*[:\-]\s*(\d[\d,]*(?:\.\d)?)\s*(?:mi(?:les)?)?$/i);
    const weight = readField(lines, /^(?:total weight|weight)\s*[:\-]\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:lbs?\.?|pounds)?$/i);
    const pieces = readField(lines, /^(?:pieces|piece count)\s*[:\-]\s*(\d[\d,]*)$/i);
    const pickup = [];
    const receiver = [];
    let section;
    for (const line of lines) {
      if (/^(?:pick[- ]?up|origin|shipper)\s*:?$/i.test(line)) section = pickup;
      else if (/^(?:delivery|destination|receiver|consignee)\s*:?$/i.test(line)) section = receiver;
      else if (/^(?:shipper|pick[- ]?up at)\s*[:\-]\s*\S/i.test(line)) {
        section = pickup;
        section.push(line.replace(/^pick[- ]?up at/i, 'Shipper'));
      } else if (/^(?:receiver|consignee|deliver to)\s*[:\-]\s*\S/i.test(line)) {
        section = receiver;
        section.push(line.replace(/^deliver to/i, 'Receiver'));
      } else if (section) section.push(line);
    }
    return {
      fields: {
        brokerName: readField(lines, /^(?:broker(?: name)?|brokerage)\s*[:\-]\s*(.+)/i),
        brokerLoadNumber: readField(lines, /^(?:(?:broker\s+)?load|reference)\s*(?:(?:no\.?|#|number|id)\s*)?[:#-]\s*([A-Z0-9][A-Z0-9._/-]*)$/i),
        pickupNumber: readField(lines, /^pick[- ]?up\s*(?:no\.?|#|number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._/-]*)$/i),
        payGross: money.replaceAll(',', ''), loadedMiles: miles.replaceAll(',', ''),
        weightLbs: weight.replaceAll(',', ''), pieces: pieces.replaceAll(',', '')
      },
      pickup: parseStop(pickup), receiver: parseStop(receiver)
    };
  }

  async function scan(attachment) {
    const engine = await loadEngine();
    const worker = await engine.createWorker('eng', 1, {
      workerPath: library + 'worker.min.js',
      corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@7.0.0'
    });
    let input = attachment.file;
    let bitmap;
    try {
      // Decode with the browser when it supports the photo format and cap large camera images.
      if (typeof createImageBitmap === 'function') {
        bitmap = await createImageBitmap(input).catch(() => null);
        if (bitmap) {
          const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(bitmap.width * scale);
          canvas.height = Math.round(bitmap.height * scale);
          canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          input = await new Promise(resolve => canvas.toBlob(resolve, 'image/png')) || input;
        }
      }
      const result = await worker.recognize(input);
      return parse(result.data.text);
    } finally {
      bitmap?.close();
      await worker.terminate();
    }
  }

  return { bucket, photo, scan };
})();
