const loadHistoryGrid = (() => {
  function element(tag, text = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function bind(section, { columns, defaults, storageKey, dateFor, reference, onView, viewLabel = 'View run' }) {
    const head = section.querySelector('[data-history-head]');
    const body = section.querySelector('[data-history-rows]');
    const date = section.querySelector('[data-history-date]');
    const add = section.querySelector('[data-history-add]');
    const resetColumns = section.querySelector('[data-history-reset]');
    const empty = section.querySelector('[data-history-empty]');
    const fields = Object.entries(columns);
    let key;
    let layout;
    let renderedLayout;
    let rows = [];

    function loadLayout() {
      const nextKey = storageKey();
      if (layout && nextKey === key) return;
      if (key !== nextKey) date.value = '';
      key = nextKey;
      layout = [...defaults];
      if (!key) return;
      try {
        const saved = JSON.parse(localStorage.getItem(key));
        if (!Array.isArray(saved)) return;
        const valid = [...new Set(saved.filter(id => typeof id === 'string' && Object.hasOwn(columns, id)))];
        if (valid.length) layout = valid;
      } catch {}
    }

    function changeLayout() {
      if (key) {
        try { localStorage.setItem(key, JSON.stringify(layout)); } catch {}
      }
      paintHead();
      paintRows();
    }

    function paintHead() {
      const signature = layout.join(',');
      if (signature === renderedLayout) return;
      renderedLayout = signature;
      const unused = fields.filter(([id]) => !layout.includes(id));
      add.replaceChildren(new Option('Choose a field', ''), ...unused.map(([id, { label }]) => new Option(label, id)));
      add.disabled = !unused.length;
      const headers = layout.map((id, index) => {
        const cell = element('th');
        cell.scope = 'col';
        cell.dataset.column = id;
        const select = element('select');
        select.setAttribute('aria-label', 'Field for column ' + (index + 1));
        select.append(...fields.map(([value, { label }]) => new Option(label, value)));
        if (layout.length > 1) select.append(new Option('Remove column', ''));
        select.value = id;
        select.addEventListener('change', () => {
          const next = select.value;
          if (next === id) return;
          if (!next) layout.splice(index, 1);
          else {
            const existing = layout.indexOf(next);
            if (existing !== -1) layout[existing] = id;
            layout[index] = next;
          }
          changeLayout();
          const selectors = head.querySelectorAll('select');
          selectors[Math.min(index, selectors.length - 1)]?.focus();
        });
        cell.append(select);
        return cell;
      });
      const action = element('th', 'Run');
      action.scope = 'col';
      action.dataset.column = 'action';
      head.replaceChildren(...headers, action);
    }

    function paintRows() {
      const visible = date.value ? rows.filter(row => row.day === date.value) : rows;
      body.replaceChildren(...visible.map(({ load }) => {
        const row = element('tr');
        row.dataset.historyLoadId = load.id;
        for (const id of layout) {
          const cell = element(id === 'pro' ? 'th' : 'td');
          if (id === 'pro') cell.scope = 'row';
          cell.dataset.column = id;
          cell.append(columns[id].read(load) || '—');
          row.append(cell);
        }
        const action = element('td');
        action.dataset.column = 'action';
        const view = element('button', 'View');
        view.type = 'button';
        view.className = 'outline';
        view.setAttribute('aria-label', viewLabel + ' ' + reference(load));
        view.addEventListener('click', () => onView(load));
        action.append(view);
        row.append(action);
        return row;
      }));
      empty.classList.toggle('hidden', Boolean(rows.length));
    }

    function paint(loads) {
      loadLayout();
      rows = loads.map(load => ({ load, day: dateFor(load) }));
      const days = [...new Set(rows.map(row => row.day).filter(Boolean))];
      const previous = date.value;
      date.replaceChildren(new Option('All dates', ''), ...days.map(day => new Option(day, day)));
      date.value = days.includes(previous) ? previous : '';
      date.disabled = !days.length;
      paintHead();
      paintRows();
    }

    date.addEventListener('change', paintRows);
    add.addEventListener('change', () => {
      if (!add.value || layout.includes(add.value)) return;
      layout.push(add.value);
      changeLayout();
      if (add.disabled) [...head.querySelectorAll('select')].at(-1)?.focus();
    });
    resetColumns.addEventListener('click', () => {
      layout = [...defaults];
      changeLayout();
    });

    return {
      paint,
      reset() {
        key = layout = renderedLayout = undefined;
        rows = [];
        head.replaceChildren();
        body.replaceChildren();
        date.replaceChildren();
        add.replaceChildren();
      },
      focusRun(id) {
        const row = [...body.rows].find(item => item.dataset.historyLoadId === id);
        row?.querySelector('button').focus();
        return Boolean(row);
      }
    };
  }

  return { bind };
})();
