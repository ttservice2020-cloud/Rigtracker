const reportPdf = (() => {
  const omitted = 'button, input, select, script, iframe, [hidden], [aria-hidden="true"], .hidden, .no-print, .payroll-statement-kicker';
  const blocks = 'article, section, header, footer, div, p, h1, h2, h3, h4, details, summary, dl, ul, ol, li, table';
  const width = 612;
  const height = 792;
  const margin = 42;

  function visibleText(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE || node.matches(omitted)) return '';
    return [...node.childNodes].map(visibleText).join(' ').replace(/\s+/g, ' ').trim();
  }

  function* content(node) {
    if (node.matches(omitted)) return;
    if (node.matches('table')) {
      for (const row of node.rows) {
        const cells = [...row.cells].filter(cell => !cell.matches(omitted));
        if (cells.length) yield { values: cells.map(visibleText), bold: cells.every(cell => cell.tagName === 'TH') };
      }
      return;
    }
    if (node.matches('dl')) {
      for (const term of node.querySelectorAll(':scope > dt')) {
        const value = term.nextElementSibling;
        if (value?.matches('dd') && !term.matches(omitted) && !value.matches(omitted)) {
          yield { values: [visibleText(term), visibleText(value)], weights: [0.65, 0.35] };
        }
      }
      return;
    }
    if (node.matches('h1, h2, h3, h4, summary')) {
      yield { values: [visibleText(node)], bold: true, size: node.matches('h1, h2') ? 15 : 12, gap: 7 };
      return;
    }
    let inline = [];
    for (const child of node.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE && (child.matches(blocks) || child.querySelector(blocks))) {
        if (inline.length) yield { values: [inline.join(' ')] };
        inline = [];
        yield* content(child);
      } else {
        const text = visibleText(child).trim();
        if (text) inline.push(text);
      }
    }
    if (inline.length) yield { values: [inline.join(' ')] };
  }

  function wrap(text, available, measure) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (measure(next) <= available) {
        line = next;
        continue;
      }
      if (line) lines.push(line);
      line = '';
      for (const character of word) {
        if (line && measure(line + character) > available) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  async function create(rows, title) {
    const PDFDocument = await driverPaperwork.loadPdfLibrary();
    const { StandardFonts, rgb } = window.PDFLib;
    const pdf = await PDFDocument.create();
    pdf.setTitle(title);
    const normal = await pdf.embedFont(StandardFonts.Helvetica);
    const strong = await pdf.embedFont(StandardFonts.HelveticaBold);
    const supported = new Set(normal.getCharacterSet());
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    let page = pdf.addPage([width, height]);
    let cursor = height - margin;

    const printable = text => [...text].every(character => supported.has(character.codePointAt(0)));
    for (const { values, weights, bold = false, size = 10, gap = 3 } of rows) {
      if (!values.some(Boolean)) continue;
      const font = bold ? strong : normal;
      const canvasFont = `${bold ? 'bold ' : ''}${size * 2}px Arial, sans-serif`;
      const measure = text => {
        if (printable(text)) return font.widthOfTextAtSize(text, size);
        context.font = canvasFont;
        return context.measureText(text).width / 2;
      };
      const available = width - margin * 2;
      const columns = values.map((value, index) => {
        const space = available * (weights?.[index] ?? 1 / values.length);
        return { space, lines: wrap(value, space - 9, measure) };
      });
      const lineCount = Math.max(...columns.map(column => column.lines.length));
      const lineHeight = size + 5;
      if (cursor - lineCount * lineHeight < margin && cursor < height - margin) {
        page = pdf.addPage([width, height]);
        cursor = height - margin;
      }
      for (let index = 0; index < lineCount; index++) {
        if (cursor - lineHeight < margin) {
          page = pdf.addPage([width, height]);
          cursor = height - margin;
        }
        let x = margin;
        for (const { space, lines } of columns) {
          const line = lines[index];
          if (line && printable(line)) {
            page.drawText(line, { x, y: cursor - size, font, size, color: rgb(0.1, 0.15, 0.21) });
          } else if (line) {
            canvas.width = Math.ceil(measure(line) * 2 + 4);
            canvas.height = lineHeight * 2;
            context.font = canvasFont;
            context.fillStyle = '#1a2636';
            context.textBaseline = 'alphabetic';
            context.fillText(line, 0, size * 2);
            const image = await pdf.embedPng(canvas.toDataURL('image/png'));
            page.drawImage(image, { x, y: cursor - lineHeight, width: canvas.width / 2, height: lineHeight });
          }
          x += space;
        }
        cursor -= lineHeight;
      }
      cursor -= gap;
    }
    const pages = pdf.getPages();
    pages.forEach((sheet, index) => {
      sheet.drawText(`Page ${index + 1} of ${pages.length}`, { x: margin, y: 22, font: normal, size: 9 });
    });
    return new Blob([await pdf.save()], { type: 'application/pdf' });
  }

  async function save(source, title, button) {
    if (button.disabled) return;
    const label = button.textContent;
    const viewer = currentUser;
    button.disabled = true;
    button.textContent = 'Preparing PDF…';
    try {
      const rows = [{ values: [title], bold: true, size: 18, gap: 12 }, ...content(source)];
      const pdf = await create(rows, title);
      if (currentUser !== viewer || !button.isConnected) return;
      const url = URL.createObjectURL(pdf);
      const link = document.createElement('a');
      link.href = url;
      link.download = (title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'Report') + '.pdf';
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch {
      if (currentUser === viewer && button.isConnected) showToast('Could not save the PDF. Try again.');
    } finally {
      button.textContent = label;
      button.disabled = false;
    }
  }

  return { save };
})();
