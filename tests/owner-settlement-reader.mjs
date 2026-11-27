import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLavalleStatement } from '../owner-settlement-reader.mjs';

const statement = [
  `Lavalle Transportation, Inc.
Owner Operator Settlement Summary
Statement #FIXTURE-1
Pay period: 3/1/2025 - 3/7/2025
Check date: 3/10/2025
SETTLEMENT 81234
DAYTON OH INDIANAPOLIS IN Loaded 10.5 39 3/2/25 3/2/25 2.0100 $21.11
ORDER TOTAL $21.11
Driver Deductions/Earnings
Deduction Fuel: Dayton OH 3/2/25 1.00 3.500 _________
-$3.50
SUBTOTAL FOR DRIVER
DRIVER NET PAY: $17.61`,
  `DEDUCTIONS
PrePass Transponder 3/7/25 1.00 2.240 _________ -$2.24
PAY SUMMARY ORDER PAY: $21.11
TOTAL GROSS EARNINGS: $21.11
DEDUCTIONS: -$5.74
NET PAY: $15.37
DISPATCH SUMMARY
ORDERS: 1
ESCROW ACTIVITY
2085.00.000 Driver Repair Reserve
PREVIOUS BALANCE: $125.00
YTD SUMMARY
EARNINGS: $211.10`
];

test('reconciles per-mile pay, ruled deduction amounts, and a prior reserve balance', () => {
  const parsed = parseLavalleStatement(statement);
  assert.deepEqual(parsed.issues, []);
  const [load] = parsed.loads;
  assert.equal(load.rateType, 'per_mile');
  assert.equal(load.rate, 2.01);
  assert.equal(load.miles, 10.5);
  assert.equal(load.gross, null);
  assert.equal(load.pay, 2111);
  assert.deepEqual(parsed.charges.map(charge => charge.amount), [-350, -224]);
  assert.deepEqual(parsed.reserve, { prior: 12500 });
  assert.equal(parsed.summary.printedGross, 2111);
  assert.equal(parsed.summary.printedDeductions, -574);
  assert.equal(parsed.summary.net, 1537);
  assert.equal(parsed.summary.printedNet, 1537);
});

test('keeps percentage pay and fuel surcharge support', () => {
  const parsed = parseLavalleStatement([
    statement[0].replace('2.0100 $21.11', '$40.00 50% $20.00\nFUEL SURCHARGE $1.11'),
    statement[1].replace('ORDER PAY: $21.11', 'ORDER PAY: $20.00\nOTHER EARNINGS: $1.11')
  ]);
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.loads[0].rate, 50);
  assert.equal(parsed.summary.orderPay, 2000);
  assert.equal(parsed.summary.fuelSurcharge, 111);
  assert.equal(parsed.summary.net, 1537);
});

test('flags mismatches in reported pay or reserve activity for review', () => {
  const parsed = parseLavalleStatement([
    statement[0],
    statement[1].replace('NET PAY: $15.37', 'NET PAY: $15.38')
      .replace('PREVIOUS BALANCE: $125.00', 'PREVIOUS BALANCE: $125.00\nDEPOSITS: $2.00')
  ]);
  assert.match(parsed.issues.join(' '), /deductions and final payout/);
  assert.match(parsed.issues.join(' '), /repair reserve/);
});
