const moneyPattern = /[-−]?\s*\$\s*[-−]?\s*\d[\d,]*\.\d{2}\b/g;
const stamp = '(\\d{1,2}\\s*/\\s*\\d{1,2}\\s*/\\s*\\d{2,4})';
const cash = '(\\$?\\s*\\d[\\d,]*\\.\\d{2})';
const routePattern = new RegExp(
  '^(.+?)\\s+([A-Z]{2})\\s+(.+?)\\s+([A-Z]{2})\\s+(Loaded|Empty)\\s+' +
  '([\\d,.]+)\\s+([0-9A-Za-z-]+)\\s+' + stamp + '\\s+' + stamp +
  '\\s+' + cash + '\\s+(\\d+(?:\\.\\d+)?)\\s*%\\s+' + cash + '$', 'i'
);
const chargePattern = new RegExp(
  '^(.+?)\\s+' + stamp + '\\s+[\\d,.]+\\s+[\\d,.]+\\s+([-−]?\\s*\\$?\\s*[-−]?\\s*\\d[\\d,]*\\.\\d{2})$'
);
const periodPattern = new RegExp('Pay period\\s*:?\\s*' + stamp + '\\s*[-–—]\\s*' + stamp, 'i');
const payDatePattern = new RegExp('Check date\\s*:?\\s*' + stamp, 'i');
const dispatchOrdersPattern = /^Orders\s*:\s*([\d,]+)/i;
const totalChecks = {
  orderPay: /^(?:Pay summary\s+)?Order pay\s*:/i,
  otherEarnings: /^Other earnings\s*:/i,
  gross: /^Total gross earnings\s*:/i,
  adjustments: /^Deductions\s*:/i,
  net: /^Net pay\s*:/i,
  yearEarnings: /^Earnings\s*:/i
};

function cents(token) {
  const amount = token?.replace(/[\s$,]/g, '').replace('−', '-');
  if (!/^-?\d{1,10}\.\d{2}$/.test(amount || '')) return null;
  return Number(amount.replace('.', ''));
}

function lastAmount(line) {
  return cents(line.match(moneyPattern)?.at(-1));
}

function date(value) {
  if (!value) return null;
  const [month, day, year] = value.split('/').map(Number);
  const fullYear = year < 100 ? 2000 + year : year;
  const converted = new Date(Date.UTC(fullYear, month - 1, day));
  if (fullYear < 2000 || fullYear > 2099 || converted.getUTCMonth() + 1 !== month || converted.getUTCDate() !== day) return null;
  return converted.toISOString().slice(0, 10);
}

function cleanLines(text) {
  return text.split(/\r?\n/).map(line => line.replace(/[\u00a0\t ]+/g, ' ').trim()).filter(Boolean);
}

function readLoad(line, load) {
  const parsed = line.match(routePattern);
  if (!parsed) return false;
  const [, origin, originState, destination, destinationState, mileageType, miles, tractor, shipped, delivered, gross, rate, pay] = parsed;
  Object.assign(load, {
    origin: origin + ', ' + originState.toUpperCase(), destination: destination + ', ' + destinationState.toUpperCase(),
    mileageType, miles: Number(miles.replaceAll(',', '')), tractor, shipped: date(shipped), delivered: date(delivered),
    gross: cents(gross), rate: Number(rate), pay: cents(pay)
  });
  return true;
}

function readCharge(line, group, page) {
  const parsed = line.match(chargePattern);
  if (!parsed) return null;
  const [, raw, posted, value] = parsed;
  const description = raw.replace(/^(?:Deduction|Earning)\s+/i, '');
  return { group, description, posted: date(posted), amount: cents(value), page };
}

