// JSON backup round-trip and validation tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackup, validateBackup, BACKUP_FORMAT, BACKUP_VERSION, MAX_ATTACHMENT_TOTAL_BYTES } from '../js/backup.mjs';
import { normalizePurchase } from '../js/domain.mjs';

function purchase(overrides = {}) {
  const r = normalizePurchase({
    merchant: 'Acme',
    item: 'Kettle',
    purchaseDate: '2025-11-01',
    returnBy: '2025-11-30',
    orderNumber: 'A-1',
    amount: '29.99',
    currency: 'USD',
    status: 'open',
    notes: '',
    followUpDate: '',
    followUpNote: '',
    id: overrides.id || 'p1',
    ...overrides,
  });
  assert.equal(r.ok, true, r.errors.join('; '));
  return r.purchase;
}

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('createBackup produces a typed, versioned payload with explicit attachment policy', () => {
  const purchases = [purchase()];
  const backup = createBackup(purchases, new Map());
  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(backup.app, 'ReturnWindow');
  assert.ok(typeof backup.exportedAt === 'string');
  assert.equal(backup.purchases.length, 1);
  assert.deepEqual(backup.attachmentPolicy, { maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES, included: 0, omitted: 0, includedAny: false });
  assert.equal(backup.attachments, undefined, 'no empty attachments array');
});

test('backup round trip via JSON string restores identical records and attachments', () => {
  const p1 = purchase({ id: 'p1', attachment: { name: 'receipt.png', type: 'image/png', size: 100 } });
  const p2 = purchase({ id: 'p2', status: 'pending', followUpDate: '2025-12-05', followUpNote: 'case #77' });
  const attachments = new Map([['p1', { name: 'receipt.png', type: 'image/png', size: 100, dataUrl: TINY_PNG }]]);
  const backup = createBackup([p1, p2], attachments, { now: '2025-11-23T12:00:00.000Z' });

  const restored = validateBackup(JSON.stringify(backup));
  assert.equal(restored.ok, true, restored.errors.join('; '));
  assert.equal(restored.purchases.length, 2);
  const first = restored.purchases.find((p) => p.id === 'p1');
  const second = restored.purchases.find((p) => p.id === 'p2');
  for (const key of ['merchant', 'item', 'purchaseDate', 'returnBy', 'orderNumber', 'amount', 'currency', 'status', 'notes', 'followUpDate', 'followUpNote', 'createdAt']) {
    assert.equal(first[key], p1[key], `field ${key} survives round trip`);
  }
  assert.equal(second.followUpNote, 'case #77');
  assert.equal(first.attachment.name, 'receipt.png');
  assert.equal(first.attachment.type, 'image/png');
  assert.equal(restored.attachments.get('p1').dataUrl, TINY_PNG);
  assert.deepEqual(restored.meta, { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '2025-11-23T12:00:00.000Z', app: 'ReturnWindow', count: 2 });
});

test('validateBackup rejects non-ReturnWindow and malformed files without crashing', () => {
  assert.equal(validateBackup('this is not json').ok, false);
  const wrongApp = validateBackup(JSON.stringify({ format: 'something-else', version: 1, purchases: [] }));
  assert.equal(wrongApp.ok, false);
  assert.ok(wrongApp.errors.some((e) => e.includes('not a ReturnWindow backup')));
  assert.equal(validateBackup(null).ok, false);
  assert.equal(validateBackup(42).ok, false);
  const noList = validateBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 1 }));
  assert.equal(noList.ok, false);
  assert.ok(noList.errors.some((e) => e.includes('purchases list')));
});

test('validateBackup reports bad purchase records instead of importing them silently', () => {
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    purchases: [
      { merchant: 'Ok', item: 'Fine', purchaseDate: '2025-11-01', returnBy: '2025-11-30' },
      { merchant: '', item: 'Broken', purchaseDate: '2025-11-01', returnBy: '2025-11-30' },
    ],
  };
  const result = validateBackup(backup);
  assert.equal(result.ok, false);
  assert.equal(result.purchases.length, 1, 'the good record is still parsed out');
  assert.ok(result.errors.some((e) => e.includes('Purchase #2')));
  assert.ok(result.warnings.some((w) => w.includes('could not be read')));
});

