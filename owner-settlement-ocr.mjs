const pdfBase = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/legacy/build/';
const ocrBase = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/';
const maxPages = 15;
const maxFileBytes = 25 * 1024 * 1024;

function textLines(items) {
  const lines = [];
  const pieces = items.filter(item => item.str?.trim()).sort((a, b) => b.transform[5] - a.transform[5]);
  for (const item of pieces) {
    const y = item.transform[5];
    const last = lines.at(-1);
    if (last && Math.abs(last.y - y) <= 2.5) last.parts.push(item);
    else lines.push({ y, parts: [item] });
  }
  return lines.map(line => line.parts.sort((a, b) => a.transform[4] - b.transform[4])
    .map(item => item.str.trim()).join(' ')).join('\n');
}

function canvasFor(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  return canvas;
}

export async function statementFingerprint(file) {
  if (!/\.pdf$/i.test(file.name) || (file.type && file.type !== 'application/pdf')) {
    throw new Error('Choose a settlement PDF.');
  }
  if (file.size > maxFileBytes) throw new Error('Choose a PDF up to 25 MB.');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readStatementPages(file, report) {
  let worker;
  let pdf;
  async function recognize(canvas) {
    if (!worker) {
      const { createWorker } = await import(ocrBase + 'tesseract.esm.min.js');
      worker = await createWorker('eng', 1, {
        workerPath: ocrBase + 'worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',
        langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int'
      });
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
    }
    const result = await worker.recognize(canvas);
    return result.data.text;
  }
  try {
    const pages = [];
    const lib = await import(pdfBase + 'pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc = pdfBase + 'pdf.worker.min.mjs';
    pdf = await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false,
      stopAtErrors: true, enableXfa: false, standardFontDataUrl: new URL('../../standard_fonts/', pdfBase).href }).promise;
    if (pdf.numPages > maxPages) throw new Error('Choose a statement with 15 pages or fewer.');
    for (let number = 1; number <= pdf.numPages; number++) {
      report(number, pdf.numPages);
      const page = await pdf.getPage(number);
      const text = textLines((await page.getTextContent()).items);
      if (text.length > 70 && /Lavalle\s+Transportation/i.test(text) && /\$\s*\d/.test(text)) {
        pages.push(text);
      } else {
        const size = page.getViewport({ scale: 1 });
        const scale = Math.min(3, 2300 / Math.max(size.width, size.height));
        const viewport = page.getViewport({ scale });
        const canvas = canvasFor(viewport.width, viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        pages.push(await recognize(canvas));
      }
      page.cleanup();
    }
    return pages;
  } finally {
    await pdf?.destroy();
    await worker?.terminate();
  }
}