export function parseLavalleStatement(pages) {
  const text = pages.join('\n');
  if (!/Lavalle\s+Transportation/i.test(text) || !/Owner\s+Operator\s+Settlement\s+Summary/i.test(text)) {
    throw new Error('This pilot reads Lavalle owner-operator statements. Choose that carrier’s PDF.');
  }
  const period = text.match(periodPattern);
  const statementReference = text.match(/\b(?:Statement|Settlement)\s*(?:#|No\.?)\s*:?\s*([A-Z0-9-]*\d[A-Z0-9-]*)\b/i)?.[1] ??
    text.match(/\bCheck\s*(?:#|No\.?)\s*:?\s*([A-Z0-9-]*\d[A-Z0-9-]*)\b/i)?.[1] ?? null;
  const metadata = { carrier: 'Lavalle Transportation, Inc.', reference: statementReference, periodStart: date(period?.[1]),
    periodEnd: date(period?.[2]), payDate: date(text.match(payDatePattern)?.[1]) };
  const loads = [];
  const charges = [];
  const issues = [];
  const printed = {};
  const reserve = {};
  let orders = null;

  for (const [index, content] of pages.entries()) {
    const page = index + 1;
    let group = null;
    let readingReserve = false;
    let openLoad = null;
    let readingPaySummary = false;
    let readingYear = false;
    for (const line of cleanLines(content)) {
      const loadMatch = line.match(/^Settlement\s+([0-9]{5,15})\b/i);
      if (loadMatch) {
        openLoad = { number: loadMatch[1], page, surcharge: null, total: null };
        loads.push(openLoad);
        continue;
      }
      if (openLoad && !openLoad.origin && readLoad(line, openLoad)) continue;
      if (openLoad && /\bFuel surcharge\b/i.test(line)) {
        const surcharge = lastAmount(line);
        if (surcharge !== null) openLoad.surcharge = (openLoad.surcharge ?? 0) + surcharge;
      }
      if (openLoad && /\bOrder total\b/i.test(line)) {
        openLoad.total = lastAmount(line);
        openLoad = null;
        continue;
      }
      if (/^Driver Deductions\s*\/\s*Earnings\s*$/i.test(line)) group = 'Driver';
      if (/^Deductions\s*$/i.test(line)) group = 'Carrier';
      if (/^Pay summary\b/i.test(line)) {
        group = null;
        readingPaySummary = true;
      }
      if (/^YTD summary\b/i.test(line)) readingYear = true;
      if (/^Subtotal for driver\b/i.test(line)) group = null;
      if (group) {
        const charge = readCharge(line, group, page);
        if (charge) charges.push(charge);
      }
      if (/^Driver net pay\s*:/i.test(line)) printed.driverNet = lastAmount(line);
      if (/^Dispatch summary\b/i.test(line)) {
        printed.dispatch = true;
        readingPaySummary = false;
      }
      const orderMatch = line.match(dispatchOrdersPattern);
      if (orderMatch) orders = Number(orderMatch[1].replaceAll(',', ''));
      for (const [key, pattern] of Object.entries(totalChecks)) {
        if ((key === 'yearEarnings' ? readingYear : readingPaySummary) && pattern.test(line)) printed[key] = lastAmount(line);
      }
      if (/^Escrow activity\b/i.test(line)) printed.escrow = true;
      if (/Driver Repair Reserve\s*$/i.test(line)) readingReserve = true;
      if (readingReserve) {
        if (/^Previous balance\s*:/i.test(line)) reserve.prior = lastAmount(line);
        if (/^Deposits\s*:/i.test(line)) reserve.deposit = lastAmount(line);
        if (/^New balance\s*:/i.test(line)) {
          reserve.balance = lastAmount(line);
          readingReserve = false;
        }
      }
    }
  }

  if (!metadata.periodStart || !metadata.periodEnd || !metadata.payDate || metadata.periodEnd < metadata.periodStart) {
    issues.push('Check the pay period and check date on the cover page.');
  }
  if (!printed.dispatch || !Number.isInteger(orders) || orders !== loads.length ||
      !loads.length || new Set(loads.map(load => load.number)).size !== loads.length) {
    issues.push('The load list does not match the dispatch summary. Check that all pages are present once.');
  }
  for (const load of loads) {
    const surcharge = load.surcharge ?? 0;
    const hasPayBasis = load.origin && load.shipped && load.delivered && Number.isFinite(load.miles) &&
      Number.isFinite(load.rate) && load.rate >= 0 && load.rate <= 100 && load.gross !== null && load.pay !== null;
    // The source rounds each nonnegative percentage payment to the nearest cent.
    const calculatedPay = hasPayBasis ? Number((BigInt(load.gross) * BigInt(Math.round(load.rate * 100)) + 5000n) / 10000n) : null;
    if (!hasPayBasis || load.pay !== calculatedPay || load.total === null || load.pay + surcharge !== load.total) {
      issues.push('Check load ' + load.number + ' on page ' + load.page + '. Its pay details could not be reconciled.');
    }
  }

  const sum = (rows, key) => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
  const orderPay = sum(loads, 'pay');
  const fuelSurcharge = sum(loads, 'surcharge');
  const gross = sum(loads, 'total');
  const driver = sum(charges.filter(charge => charge.group === 'Driver'), 'amount');
  const carrier = sum(charges.filter(charge => charge.group === 'Carrier'), 'amount');
  const net = gross + driver + carrier;
  if (charges.some(charge => !charge.posted || charge.amount === null)) issues.push('A deduction has an unreadable date or amount.');
  if (printed.orderPay !== orderPay || printed.otherEarnings !== fuelSurcharge || printed.gross !== gross ||
      gross !== orderPay + fuelSurcharge) issues.push('The load earnings do not match the printed pay summary.');
  if (printed.driverNet !== gross + driver) issues.push('The individual driver charges do not match the driver subtotal.');
  if (printed.adjustments !== driver + carrier || printed.net !== net) issues.push('The deductions and final payout do not match the printed pay summary.');
  if (printed.yearEarnings == null) issues.push('The year-to-date earnings page could not be read.');
  if (Object.keys(reserve).length && (reserve.prior == null || reserve.balance == null || reserve.deposit == null ||
      reserve.prior + reserve.deposit !== reserve.balance || reserve.deposit !==
      -sum(charges.filter(charge => /Repair Reserve/i.test(charge.description)), 'amount'))) {
    issues.push('The repair reserve does not match the reserve deposit and balances on the statement.');
  }
  if (charges.some(charge => /Repair Reserve/i.test(charge.description)) && reserve.deposit == null) {
    issues.push('The repair reserve balance could not be read.');
  }

  return {
    ...metadata, loads, charges, reserve, issues,
    summary: { orderPay, fuelSurcharge, gross, driver, carrier, net, printedNet: printed.net ?? null,
      yearEarnings: printed.yearEarnings ?? null, loadedMiles: sum(loads.filter(load => /^loaded$/i.test(load.mileageType)), 'miles'),
      emptyMiles: sum(loads.filter(load => /^empty$/i.test(load.mileageType)), 'miles') }
  };
}
