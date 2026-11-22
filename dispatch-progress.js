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

  function relayDriverId(load) {
    const resumeDriver = load.progress?.relay?.resumeDriverId;
    return load.second_driver_id || (resumeDriver === load.driver_id ? resumeDriver : null);
  }

  function loadSplit(load) {
    const { details } = load;
    const location = details.relayLocation;
    const address = [details.relayAddress, [details.relayCity, details.relayState, details.relayZip].filter(Boolean).join(' ')]
      .filter(Boolean).join(' · ');
    const date = details.relayDate;
    const drop = time(details.relayDrop);
    const pickup = time(details.relayPickup);
    const progress = load.progress?.relay || {};
    const departedAt = progress.departedAt || load.progress?.yardPickedUpAt;
    if (!load.second_driver_id && !['assigned', 'unknown'].includes(details.secondDriverMode) &&
        ![location, address, date, drop, pickup, progress.droppedAt, departedAt].some(Boolean)) return null;
    const status = departedAt ? 'Departed relay' : progress.droppedAt ? 'Dropped at relay' : 'Planned';
    return { location, address, date, drop, pickup, droppedAt: progress.droppedAt, departedAt, status,
      dropDriver: progress.dropDriver, departDriver: progress.departDriver };
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
    if (load.status === 'current' && load.progress?.relay?.droppedAt &&
        !load.progress.relay.departedAt && !load.progress.yardPickedUpAt) status = ['At Relay', 'progress'];
    if (load.progress?.breakdown?.active) status = ['Breakdown reported', 'breakdown'];
    else if (load.progress?.traffic?.active) status = ['Held up in traffic', 'traffic'];
    return { stops, next, stage, status };
  }

  function bind({ byId, toggle, element, button, getLoad, getLoads, getRouteNumber, loadDrivers, loadDriverContacts, displayedDriverIds, unassignedDriver, messageDriver,
    proLabel, describeRoute, editLoad,
    back, setProgress, hasUpdate, openRateConfirmation, canEdit, paintLeaseStatus, saveLoadAction, relayDriverChoices }) {
    const view = byId('dispatchLoadDetail');
    const manual = byId('dispatchArrivalForm');
    const messageButton = byId('dispatchDetailMessage');
    const messageDrivers = byId('dispatchMessageDrivers');
    const splitFacts = byId('dispatchSplitFacts');
    const splitDriver = element('select', '', 'dispatch-relay-driver');
    splitDriver.setAttribute('aria-label', 'Scheduled Driver 2');
    const milestones = ['Assigned', 'En Route to Pickup', 'At Pickup', 'In Transit', 'At Receiver', 'Complete'];
    let activeId;
    let selectedStop;
    let request;
    let historyDate = '';
    let splitFactsKey;
    let splitChoicesKey;

    const set = (id, text) => { byId(id).textContent = text; };
    const active = () => activeId && getLoad(activeId);
    const progressLabel = stop => (stop.kind === 'pickup' ? 'Pickup' : 'Delivery') + ' ' + (stop.index + 1);

    function fact(label, value) {
      const pair = element('div');
      pair.append(element('dt', label), element('dd', value || '—'));
      return pair;
    }

    function driverAssignment(drivers) {
      const pair = element('div');
      if (!drivers.length) {
        pair.append(element('dt', 'Assigned driver'), unassignedDriver('dd'));
        return pair;
      }
      const values = element('dd');
      for (const driver of drivers) {
        const contact = element('div', '', 'dispatch-assigned-driver');
        contact.append(element('strong', driver.name));
        if (driver.phone) {
          const phone = element(driver.dial ? 'a' : 'div', driver.phone);
          if (driver.dial) phone.href = 'tel:' + driver.dial;
          contact.append(phone);
        }
        values.append(contact);
      }
      pair.append(element('dt', drivers.length > 1 ? 'Assigned drivers' : 'Assigned driver'), values);
      return pair;
    }

    function paintSplit(load, split, drivers, readOnly) {
      toggle('dispatchDetailSplit', Boolean(split));
      if (!split) return;
      const { location, address, date, drop, pickup, droppedAt, departedAt, status, dropDriver, departDriver } = split;
      const relay = load.progress?.relay;
      set('dispatchSplitStatus', status);
      byId('dispatchSplitStatus').dataset.tone = departedAt ? 'complete' : droppedAt ? 'progress' : 'assigned';
      const first = dropDriver || drivers.find(driver => driver.id === load.driver_id)?.name;
      const scheduled = relayDriverId(load);
      const second = departDriver || drivers.find(driver => driver.id === scheduled)?.name;
      const active = load.status === 'current' && !departedAt;
      const assigning = active && Boolean(droppedAt);
      const choices = assigning ? relayDriverChoices(load) : [];
      const showPicker = assigning && choices.length > 0;
      const noSecondDriver = assigning && !showPicker && !scheduled;
      const facts = [
        ['Relay location', location], ['Relay address', address], ['Relay date', date],
        [droppedAt ? 'Dropped by' : 'Driver 1', first],
        [departedAt ? 'Departed with' : droppedAt ? 'Scheduled Driver 2' : 'Driver 2', second || 'Pending assignment'],
        ['Planned drop', drop],
        ['Planned pickup', pickup], ['Dropped', droppedAt && recordedTime(droppedAt)],
        ['Departed', departedAt && recordedTime(departedAt)],
        ['Drop truck', relay?.dropTruckNumber],
        ['Departure truck', relay?.departTruckNumber]
      ];
      const factsKey = JSON.stringify([showPicker, noSecondDriver, facts]);
      if (splitFactsKey !== factsKey) {
        splitFactsKey = factsKey;
        splitFacts.replaceChildren(...facts.filter(([, value]) => value).map(([label, value]) => {
          const pair = fact(label, value);
          if (label === 'Scheduled Driver 2') {
            const value = pair.lastElementChild;
            if (showPicker) value.replaceChildren(splitDriver);
            else if (noSecondDriver) value.append(element('div', 'No eligible active drivers are listed in Dispatch.', 'muted'));
          }
          return pair;
        }));
      }
      if (showPicker) {
        const choicesKey = JSON.stringify(choices);
        if (splitChoicesKey !== choicesKey) {
          splitChoicesKey = choicesKey;
          const placeholder = new Option('Pending assignment', '');
          placeholder.disabled = true;
          splitDriver.replaceChildren(placeholder, ...choices.map(({ id, name }) => new Option(name, id)));
        }
        const assigned = scheduled || '';
        if (splitDriver.value !== assigned) splitDriver.value = assigned;
        splitDriver.disabled = readOnly || Boolean(request);
      }
      toggle('dispatchSplitActions', active);
      toggle('dispatchSplitDrop', !droppedAt);
      toggle('dispatchSplitDepart', Boolean(droppedAt));
      byId('dispatchSplitDrop').disabled = readOnly || Boolean(request);
      const departure = byId('dispatchSplitDepart');
      departure.disabled = readOnly || Boolean(request) || !scheduled;
      departure.title = scheduled ? '' : 'Schedule a driver before departing the relay.';
    }

    function splitStop(split) {
      const entry = element('li', '', 'dispatch-detail-stop');
      entry.dataset.stopState = split.departedAt ? 'complete' : 'scheduled';
      entry.append(element('small', 'Load Split · ' + split.status, 'muted'),
        element('strong', split.location || 'Relay stop'));
      if (split.address) entry.append(element('p', split.address));
      const times = [split.date, split.drop && 'Planned drop ' + split.drop, split.pickup && 'Planned pickup ' + split.pickup];
      if (times.some(Boolean)) entry.append(element('p', times.filter(Boolean).join(' · '), 'muted'));
      if (split.droppedAt) entry.append(element('p', 'Dropped ' + recordedTime(split.droppedAt)));
      if (split.departedAt) entry.append(element('p', 'Departed ' + recordedTime(split.departedAt)));
      return entry;
    }

    function reachableDrivers(load) {
      const assigned = displayedDriverIds(load);
      return loadDriverContacts(load).filter(driver => assigned.includes(driver.id) && (driver.canMessage || driver.dial));
    }

    function closeMessageDrivers() {
      toggle('dispatchMessageDrivers', false);
      messageButton.setAttribute('aria-expanded', 'false');
      messageDrivers.replaceChildren();
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
      const split = loadSplit(load);
      const current = load.status === 'current';
      const contract = load.status === 'contract';
      const readOnly = !canEdit(load.id);
      const breakdown = load.progress?.breakdown;
      const traffic = load.progress?.traffic;
      set('dispatchDetailPro', contract ? 'Contract Route ' + getRouteNumber(load) : proLabel(load.pro_number));
      const routeNumber = getRouteNumber(load);
      set('dispatchDetailRoute', [routeNumber && !contract && 'Route ' + routeNumber, describeRoute(load)]
        .filter(Boolean).join(' · '));
      set('dispatchDetailStatus', contract ? 'Contract Load' : status[0]);
      byId('dispatchDetailStatus').dataset.tone = contract ? 'assigned' : status[1];
      paintLeaseStatus('dispatchDetailLock', load.id);
      toggle('dispatchBreakdown', Boolean(breakdown));
      byId('dispatchBreakdown').dataset.breakdown = String(breakdown?.active === true);
      if (breakdown) {
        set('dispatchBreakdownTitle', breakdown.active ? 'Breakdown reported' :
          breakdown.resolution === 'recovered' ? 'Load recovered' : 'Back on the road');
        set('dispatchBreakdownDescription', [recordedTime(breakdown.active ? breakdown.reportedAt : breakdown.resolvedAt),
          breakdown.location, breakdown.notes].filter(value => value && value !== '—').join(' · '));
      }
      toggle('dispatchTrafficAlert', Boolean(traffic?.active));
      byId('dispatchTrafficAlert').dataset.traffic = String(traffic?.active === true && !breakdown?.active);
      if (traffic?.active) set('dispatchTrafficAlert', ['Held up in traffic', traffic.location, traffic.notes].filter(Boolean).join(' · '));
      toggle('dispatchBreakdownActions', current && Boolean(breakdown?.active));
      byId('dispatchBreakdownResume').disabled = byId('dispatchBreakdownRecover').disabled = readOnly || Boolean(request);
      view.dataset.updated = String(hasUpdate(load.id));
      toggle('dispatchLiveUpdate', hasUpdate(load.id));
      toggle('dispatchDetailEdit', current || load.status === 'completed');
      toggle('dispatchDetailComplete', current);
      const drivers = loadDriverContacts(load);
      paintSplit(load, contract ? null : split, drivers, readOnly);
      const assigned = displayedDriverIds(load);
      const currentDrivers = drivers.filter(driver => assigned.includes(driver.id));
      toggle('dispatchDetailMessage', currentDrivers.length > 0);
      const reachable = reachableDrivers(load);
      messageButton.disabled = reachable.length === 0;
      messageButton.title = reachable.length ? '' : 'No linked conversation or phone number on file.';
      if (reachable.length < 2) closeMessageDrivers();
      byId('dispatchDetailEdit').disabled = readOnly || Boolean(request);
      byId('dispatchDetailComplete').disabled = readOnly || Boolean(request) || Boolean(breakdown?.active || traffic?.active);
      byId('dispatchLoadNoteList').replaceChildren(driverLoadWorkflow.loadNotes(load.progress?.loadNotes));
      for (const id of ['dispatchLoadNoteText', 'dispatchAddLoadNote', 'dispatchReportTraffic', 'dispatchClearTraffic']) {
        byId(id).disabled = readOnly || Boolean(request);
      }
      toggle('dispatchReportTraffic', current && !traffic?.active);
      toggle('dispatchClearTraffic', current && Boolean(traffic?.active));
      toggle('dispatchDetailProgress', !contract);
      toggle('dispatchDetailStart', current && stage === 0);
      byId('dispatchDetailStart').disabled = readOnly || Boolean(request);
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
      const lastTrailerReport = stops.findLast(stop => stop.progress.driverReport?.bobtail || stop.progress.driverReport?.trailer)
        ?.progress.driverReport;
      const trailer = Object.hasOwn(load.progress || {}, 'dispatchTrailerOverride') ? load.progress.dispatchTrailerOverride
        : lastTrailerReport?.bobtail ? 'Bobtail' : load.details.trailerNumber || lastTrailerReport?.trailer;
      const relay = load.progress?.relay;
      const truck = relay?.departedAt && Object.hasOwn(relay, 'departTruckNumber')
        ? relay.departTruckNumber : load.details.truckNumber;
      byId('dispatchDetailAssignment').replaceChildren(
        driverAssignment(currentDrivers), fact('Truck number', truck), fact('Trailer number', trailer),
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
        set('dispatchFinishStop', 'Depart ' + progressLabel(next));
        set('dispatchManualArrival', next.progress.arrivalAt ? 'Correct Arrival' : 'Enter Time Manually');
        for (const id of ['dispatchArrivedNow', 'dispatchManualArrival', 'dispatchFinishStop']) byId(id).disabled = readOnly || Boolean(request);
        byId('dispatchManualArrival').disabled ||= !next.zone;
      }
      if (selectedStop && selectedStop.loadId !== load.id) selectedStop = null;
      toggle('dispatchArrivalForm', Boolean(selectedStop) && current);
      manual.querySelector('[type=submit]').disabled = readOnly || Boolean(request);
      const stopRows = stops.map(stop => {
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
            correction.disabled = readOnly || Boolean(request);
            entry.append(correction);
          }
        }
        if (stop.progress.completedAt) entry.append(element('p', 'Departed ' + recordedTime(stop.progress.completedAt, stop.zone)));
        const report = stop.progress.driverReport;
        if (report) {
          const reported = [
            report.bobtail ? 'Departed bobtail' : report.trailer && 'Trailer ' + report.trailer,
            report.commodity,
            report.weight && 'Weight ' + report.weight,
            report.pieces && 'Pieces ' + report.pieces,
            report.bol && 'BOL ' + report.bol,
            report.droppedTrailer && 'Dropped ' + report.droppedTrailer,
            report.pickedTrailer && 'Picked up ' + report.pickedTrailer + ' (' + report.loadedState + ')'
          ].filter(Boolean);
          if (reported.length) entry.append(element('p', reported.join(' · '), 'muted'));
          const label = stop.kind === 'pickup' ? 'BOL' : 'delivery paperwork';
          entry.append(...driverLoadWorkflow.paperworkButtons(report, label, button));
        }
        return entry;
      });
      if (split && !contract) {
        const secondLeg = stops.findIndex(stop => stop.driver2 && stop.driver1 === false);
        const firstDelivery = stops.findIndex(stop => stop.kind === 'receiver');
        stopRows.splice(secondLeg >= 0 ? secondLeg : firstDelivery >= 0 ? firstDelivery : stopRows.length, 0, splitStop(split));
      }
      byId('dispatchDetailStops').replaceChildren(...stopRows);
      const details = load.details || {};
      const commodity = details.commodity === 'Other' ? details.commodityOther : details.commodity;
      const names = items => (items || []).map(stop => stop.company).filter(Boolean).join(' / ');
      const contacts = items => (items || []).map(driverLoadWorkflow.stopContact).filter(Boolean).join(' / ');
      const trailerStop = key => stops.find(stop => stop.key === key)?.company;
      const bobtail = details.trailerPickup === 'yes' && details.trailerPickupMode === 'bobtail';
      const trailerType = { fleet: 'Fleet', power_only: 'Power Only' }[details.trailerType];
      const relayAddress = split?.address;
      const money = value => value !== '' && value !== null && value !== undefined && Number.isFinite(Number(value))
        ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(Number(value)) : '';
      byId('dispatchDetailFreight').replaceChildren(
        fact('Truck number', truck), fact('Trailer number', details.trailerNumber),
        fact('Commodity', commodity), fact('Weight', details.weightLbs ? Number(details.weightLbs).toLocaleString() + ' lb' : ''),
        fact('Pieces', details.pieces), fact('Equipment', equipment),
        ...(trailerType ? [fact('Trailer type', trailerType)] : []),
        fact('Trailer drop', details.trailerDrop === 'yes' ? [details.trailerDropNumber,
          trailerStop(details.trailerDropStopId), details.trailerDropNotes].filter(Boolean).join(' · ') || 'Yes' : 'No'),
        fact('Trailer pickup', details.trailerPickup === 'yes' ? [bobtail ? 'Bobtail' : details.trailerPickupNumber,
          trailerStop(details.trailerPickupStopId), bobtail ? '' : details.trailerPickupNotes].filter(Boolean).join(' · ') || 'Yes' : 'No'),
        ...(bobtail && details.nextTrailerLocation ? [fact('Next trailer location', details.nextTrailerLocation)] : []),
        ...(bobtail && details.bobtailInstructions ? [fact('Bobtail instructions', details.bobtailInstructions)] : []),
        fact('Broker', details.brokerName), fact('Broker contact', [details.brokerPhone, details.brokerEmail].filter(Boolean).join(' · ')),
        fact('Shipper', names(details.pickups)), fact('Receiver', names(details.receivers)),
        fact('Shipper contact', contacts(details.pickups)), fact('Receiver contact', contacts(details.receivers)),
        ...(details.relayLocation ? [fact('Relay location', details.relayLocation)] : []),
        ...(relayAddress ? [fact('Relay address', relayAddress)] : []),
        fact('Loaded miles', details.loadedMiles ? Number(details.loadedMiles).toLocaleString() + ' mi' : ''),
        fact('Route / shipping number', [details.routeNumber, details.brokerLoadNumber].filter(Boolean).join(' · ')),
        fact('Pickup number', details.pickupNumber), fact('BOL number', details.bolNumber), fact('Stop pay', money(details.stopPay) || money(0)),
        fact('Additional driver pay', [money(details.driver1AdditionalPay), money(details.driver2AdditionalPay)].filter(Boolean).join(' / ') || money(0))
      );
      const docs = byId('dispatchDetailDocuments');
      docs.replaceChildren();
      if (details.rateConfirmation?.path) docs.append(button('View Rate Confirmation', () => openRateConfirmation(details.rateConfirmation)));
      else docs.append(element('p', 'Rate confirmation: Not uploaded', 'muted'));
      for (const stop of stops) {
        const report = stop.progress?.driverReport;
        const pickup = stop.kind === 'pickup';
        const context = stop.company || (pickup ? 'Pickup ' : 'Delivery ') + (stop.index + 1);
        const documents = driverLoadWorkflow.paperworkButtons(report, pickup ? 'signed pickup BOL' : 'signed delivery BOL', button, context);
        docs.append(...documents);
        if (pickup && !documents.length) docs.append(element('p', 'Pickup BOL: Not uploaded · ' + context, 'dispatch-document-missing'));
        docs.append(element('p', driverLoadWorkflow.lumperCharge(report) + ' · ' + context, 'muted'));
      }
      history(load);
    }

    async function record(action, key = null, instant = null) {
      const load = active();
      if (!load || request || !canEdit(load.id)) return;
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

    async function updateLoad(action, args, clearNote = false) {
      const load = active();
      if (!load || request || !canEdit(load.id)) return;
      const pending = {};
      request = pending;
      paint();
      try {
        if (await saveLoadAction(load, action, args) && clearNote && activeId === load.id) {
          byId('dispatchLoadNoteText').value = '';
        }
      }
      finally {
        if (request === pending) {
          request = null;
          paint();
        }
      }
    }

    function show(id) {
      closeMessageDrivers();
      if (activeId !== id) byId('dispatchLoadNoteText').value = '';
      if (!getLoad(id)) return;
      if (activeId !== id) historyDate = '';
      activeId = id;
      selectedStop = null;
      view.classList.remove('hidden');
      paint();
      byId('dispatchDetailPro').focus({ preventScroll: true });
    }

    function close() {
      closeMessageDrivers();
      activeId = null;
      selectedStop = null;
      view.classList.add('hidden');
    }

    byId('dispatchHistoryDate').addEventListener('change', event => {
      historyDate = event.target.value;
      if (active()) history(active());
    });
    byId('dispatchDetailBack').addEventListener('click', back);
    messageButton.addEventListener('click', () => {
      const load = active();
      if (!load) return;
      if (messageButton.getAttribute('aria-expanded') === 'true') return closeMessageDrivers();
      const choices = reachableDrivers(load);
      if (choices.length === 1) return messageDriver(choices[0]);
      if (!choices.length) return;
      messageDrivers.replaceChildren(...choices.map(choice => button(choice.name, () => {
        const driver = active() && reachableDrivers(active()).find(driver => driver.id === choice.id);
        closeMessageDrivers();
        if (driver) messageDriver(driver);
      })));
      toggle('dispatchMessageDrivers', true);
      messageButton.setAttribute('aria-expanded', 'true');
      messageDrivers.firstElementChild.focus();
    });
    messageDrivers.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeMessageDrivers();
      messageButton.focus();
    });
    byId('dispatchBreakdownResume').addEventListener('click', () => void updateLoad('resolve_breakdown',
      { report_id: active()?.progress?.breakdown?.id, resolution: 'back_on_road' }));
    byId('dispatchBreakdownRecover').addEventListener('click', () => void updateLoad('resolve_breakdown',
      { report_id: active()?.progress?.breakdown?.id, resolution: 'recovered' }));
    byId('dispatchLoadNoteForm').addEventListener('submit', event => {
      event.preventDefault();
      const note = byId('dispatchLoadNoteText').value.trim();
      if (note) void updateLoad('add_note', { note }, true);
      else byId('dispatchLoadNoteText').focus();
    });
    byId('dispatchReportTraffic').addEventListener('click', () => void updateLoad('report_traffic',
      { note: byId('dispatchLoadNoteText').value.trim() }, true));
    byId('dispatchClearTraffic').addEventListener('click', () => void updateLoad('clear_traffic',
      { report_id: active()?.progress?.traffic?.id }));
    byId('dispatchSplitDrop').addEventListener('click', () => void updateLoad('relay_drop'));
    byId('dispatchSplitDepart').addEventListener('click', () => void updateLoad('relay_depart'));
    splitDriver.addEventListener('change', () => {
      const load = active();
      const driver = splitDriver.value;
      if (load && driver && driver !== relayDriverId(load)) void updateLoad('relay_assign', { driver });
    });
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

  return { bind, summarize, appointment, clockText, time, recordedTime, localDateTime, relayDriverId };
})();
