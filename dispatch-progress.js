const dispatchProgress = (() => {
  const minute = 60_000;
  const formatters = new Map();

  function time(value) {
    const match = /^([01][0-9]|2[0-3]):?([0-5][0-9])$/.exec(value || '');
    return match ? match[1] + ':' + match[2] : '';
  }

  function clockText(instant, zone, seconds = false) {
    zone ||= undefined;
    const key = (zone || 'local') + (seconds ? ':seconds' : '');
    if (!formatters.has(key)) {
      formatters.set(key, new Intl.DateTimeFormat('en-US', {
        timeZone: zone, month: 'short', day: 'numeric', hour: '2-digit',
        minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23', timeZoneName: 'short'
      }));
    }
    return formatters.get(key).format(instant);
  }

  function localDateTime(instant, zone) {
    if (!formatters.has(zone + ':parts')) formatters.set(zone + ':parts', new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }));
    const fields = Object.fromEntries(formatters.get(zone + ':parts').formatToParts(instant).map(part => [part.type, part.value]));
    return fields.year + '-' + fields.month + '-' + fields.day + 'T' + fields.hour + ':' + fields.minute;
  }

  function instantFor(date, entry, zone) {
    const normalized = time(entry);
    if (!date || !normalized || !zone) return NaN;
    const requested = date + 'T' + normalized;
    const naive = Date.parse(requested + 'Z');
    if (!Number.isFinite(naive)) return NaN;
    try {
      const adjust = candidate => candidate + naive - Date.parse(localDateTime(candidate, zone) + 'Z');
      const result = adjust(adjust(naive));
      return localDateTime(result, zone) === requested ? result : NaN;
    } catch {
      return NaN;
    }
  }

  function stopsFor(load) {
    const records = load.progress?.stops || {};
    return [
      ...['pickup', 'receiver'].flatMap(kind => (load.details[kind === 'pickup' ? 'pickups' : 'receivers'] || [])
        .map((stop, index) => {
          const key = stop.stopId || kind + '-' + index;
          return {
            ...stop, kind, key, index,
            progress: records[key] || {},
            due: instantFor(stop.date, stop.from, stop.zone)
          };
        }))
    ];
  }

  const appointment = stop => Number.isFinite(stop.due) ? clockText(stop.due, stop.zone) : 'Unscheduled';
  function recordedTime(value, zone) {
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) return '—';
    try { return clockText(instant, zone); }
    catch { return clockText(instant); }
  }

  function summarize(load, now = Date.now()) {
    const stops = stopsFor(load);
    const next = stops.find(stop => !stop.progress.completedAt);
    const arrived = next?.progress.arrivalAt;
    const pickupDone = stops.some(stop => stop.kind === 'pickup' && stop.progress.completedAt);
    const started = Boolean(load.progress?.enRouteAt || pickupDone || arrived);
    const stage = load.status === 'completed' ? 5 : !next ? 4 : next.kind === 'receiver'
      ? (arrived ? 4 : 3) : arrived ? 2 : pickupDone ? 3 : started ? 1 : 0;
    let status = started ? ['In Progress', 'progress'] : ['Assigned', 'assigned'];
    if (load.status === 'completed') status = ['Complete', 'complete'];
    else if (!next) status = ['Stops Complete', 'complete'];
    else if (arrived) status = Date.parse(arrived) > next.due ? ['Checked In Late', 'late']
      : [next.kind === 'pickup' ? 'At Pickup' : 'At Receiver', 'progress'];
    else if (next.due <= now) status = ['Late', 'late'];
    else if (next.due - now <= 30 * minute) status = ['Warning', 'warning'];
    return { stops, next, stage, status };
  }

  function bind({ byId, toggle, element, button, getLoad, getLoads, getRouteNumber, loadDrivers, proLabel, describeRoute, editLoad,
    back, setProgress, hasUpdate, openRateConfirmation }) {
    const view = byId('dispatchLoadDetail');
    const manual = byId('dispatchArrivalForm');
    const milestones = ['Assigned', 'En Route to Pickup', 'At Pickup', 'In Transit', 'At Receiver', 'Complete'];
    let activeId;
    let selectedStop;
    let request;
    let historyDate = '';

    const set = (id, text) => { byId(id).textContent = text; };
    const active = () => activeId && getLoad(activeId);
    const progressLabel = stop => (stop.kind === 'pickup' ? 'Pickup' : 'Delivery') + ' ' + (stop.index + 1);

    function fact(label, value) {
      const pair = element('div');
      pair.append(element('dt', label), element('dd', value || '—'));
      return pair;
    }

    function openManual(stop) {
      const current = active();
      if (!current || current.status !== 'current' || request || !stop.zone) return;
      const value = localDateTime(stop.progress.arrivalAt ? Date.parse(stop.progress.arrivalAt) : Date.now(), stop.zone).split('T');
      selectedStop = { loadId: current.id, key: stop.key, zone: stop.zone };
      set('dispatchArrivalFormHeading', stop.progress.arrivalAt ? 'Correct ' + progressLabel(stop) + ' Arrival' : 'Record ' + progressLabel(stop) + ' Arrival');
      set('dispatchArrivalTimeLabel', 'Arrival time (HHMM · ' + clockText(Date.now(), stop.zone).split(' ').at(-1) + ')');
      manual.elements.date.value = value[0];
      manual.elements.time.value = value[1].replace(':', '');
      toggle('dispatchArrivalError', false);
      toggle('dispatchArrivalForm', true);
      manual.elements.time.focus();
    }

    function history(load) {
      const contract = load.status === 'contract' ? load : getLoad(load.contract_load_id);
      toggle('dispatchDetailHistory', Boolean(contract));
      if (!contract) return;
      set('dispatchHistoryRoute', 'Route ' + getRouteNumber(contract));
      const completedOn = run => run.progress?.completedAt || run.updated_at;
      const runDate = run => localDateTime(Date.parse(completedOn(run)), undefined).slice(0, 10);
      const rows = getLoads().filter(item => item.status === 'completed' && item.contract_load_id === contract.id && item.id !== load.id)
        .sort((a, b) => Date.parse(completedOn(b)) - Date.parse(completedOn(a)));
      const dates = [...new Set(rows.map(runDate))];
      if (!dates.includes(historyDate)) historyDate = '';
      const selector = byId('dispatchHistoryDate');
      selector.replaceChildren(new Option('All dates', ''), ...dates.map(date => new Option(date, date)));
      selector.value = historyDate;
      selector.disabled = !rows.length;
      const visible = historyDate ? rows.filter(run => runDate(run) === historyDate) : rows;
      byId('dispatchContractRuns').replaceChildren(...visible.map(run => {
        const row = element('li', '', 'dispatch-history-run');
        const completedAt = completedOn(run);
        row.append(element('strong', run.details.pickupNumber ? 'Pickup #' + run.details.pickupNumber : loadDrivers(run) || 'Contract run'),
          element('span', clockText(Date.parse(completedAt)), 'muted'));
        if (run.details.pickupNumber && loadDrivers(run)) row.append(element('span', loadDrivers(run), 'muted'));
        const visits = stopsFor(run).filter(stop => stop.progress.arrivalAt);
        if (visits.length) {
          row.append(element('span', visits.map(stop => progressLabel(stop) + ' · ' + recordedTime(stop.progress.arrivalAt, stop.zone)).join(' / '), 'muted'));
        }
        row.append(button('View Run', () => show(run.id)));
        return row;
      }));
      toggle('dispatchContractRunsEmpty', !rows.length);
    }

    function paint() {
      const load = active();
      if (!load) {
        if (activeId) back();
        return;
      }
      const summary = summarize(load);
      const { stops, next, stage, status } = summary;
      const current = load.status === 'current';
      const contract = load.status === 'contract';
      set('dispatchDetailPro', contract ? 'Contract Route ' + getRouteNumber(load) : proLabel(load.pro_number));
      const routeNumber = getRouteNumber(load);
      set('dispatchDetailRoute', [routeNumber && !contract && 'Route ' + routeNumber, describeRoute(load)]
        .filter(Boolean).join(' · '));
      set('dispatchDetailStatus', contract ? 'Contract Load' : status[0]);
      byId('dispatchDetailStatus').dataset.tone = contract ? 'assigned' : status[1];
      view.dataset.updated = String(hasUpdate(load.id));
      toggle('dispatchLiveUpdate', hasUpdate(load.id));
      toggle('dispatchDetailEdit', current);
      toggle('dispatchDetailComplete', current);
      byId('dispatchDetailComplete').disabled = Boolean(request);
      toggle('dispatchDetailProgress', !contract);
      toggle('dispatchDetailStart', current && stage === 0);
      byId('dispatchDetailStart').disabled = Boolean(request);
      byId('dispatchMilestones').replaceChildren(...milestones.map((label, index) => {
        const step = element('li');
        step.dataset.phase = index < stage ? 'done' : index === stage ? 'current' : 'next';
        if (index === stage) step.setAttribute('aria-current', 'step');
        const mark = element('span', index < stage ? '✓' : String(index + 1));
        mark.setAttribute('aria-hidden', 'true');
        step.append(mark, element('strong', label));
        return step;
      }));
      const equipment = load.details.equipmentType === 'Other' ? load.details.equipmentTypeOther : load.details.equipmentType;
      byId('dispatchDetailAssignment').replaceChildren(
        fact('Assigned driver', loadDrivers(load)), fact('Equipment', equipment),
        fact('Loaded miles', load.details.loadedMiles), fact('Pickup number', load.details.pickupNumber)
      );
      toggle('dispatchDetailArrival', Boolean(next) && current);
      if (next && current) {
        set('dispatchArrivalHeading', progressLabel(next) + ' Arrival');
        set('dispatchArrivalNote', next.progress.arrivalAt
          ? 'Arrived ' + recordedTime(next.progress.arrivalAt, next.zone)
          : (next.company || progressLabel(next)) + ' · ' + appointment(next));
        toggle('dispatchArrivedNow', !next.progress.arrivalAt);
        toggle('dispatchFinishStop', Boolean(next.progress.arrivalAt));
        set('dispatchManualArrival', next.progress.arrivalAt ? 'Correct Arrival' : 'Enter Time Manually');
        for (const id of ['dispatchArrivedNow', 'dispatchManualArrival', 'dispatchFinishStop']) byId(id).disabled = Boolean(request);
        byId('dispatchManualArrival').disabled ||= !next.zone;
      }
      if (selectedStop && selectedStop.loadId !== load.id) selectedStop = null;
      toggle('dispatchArrivalForm', Boolean(selectedStop) && current);
      manual.querySelector('[type=submit]').disabled = Boolean(request);
      byId('dispatchDetailStops').replaceChildren(...stops.map(stop => {
        const entry = element('li', '', 'dispatch-detail-stop');
        entry.dataset.stopState = stop.progress.completedAt ? 'complete' : stop === next ? 'next' : 'scheduled';
        entry.append(element('small', progressLabel(stop) + (stop === next ? ' · Next stop' : ''), 'muted'),
          element('strong', stop.company || progressLabel(stop)));
        const address = [stop.address, [stop.city, stop.state].filter(Boolean).join(', '), stop.zip].filter(Boolean).join(' · ');
        if (address) entry.append(element('p', address));
        entry.append(element('p', appointment(stop) + (time(stop.to) ? '–' + time(stop.to) : '')));
        if (stop.notes) entry.append(element('p', stop.notes, 'muted'));
        if (stop.progress.arrivalAt) {
          entry.append(element('p', 'Arrived ' + recordedTime(stop.progress.arrivalAt, stop.zone)));
          if (stop.progress.previousArrivalAt) entry.append(element('small', 'Previous arrival ' + recordedTime(stop.progress.previousArrivalAt, stop.zone), 'muted'));
          if (current && stop !== next && stop.zone) {
            const correction = button('Correct Arrival', () => openManual(stop));
            correction.disabled = Boolean(request);
            entry.append(correction);
          }
        }
        if (stop.progress.completedAt) entry.append(element('p', 'Departed ' + recordedTime(stop.progress.completedAt, stop.zone)));
        const report = stop.progress.driverReport;
        if (report) {
          const reported = [
            report.trailer && 'Trailer ' + report.trailer,
            report.commodity,
            report.weight && 'Weight ' + report.weight,
            report.pieces && 'Pieces ' + report.pieces,
            report.bol && 'BOL ' + report.bol,
            report.droppedTrailer && 'Dropped ' + report.droppedTrailer,
            report.pickedTrailer && 'Picked up ' + report.pickedTrailer + ' (' + report.loadedState + ')'
          ].filter(Boolean);
          if (reported.length) entry.append(element('p', reported.join(' · '), 'muted'));
          if (report.document) entry.append(button(stop.kind === 'pickup' ? 'View BOL' : 'View delivery paperwork',
            () => driverLoadWorkflow.openDocument(report.document)));
        }
        return entry;
      }));
      const details = load.details || {};
      toggle('dispatchDetailFreightPopup', current);
      const commodity = details.commodity === 'Other' ? details.commodityOther : details.commodity;
      const equipment = details.equipmentType === 'Other' ? details.equipmentTypeOther : details.equipmentType;
      const contacts = items => (items || []).map((stop, index) => [stop.company || 'Stop ' + (index + 1), stop.phone, stop.email].filter(Boolean).join(' · ')).filter(Boolean).join(' / ');
      const money = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))
        ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(value)) : '';
      byId('dispatchDetailFreight').replaceChildren(
        fact('Truck number', details.truckNumber), fact('Trailer number', details.trailerNumber),
        fact('Commodity', commodity), fact('Weight', details.weightLbs ? Number(details.weightLbs).toLocaleString() + ' lb' : ''),
        fact('Pieces', details.pieces), fact('Equipment', equipment),
        fact('Trailer drop', details.trailerDrop === 'yes' ? details.trailerDropNotes || 'Yes' : 'No'),
        fact('Trailer pickup', details.trailerPickup === 'yes' ? details.trailerPickupNotes || 'Yes' : 'No'),
        fact('Broker', details.brokerName), fact('Broker contact', [details.brokerPhone, details.brokerEmail].filter(Boolean).join(' · ')),
        fact('Shipper contacts', contacts(details.pickups)), fact('Receiver contacts', contacts(details.receivers)),
        fact('Loaded miles', details.loadedMiles ? Number(details.loadedMiles).toLocaleString() + ' mi' : ''),
        fact('Route / shipping number', [details.routeNumber, details.brokerLoadNumber].filter(Boolean).join(' · ')),
        fact('Pickup number', details.pickupNumber), fact('Stop pay', money(details.stopPay)),
        fact('Additional driver pay', [money(details.driver1AdditionalPay), money(details.driver2AdditionalPay)].filter(Boolean).join(' / '))
      );
      const docs = byId('dispatchDetailDocuments');
      docs.replaceChildren();
      if (details.rateConfirmation?.path) docs.append(button('View Rate Confirmation', () => openRateConfirmation(details.rateConfirmation)));
      else docs.append(element('p', 'Rate confirmation: Not uploaded', 'muted'));
      for (const stop of stops) {
        const report = stop.progress?.driverReport;
        if (stop.kind === 'pickup') {
          if (report?.document) docs.append(button('View signed pickup BOL · ' + (stop.company || 'Pickup ' + (stop.index + 1)), () => driverLoadWorkflow.openDocument(report.document)));
          else docs.append(element('p', 'Pickup BOL: Not uploaded · ' + (stop.company || 'Pickup ' + (stop.index + 1)), 'dispatch-document-missing'));
        } else if (report?.document) docs.append(button('View signed delivery BOL · ' + (stop.company || 'Delivery ' + (stop.index + 1)), () => driverLoadWorkflow.openDocument(report.document)));
        const lumper = report?.lumperFee;
        docs.append(element('p', !report ? 'Lumper fee: Driver update pending · ' + (stop.company || 'Stop')
          : lumper !== undefined && lumper !== '' && Number(lumper) > 0
            ? 'Lumper fee reported: ' + money(lumper) + ' · ' + (stop.company || 'Stop')
            : 'Lumper fee: None reported · ' + (stop.company || 'Stop'), 'muted'));
      }
      history(load);
    }

    async function record(action, key = null, instant = null) {
      const load = active();
      if (!load || request) return;
      const pending = {};
      request = pending;
      paint();
      try {
        const saved = await setProgress(load, action, key, instant);
        if (request !== pending) return;
        if (saved) selectedStop = null;
      } finally {
        if (request === pending) {
          request = null;
          paint();
        }
      }
    }

    function show(id) {
      if (!getLoad(id)) return;
      if (activeId !== id) historyDate = '';
      activeId = id;
      selectedStop = null;
      view.classList.remove('hidden');
      paint();
      byId('dispatchDetailPro').focus({ preventScroll: true });
    }

    function close() {
      activeId = null;
      selectedStop = null;
      view.classList.add('hidden');
    }

    byId('dispatchHistoryDate').addEventListener('change', event => {
      historyDate = event.target.value;
      if (active()) history(active());
    });
    byId('dispatchDetailBack').addEventListener('click', back);
    byId('dispatchDetailEdit').addEventListener('click', () => { if (active()) editLoad(active()); });
    byId('dispatchDetailStart').addEventListener('click', () => { void record('en_route'); });
    byId('dispatchDetailComplete').addEventListener('click', () => {
      if (active() && window.confirm('Mark this load completed and move it to Load History?')) void record('complete');
    });
    byId('dispatchArrivedNow').addEventListener('click', () => {
      const next = active() && summarize(active()).next;
      if (next && !next.progress.arrivalAt) void record('arrive', next.key);
    });
    byId('dispatchManualArrival').addEventListener('click', () => {
      const next = active() && summarize(active()).next;
      if (next) openManual(next);
    });
    byId('dispatchFinishStop').addEventListener('click', () => {
      const next = active() && summarize(active()).next;
      if (next?.progress.arrivalAt) void record('depart', next.key);
    });
    byId('dispatchArrivalCancel').addEventListener('click', () => {
      selectedStop = null;
      toggle('dispatchArrivalForm', false);
    });
    manual.addEventListener('submit', event => {
      event.preventDefault();
      if (!selectedStop) return;
      const instant = instantFor(manual.elements.date.value, manual.elements.time.value, selectedStop.zone);
      if (!Number.isFinite(instant) || instant > Date.now()) {
        toggle('dispatchArrivalError', true);
        return;
      }
      void record('arrive', selectedStop.key, new Date(instant).toISOString());
    });

    return { show, close, paint, id: () => activeId, reset: () => { request = null; close(); } };
  }

  return { bind, summarize, appointment, clockText, time, recordedTime };
})();
