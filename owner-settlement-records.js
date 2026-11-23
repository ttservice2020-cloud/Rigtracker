const ownerSettlementRecords = (() => {
  const normalized = value => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  const reference = value => normalized(value).replace(/^#\s*/, '');
  const cents = value => Math.round((Number(value) || 0) * 100);

  function sameStatement(first, second) {
    if (normalized(first.carrier) !== normalized(second.carrier)) return false;
    const firstRef = reference(first.reference);
    const secondRef = reference(second.reference);
    if (firstRef && secondRef) return firstRef === secondRef;
    return first.payDate === second.payDate && first.periodStart === second.periodStart && first.periodEnd === second.periodEnd &&
      first.loads.length > 0 && loadNumbers(first) === loadNumbers(second);
  }

  function loadNumbers(record) {
    return record.loads.map(load => load.number).sort().join('|');
  }

  function sameAmounts(first, second) {
    const amountRows = record => JSON.stringify([
      record.payDate, record.periodStart, record.periodEnd,
      record.summary.gross, record.summary.driver, record.summary.carrier, record.summary.net,
      record.reserve?.prior, record.reserve?.deposit, record.reserve?.balance,
      record.loads.map(load => [load.number, load.gross, load.pay, load.surcharge ?? 0, load.total].join('|')).sort(),
      record.charges.map(charge => [charge.group, charge.posted, charge.amount].join('|')).sort()
    ]);
    return amountRows(first) === amountRows(second);
  }

  function expenseCategory(description) {
    if (/^Fuel\s*:/i.test(description)) return 'Fuel';
    if (/^Fees\s*:/i.test(description)) return 'Fuel card fees';
    if (/^(?:WVPEDTA|PTC|Toll)\b/i.test(description)) return 'Tolls';
    if (/\b(?:Insurance|Collision)\b/i.test(description)) return 'Insurance';
    if (/\bPlate Fee\b/i.test(description)) return 'Plate fees';
    if (/\bPrePass\b/i.test(description)) return 'PrePass transponder';
    return 'Other settlement charges';
  }

  function taxTotals(manualRows, savedRows, year, manualItems) {
    const totals = { gross: 0, expenses: 0, net: 0, reserve: 0, credits: 0,
      imported: 0, duplicates: 0, conflicts: 0, expensesByName: new Map() };
    const included = [];
    const addExpense = (name, value) => {
      totals.expenses += value;
      totals.expensesByName.set(name, (totals.expensesByName.get(name) ?? 0) + value);
    };

    for (const { data } of savedRows) {
      if (data.issues?.length || !Number.isSafeInteger(data.summary.net) || data.summary.net !== data.summary.printedNet) continue;
      const inTaxYear = data.payDate?.slice(0, 4) === year;
      const previous = included.find(record => sameStatement(record, data));
      if (previous) {
        if (inTaxYear) {
          if (sameAmounts(previous, data)) totals.duplicates++;
          else totals.conflicts++;
        }
        continue;
      }
      included.push(data);
      if (!inTaxYear) continue;
      totals.imported++;
      totals.gross += data.summary.gross;
      totals.net += data.summary.net;
      for (const charge of data.charges) {
        if (/\bRepair Reserve\b/i.test(charge.description)) totals.reserve -= charge.amount;
        else if (charge.amount > 0) totals.credits += charge.amount;
        else if (charge.amount < 0) addExpense(expenseCategory(charge.description), -charge.amount);
      }
    }

    const matchedManually = new Set();
    for (const row of manualRows) {
      if (row.date?.slice(0, 4) !== year) continue;
      const gross = cents(row.gross);
      const deductions = cents(row.deductions);
      const net = row.net == null ? gross - deductions : cents(row.net);
      const sameMoney = data => data.summary.gross === gross && data.summary.net === net &&
        data.summary.gross - data.summary.net === deductions;
      const matchByNumber = included.find(data => data.reference &&
        reference(row.settlement_number) === reference(data.reference));
      const match = matchByNumber ?? included.find(data => !matchedManually.has(data) &&
        (row.date === data.payDate || row.date === data.periodEnd) && sameMoney(data));
      if (match) {
        matchedManually.add(match);
        if (sameMoney(match)) totals.duplicates++;
        else totals.conflicts++;
        continue;
      }

      totals.gross += gross;
      totals.net += net;
      let itemized = 0;
      for (const item of manualItems(row)) {
        const name = String(item?.name ?? '').trim() || 'Other';
        const amount = cents(item?.amount);
        itemized += amount;
        if (/\bRepair Reserve\b/i.test(name)) totals.reserve += amount;
        else if (amount) addExpense(name, amount);
      }
      if (deductions !== itemized) addExpense('Other recorded expenses', deductions - itemized);
    }
    return totals;
  }

  return { sameStatement, sameAmounts, taxTotals };
})();
