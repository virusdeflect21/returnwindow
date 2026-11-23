// CSV parse/serialize/import-validation/export tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCSV, toCSV, parsePurchasesCSV, purchasesToCSV, purchaseToCSVRow, CSV_COLUMNS } from '../js/csv.mjs';
import { normalizePurchase } from '../js/domain.mjs';

const HEADER = 'merchant,item,purchaseDate,returnBy,orderNumber,amount,currency,status,notes,followUpDate,followUpNote';
const GOOD_ROW = 'Acme,Kettle,2025-11-01,2025-11-30,A-1,29.99,USD,open,Gift,,';

test('parseCSV handles quotes, escapes, EOL variants', () => {
  const { rows, error } = parseCSV('a,b\r\n"c,1",d\n"he said ""hi""",x');
  assert.equal(error, null);
  assert.deepEqual(rows[0], ['a', 'b']);
  assert.deepEqual(rows[1], ['c,1', 'd']);
  assert.deepEqual(rows[2], ['he said "hi"', 'x']);
});

test('parseCSV flags unterminated quotes, skips blank lines, tolerates empty input', () => {
  const unterminated = parseCSV('a,"b\n');
  assert.ok(unterminated.error && unterminated.error.includes('quote'), 'missing closing quote is reported');
  const blank = parseCSV('\n\n  \n');
  assert.equal(blank.rows.length, 0);
  assert.equal(blank.error, null);
  const empty = parseCSV('');
  assert.deepEqual(empty, { rows: [], error: null });
});

test('parseCSV reports a plain-language error for a missing closing quote', () => {
  const { error } = parseCSV('merchant,item,purchaseDate,returnBy,orderNumber,amount,currency,status,notes,followUpDate,followUpNote\n"Acme,Kettle');
  assert.ok(error && error.toLowerCase().includes('quote'));
});

test('toCSV escapes and returns CRLF rows', () => {
  const text = toCSV([['a,b', 'quote"s', 'line\nbreak', 'plain']]);
  assert.equal(text, '"a,b","quote""s","line\nbreak",plain\r\n');
  const roundTrip = parseCSV(text);
  assert.deepEqual(roundTrip.rows, [['a,b', 'quote"s', 'line\nbreak', 'plain']]);
  assert.equal(roundTrip.error, null);
});

test('CSV_COLUMNS is the documented schema', () => {
  assert.deepEqual(CSV_COLUMNS, [
    'merchant', 'item', 'purchaseDate', 'returnBy', 'orderNumber',
    'amount', 'currency', 'status', 'notes', 'followUpDate', 'followUpNote',
  ]);
});

test('parsePurchasesCSV with header accepts valid rows and reports invalid ones', () => {
  const csv = [
    HEADER,
    GOOD_ROW,
    ',No merchant,2025-11-01,2025-11-30,,,,,,,', // missing merchant -> invalid
    'Third,Lamp,not-a-date,2025-11-30,,,,,,,', // bad purchase date -> invalid
  ].join('\n');
  const r = parsePurchasesCSV(csv);
  assert.equal(r.hadHeader, true);
  assert.equal(r.validCount, 1);
  assert.equal(r.invalidCount, 2);
  assert.equal(r.fatalErrors.length, 0);
  assert.equal(r.validPurchases[0].merchant, 'Acme');
  assert.equal(r.validPurchases[0].item, 'Kettle');
  assert.equal(r.validPurchases[0].amount, 29.99);
  const bad = r.rows.filter((row) => !row.ok);
  assert.ok(bad[0].errors.some((e) => e.includes('Merchant or store is required')));
  assert.ok(bad[0].errors.some((e) => e.includes('Return-by date is required') === false));
  assert.ok(bad[1].errors.some((e) => e.includes('Purchase date must be')));
  assert.equal(bad[0].line, 3, 'line numbers account for the header row');
});

test('parsePurchasesCSV works without a header in documented column order', () => {
  const r = parsePurchasesCSV(GOOD_ROW);
  assert.equal(r.hadHeader, false);
  assert.equal(r.validCount, 1);
  assert.equal(r.validPurchases[0].merchant, 'Acme');
});

test('parsePurchasesCSV rejects wrong column counts with a clear message', () => {
  const r = parsePurchasesCSV('merchant,item\nAcme,Kettle');
  assert.equal(r.validCount, 0);
  assert.ok(r.rows[0].errors.some((e) => e.includes('exactly 11')));
});

