const hazmatReference = (() => {
  const byId = id => document.getElementById(id);
  const query = byId('safetyReferenceSearch');
  const dialog = byId('hazmatMatchDialog');
  const regulation = 'https://www.ecfr.gov/current/title-49/section-172.101';
  const emergencyGuide = 'https://www.phmsa.dot.gov/training/hazmat/erg/emergency-response-guidebook-erg';
  const topics = [
    ['FMCSA Motor Carrier Safety Planner', 'handbook guides rules compliance regulations', 'https://csa.fmcsa.dot.gov/safetyplanner/'],
    ['Hours of Service', 'hos driver logs driving limit rest break sleeper berth 395', 'https://www.fmcsa.dot.gov/regulations/hours-service/summary-hours-service-regulations'],
    ['Electronic Logging Devices', 'eld logbook logs hours of service duty status', 'https://www.fmcsa.dot.gov/hours-service/elds/electronic-logging-devices'],
    ['Cargo Securement', 'cargo tie down load strap flatbed weight', 'https://www.fmcsa.dot.gov/regulations/cargo-securement/cargo-securement-rules'],
    ['Hazardous Materials Compliance', 'hazmat haz mat shipping papers placards labels transport permit cdl endorsement', 'https://www.fmcsa.dot.gov/regulations/hazardous-materials/how-comply-federal-hazardous-materials-regulations'],
    ['Hazmat Training and Education', 'hazmat classes cdl training endorsement emergency response drivers', 'https://www.fmcsa.dot.gov/regulations/hazardous-materials/training-education'],
    ['Emergency Response Guidebook', 'erg phmsa hazmat spill release emergency', emergencyGuide],
    ['DOT Hazardous Materials Table', 'hazmat proper shipping name class packing group un na dot ecfr 172.101', regulation],
    ['FMCSA Safety Resources and Forms', 'inspection maintenance dvir repair qualification cdl inspection report checklist handbook guide', 'https://csa.fmcsa.dot.gov/safetyplanner/resources/WebResources.aspx'],
    ['CDL Driver Manual', 'handbook commercial driver license pre trip inspection air brakes cargo hazmat tank vehicles', 'https://www.fmcsa.dot.gov/sites/fmcsa.dot.gov/files/docs/2005%20CDL%20DRIVER%20MANUAL%20FINAL%20July%202010.pdf']
  ];
  const classes = {
    1: 'Explosives', 2: 'Gases', '2.1': 'Flammable gas', '2.2': 'Non-flammable gas', '2.3': 'Poison gas',
    3: 'Flammable liquids', '4.1': 'Flammable solids', '4.2': 'Spontaneously combustible', '4.3': 'Dangerous when wet',
    '5.1': 'Oxidizers', '5.2': 'Organic peroxides', '6.1': 'Toxic substances', '6.2': 'Infectious substances',
    7: 'Radioactive materials', 8: 'Corrosive materials', 9: 'Miscellaneous hazardous materials',
    'Comb Liq': 'Combustible liquids'
  };
  const aliases = new Map([
    ['diesel', ['UN1202']], ['lithium batteries', ['UN3090', 'UN3091', 'UN3480', 'UN3481']],
    ['lithium ion batteries', ['UN3480', 'UN3481']], ['lithium metal batteries', ['UN3090', 'UN3091']],
    ['liquid zinc', ['UN3257']], ['molten zinc', ['UN3257']]
  ]);
  const namedNotes = new Map(['liquid zinc', 'molten zinc'].map(name => [name,
    'UN3257 is a possible match for molten zinc. Zinc solutions or mixtures can have a different classification.']));
  const wasteNote = 'Waste can change the classification. Confirm the proper shipping description for the waste as shipped.';
  const approximateNote = 'These are possible matches for the name entered. Use the identification number on the shipping papers to confirm.';
  const shipmentWords = new Set(['a', 'the', 'in', 'of', 'and', 'or', 'with', 'bulk', 'drum', 'drums', 'bag', 'bags',
    'box', 'boxes', 'pallet', 'pallets', 'kg', 'lb', 'lbs', 'gallon', 'gallons']);
  const broadWords = new Set(['parts', 'racks', 'solution', 'powder', 'liquid', 'solid', 'waste', 'mixture', 'material',
    'water', 'steel', 'plastic', 'wood', 'glass', 'food', 'metal', 'oil', 'paper']);
  const watched = new WeakMap();
  const pageSize = 24;
  const normalize = text => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9.]+/g, ' ').trim();
  const withNumbers = text => text.replace(/\b(un|na|id)[\s-]*(\d{4})\b/gi, '$1$2');
  const materialKey = text => normalize(withNumbers(text.replace(/\./g, ' '))).replace(/^the /, '');
  const materialWords = key => [...new Set(key.split(' ').filter(word => /[a-z]/.test(word) && !shipmentWords.has(word)))];
  const identificationNumbers = input => [...new Set([...input.matchAll(/\b(?:UN|NA|ID)\d{4}\b/gi)]
    .map(match => match[0].toUpperCase()))];
  const className = hazard => classes[hazard] || classes[/^\d+/.exec(hazard)?.[0]] || '';
  const classLabel = hazard => /^\d/.test(hazard) ? `Class ${hazard}${className(hazard) ? ' · ' + className(hazard) : ''}`
    : className(hazard) || hazard;
  let loading;
  let reference;
  let searchRevision = 0;
  let limit = pageSize;

  function element(tag, text = '', style = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    if (style) node.className = style;
    return node;
  }

  function link(label, url) {
    const anchor = element('a', label);
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }

  function add(map, key, item) {
    if (!key) return;
    const matches = map.get(key) || new Set();
    matches.add(item);
    map.set(key, matches);
  }

  function nameVariants(name) {
    const heading = name.split(/,?\s+see\s+/i)[0];
    return heading.split(/,?\s+or\s+(?=[A-Z][a-z])/).flatMap(label => [label,
      label.split(/\s+includ(?:e|es|ing)\s+|,?\s+(?:with|containing)\s+/i)[0]]);
  }

  function load() {
    loading ??= fetch('./hazmat-table.json?v=2025-10-01-2').then(async response => {
      if (!response.ok) throw new Error('Could not load the hazardous materials table.');
      const { edition, entries } = await response.json();
      const numbers = new Map();
      const names = new Map();
      const variants = new Map();
      for (const entry of entries) {
        const [name, number] = entry;
        add(numbers, number, entry);
        add(names, materialKey(name), entry);
        for (const heading of nameVariants(name)) add(variants, materialKey(heading), entry);
      }
      const searchableNames = [...variants].map(([name, matches]) => ({ words: materialWords(name), matches }));
      reference = { edition, entries, numbers, names, variants, searchableNames };
      return reference;
    }).catch(error => {
      loading = null;
      throw error;
    });
    return loading;
  }

  function findName(data, key) {
    const relatedIds = aliases.get(key.replace(/battery$/, 'batteries'));
    if (relatedIds) return relatedIds.flatMap(id => [...(data.numbers.get(id) || [])]);
    return [...(data.names.get(key) || data.variants.get(key) || [])];
  }

  function closeSpelling(first, second) {
    if (Math.min(first.length, second.length) < 5 || first[0] !== second[0] || Math.abs(first.length - second.length) > 1) return false;
    let index = 0;
    while (index < first.length && first[index] === second[index]) index++;
    if (first.length > second.length) return first.slice(index + 1) === second.slice(index);
    if (second.length > first.length) return first.slice(index) === second.slice(index + 1);
    return first.slice(index + 1) === second.slice(index + 1) ||
      (first[index] === second[index + 1] && first[index + 1] === second[index] && first.slice(index + 2) === second.slice(index + 2));
  }

  function similarNames(data, key) {
    const inputWords = materialWords(key);
    if (!inputWords.length || inputWords.every(word => broadWords.has(word) || word.length < 4)) return [];
    const matches = new Set();
    const possibleTypos = new Set();
    for (const item of data.searchableNames) {
      if (inputWords.length === 1 && !closeSpelling(inputWords[0], item.words[0] || '') && inputWords[0] !== item.words[0]) continue;
      const missing = inputWords.filter(word => !item.words.includes(word));
      if (!missing.length) {
        for (const entry of item.matches) matches.add(entry);
      } else if (missing.length === 1 && (inputWords.length > 1 || key.length >= 6) &&
          item.words.some(word => !inputWords.includes(word) && closeSpelling(missing[0], word))) {
        for (const entry of item.matches) possibleTypos.add(entry);
      }
    }
    return [...(matches.size ? matches : possibleTypos)];
  }

  function includeReferences(data, entries) {
    const matches = new Set(entries);
    for (const [name, number, hazard] of entries) {
      if (number || hazard) continue;
      const [, target] = name.split(/,?\s+see\s+/i);
      if (!target) continue;
      for (const id of identificationNumbers(withNumbers(target))) {
        for (const entry of data.numbers.get(id) || []) matches.add(entry);
      }
      for (const variant of nameVariants(target)) {
        for (const entry of findName(data, materialKey(variant))) matches.add(entry);
      }
    }
    return [...matches];
  }

  function matchNumbers(data, ids) {
    const matches = ids.flatMap(id => [...(data?.numbers.get(id) || [])]);
    const missing = ids.filter(id => !data?.numbers.has(id));
    const note = missing.length ? `Check ${missing.join(', ')} in the current DOT table.` : '';
    return { matches, note, alert: true };
  }

  function identify(data, text) {
    const input = withNumbers(text);
    const key = materialKey(input);
    if (data.names.has(key)) return { matches: includeReferences(data, [...data.names.get(key)]), note: '', alert: true };
    const ids = identificationNumbers(input);
    if (!ids.length && /^\d{4}$/.test(key)) {
      ids.push(...['UN', 'NA', 'ID'].map(prefix => prefix + key).filter(id => data.numbers.has(id)));
    }
    if (ids.length) return matchNumbers(data, ids);
    const exact = findName(data, key);
    if (exact.length) return { matches: includeReferences(data, exact), note: namedNotes.get(key) || '', alert: true };
    const material = key.replace(/\bwaste\b/g, ' ').replace(/\s+/g, ' ').trim();
    const waste = material !== key;
    const base = waste ? findName(data, material) : [];
    const matches = includeReferences(data, base.length ? base : similarNames(data, material));
    const note = [namedNotes.get(material), waste && wasteNote, !base.length && approximateNote].filter(Boolean).join(' ');
    return { matches, note: matches.length ? note : '', alert: matches.length > 0 };
  }

  function resultRow([name, number, hazard, packing, labels, symbols]) {
    const item = element('li');
    item.append(element('strong', name));
    const fields = [number, classLabel(hazard), packing && 'Packing group ' + packing, labels && 'Label codes ' + labels,
      symbols && 'Table symbols ' + symbols].filter(Boolean);
    if (fields.length) item.append(element('p', fields.join(' · '), 'muted'));
    return item;
  }

  function openMatch({ matches, note }) {
    byId('hazmatMatchList').replaceChildren(...matches.slice(0, pageSize).map(resultRow));
    byId('hazmatMatchNote').textContent = note;
    byId('hazmatMatchNote').hidden = !note;
    const more = matches.length > pageSize ? ` Showing ${pageSize} of ${matches.length} matches. Use Safety search for more.` : '';
    byId('hazmatMatchStatus').textContent = reference ? `DOT table edition ${reference.edition}.${more}` : 'The local DOT table is unavailable.';
    if (!dialog.open) dialog.showModal();
  }

  async function update(control) {
    const item = watched.get(control);
    if (!item) return;
    const value = control.value.trim();
    item.button.hidden = true;
    item.result = null;
    if (!value) { item.status.textContent = ''; return; }
    const entered = identificationNumbers(withNumbers(value));
    if (entered.length && !reference) {
      item.result = matchNumbers(null, entered);
      item.button.hidden = false;
      item.status.textContent = 'Hazmat reference available.';
    }
    try {
      const data = await load();
      if (control.value.trim() !== value) return;
      item.result = identify(data, value);
      item.button.hidden = !item.result.alert;
      item.status.textContent = item.result.alert ? 'Hazmat reference available.' : '';
    } catch {
      // The commodity field stays editable when the reference cannot load.
      if (control.value.trim() === value && !item.result) item.status.textContent = '';
    }
  }

  function watch(control, field = control) {
    const row = element('div', '', 'hazmat-input');
    const button = element('button', 'Hazmat Info', 'outline hazmat-flag');
    const status = element('span', '', 'hazmat-match-announcement');
    status.setAttribute('role', 'status');
    button.type = 'button';
    button.hidden = true;
    button.setAttribute('aria-label', 'Possible hazmat match. View DOT reference.');
    const item = { button, status, result: null };
    watched.set(control, item);
    field.replaceWith(row);
    row.append(field, button, status);
    control.addEventListener('input', () => void update(control));
    button.addEventListener('click', () => { if (item.result?.alert) openMatch(item.result); });
    void update(control);
    return row;
  }

  function paintTopics(words) {
    byId('safetyReferenceTopics').replaceChildren(...topics.filter(([title, keywords]) => {
      const text = normalize(title + ' ' + keywords);
      return words.every(word => text.includes(word));
    }).map(([title, , url]) => {
      const item = element('li');
      item.append(link(title, url));
      return item;
    }));
  }

  async function search() {
    const revision = ++searchRevision;
    const text = normalize(withNumbers(query.value));
    const words = text ? text.split(' ') : [];
    paintTopics(words);
    const status = byId('safetyReferenceStatus');
    const results = byId('safetyReferenceMaterials');
    const more = byId('safetyReferenceMore');
    if (!reference) status.textContent = 'Loading the DOT hazardous materials table…';
    try {
      const data = await load();
      if (revision !== searchRevision) return;
      const suggested = identify(data, query.value);
      const hazard = /^(?:class |division )?(\d(?:\.\d)?)(?:\s|$)/.exec(text)?.[1];
      const filtered = data.entries.filter(([name, number, division, packing]) => {
        if (hazard && (text === hazard || text === 'class ' + hazard || text === 'division ' + hazard)) {
          return (division.match(/^\d+(?:\.\d+)?/)?.[0] || '').split('.').slice(0, hazard.includes('.') ? 2 : 1).join('.') === hazard;
        }
        const searchable = normalize([name, number, classLabel(division), packing].join(' '));
        return words.every(word => searchable.includes(word));
      });
      const entries = [...new Set([...suggested.matches, ...filtered])];
      const matches = entries.slice(0, limit);
      results.replaceChildren(...matches.map(resultRow));
      more.hidden = matches.length === entries.length;
      status.textContent = entries.length ? `${suggested.note ? suggested.note + ' ' : ''}Showing ${matches.length.toLocaleString()} of ${entries.length.toLocaleString()} DOT entries · ${data.edition} edition`
        : 'No DOT entries matched. Try a proper shipping name, UN/NA number, or hazard class.';
    } catch {
      if (revision === searchRevision) status.textContent = 'Could not load the local table. Open the current DOT table below.';
    }
  }

  query.addEventListener('input', () => { limit = pageSize; void search(); });
  byId('safetyReferenceMore').addEventListener('click', () => { limit += pageSize; void search(); });
  byId('hazmatMatchClose').addEventListener('click', () => dialog.close());

  function reset() {
    if (dialog.open) dialog.close();
    byId('hazmatMatchList').replaceChildren();
    byId('hazmatMatchNote').textContent = '';
    byId('safetyReferenceTopics').replaceChildren();
    byId('safetyReferenceMaterials').replaceChildren();
    byId('safetyReferenceStatus').textContent = '';
    byId('safetyReferenceMore').hidden = true;
    searchRevision++;
    query.value = '';
    limit = pageSize;
  }

  return { watch, update, search, reset };
})();