test('validateBackup warns when attachments were omitted by the size policy', () => {
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    purchases: [purchase({ id: 'p9', attachment: { name: 'big.pdf', type: 'application/pdf', size: 5_000_000 } })],
    attachmentPolicy: { maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES, included: 0, omitted: 1 },
  };
  const result = validateBackup(backup);
  assert.equal(result.ok, true);
  assert.equal(result.attachments.size, 0);
  assert.ok(result.warnings.some((w) => w.includes('omitted')));
});

test('validateBackup skips attachments with broken data urls or unknown owners', () => {
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    purchases: [purchase({ id: 'p1' })],
    attachments: [
      { id: 'p1', name: 'receipt.png', type: 'image/png', size: 10, dataUrl: 'not-a-data-url' },
      { id: 'ghost', name: 'orphan.png', type: 'image/png', size: 10, dataUrl: TINY_PNG },
    ],
  };
  const result = validateBackup(backup);
  assert.equal(result.ok, true);
  assert.equal(result.attachments.size, 0);
  assert.equal(result.warnings.filter((w) => w.includes('skipped')).length, 2);
});

test('createBackup omits attachments once the total crosses the size limit', () => {
  const withReceipt = purchase({ id: 'big1', attachment: { name: 'scan.pdf', type: 'application/pdf', size: 6_000_000 } });
  const hugeDataUrl = 'data:application/pdf;base64,' + 'A'.repeat(Math.ceil((MAX_ATTACHMENT_TOTAL_BYTES * 4) / 3) + 100);
  const attachments = new Map([['big1', { name: 'scan.pdf', type: 'application/pdf', size: 6_000_000, dataUrl: hugeDataUrl }]]);
  const backup = createBackup([withReceipt], attachments);
  assert.equal(backup.attachmentPolicy.omitted, 1);
  assert.equal(backup.attachmentPolicy.included, 0);
  assert.equal(backup.attachmentPolicy.includedAny, false);
  assert.equal(backup.attachments, undefined);
  assert.equal(backup.purchases[0].attachment.includedInBackup, false, 'record discloses that its receipt was left out');
});

test('createBackup includes attachments up to (but not beyond) the limit', async () => {
  const p1 = purchase({ id: 'in1', attachment: { name: 'a.png', type: 'image/png', size: 1000 } });
  const p2 = purchase({ id: 'in2', attachment: { name: 'b.png', type: 'image/png', size: 2000 } });
  const attach1 = { name: 'a.png', type: 'image/png', size: 1000, dataUrl: 'data:image/png;base64,' + 'A'.repeat(20) };
  const attach2 = { name: 'b.png', type: 'image/png', size: 2000, dataUrl: 'data:image/png;base64,' + 'B'.repeat(20) };
  const backup = createBackup([p1, p2], new Map([['in1', attach1], ['in2', attach2]]));
  assert.equal(backup.attachmentPolicy.included, 2);
  assert.equal(backup.attachments.length, 2);
  assert.equal(backup.purchases.every((p) => p.attachment.includedInBackup === true), true);
});

test('validateBackup tolerates newer versions with a warning', () => {
  const backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION + 1, purchases: [purchase()] };
  const result = validateBackup(backup);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((w) => w.includes('newer version')));
});

test('backup with export -> round trip -> createBackup is stable', () => {
  const purchases = [purchase({ id: 'a11', status: 'pending', followUpDate: '2025-12-01' })];
  const first = createBackup(purchases, new Map(), { now: '2025-01-01T00:00:00.000Z' });
  const second = validateBackup(JSON.stringify(first));
  const third = createBackup(second.purchases, new Map(), { now: '2025-01-01T00:00:00.000Z' });
  // envelope and every payload must be byte-identical apart from audit timestamps
  assert.deepEqual(
    { ...first, purchases: first.purchases.map(stripTimestamps) },
    { ...third, purchases: third.purchases.map(stripTimestamps) }
  );
});

function stripTimestamps(record) {
  const { updatedAt, createdAt, ...rest } = record;
  assert.ok(typeof updatedAt === 'string' && typeof createdAt === 'string');
  return rest;
}