test('parsePurchasesCSV accepts headers in any order (case-insensitive)', () => {
  const header = 'item,merchant,returnBy,purchaseDate,orderNumber,amount,currency,status,notes,followUpDate,followUpNote';
  const row = 'Kettle,Acme,2025-11-30,2025-11-01,A-2,15.50,eur,started,,,';
  const r = parsePurchasesCSV([header, row].join('\n'));
  assert.equal(r.hadHeader, true);
  assert.equal(r.validCount, 1);
  assert.equal(r.validPurchases[0].item, 'Kettle');
  assert.equal(r.validPurchases[0].purchaseDate, '2025-11-01', 'mapped by header name, not position');
  assert.equal(r.validPurchases[0].returnBy, '2025-11-30');
  assert.equal(r.validPurchases[0].currency, 'EUR');
});

test('parsePurchasesCSV handles empty file and header-only file', () => {
  assert.equal(parsePurchasesCSV('').fatalErrors.length, 1);
  const headerOnly = parsePurchasesCSV(HEADER);
  assert.equal(headerOnly.hadHeader, true);
  assert.equal(headerOnly.validCount, 0);
  assert.equal(headerOnly.invalidCount, 0);
  assert.ok(headerOnly.warnings.some((w) => w.includes('header row')));
});

test('parsePurchasesCSV tolerates the UTF-8 BOM that spreadsheets prepend', () => {
  const r = parsePurchasesCSV('\uFEFF' + HEADER + '\n' + GOOD_ROW);
  assert.equal(r.hadHeader, true);
  assert.equal(r.validCount, 1);
  assert.equal(r.validPurchases[0].merchant, 'Acme');
});

test('parsePurchasesCSV warns on unknown status and missing return-by but still imports other rows', () => {
  const csv = [HEADER, 'Acme,Kettle,2025-11-01,,A-1,29.99,USD,,note,,'].join('\n');
  const r = parsePurchasesCSV(csv);
  assert.equal(r.validCount, 1);
  const row = r.rows[0];
  assert.equal(row.ok, true);
  assert.ok(row.warnings.some((w) => w.includes('No return-by date')));
});

function purchaseFixture(overrides = {}) {
  const r = normalizePurchase({
    merchant: 'Acme', item: 'Kettle', purchaseDate: '2025-11-01', returnBy: '2025-11-30',
    orderNumber: 'A-1', amount: '29.99', currency: 'usd', status: 'open',
    notes: 'gift, keep box', followUpDate: '', followUpNote: '', id: 'fixture-1',
    ...overrides,
  });
  assert.equal(r.ok, true);
  return r.purchase;
}

test('purchasesToCSV emits the header and escapes special characters', () => {
  const csv = purchasesToCSV([purchaseFixture()]);
  const lines = csv.split('\r\n').filter(Boolean);
  assert.equal(lines[0], HEADER);
  assert.ok(lines[1].includes('"gift, keep box"'));
  const reimport = parsePurchasesCSV(csv);
  assert.equal(reimport.validCount, 1);
  const p = reimport.validPurchases[0];
  assert.equal(p.merchant, 'Acme');
  assert.equal(p.item, 'Kettle');
  assert.equal(p.amount, 29.99);
  assert.equal(p.currency, 'USD');
  assert.equal(p.notes, 'gift, keep box');
});

test('CSV round trip preserves all status values and follow-up fields', () => {
  const fixtures = [
    purchaseFixture({ id: 'r1', status: 'started' }),
    purchaseFixture({ id: 'r2', status: 'pending', amount: null, currency: '', followUpDate: '2025-12-05', followUpNote: 'case #77, expected 3-5 days' }),
    purchaseFixture({ id: 'r3', status: 'received', orderNumber: '' }),
    purchaseFixture({ id: 'r4', status: 'kept', notes: 'never opened' }),
  ];
  const reimport = parsePurchasesCSV(purchasesToCSV(fixtures));
  assert.equal(reimport.validCount, 4);
  assert.equal(reimport.invalidCount, 0);
  for (let i = 0; i < fixtures.length; i += 1) {
    const original = fixtures[i];
    const restored = reimport.validPurchases[i];
    assert.equal(restored.merchant, original.merchant);
    assert.equal(restored.item, original.item);
    assert.equal(restored.status, original.status);
    assert.equal(restored.purchaseDate, original.purchaseDate);
    assert.equal(restored.returnBy, original.returnBy);
    assert.equal(restored.orderNumber, original.orderNumber);
    assert.equal(restored.amount, original.amount);
    assert.equal(restored.currency, original.currency);
    assert.equal(restored.notes, original.notes);
    assert.equal(restored.followUpDate, original.followUpDate);
    assert.equal(restored.followUpNote, original.followUpNote);
  }
});
