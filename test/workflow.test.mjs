// workflow, validation, follow-up and query-logic tests
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUSES,
  canTransition,
  normalizePurchase,
  needsReturnAction,
  matchesFilter,
  searchMatches,
  sortPurchases,
  sortKey,
  filterPurchases,
  mostUrgent,
  summarize,
  followUpIsDue,
  nextActions,
  generateId,
} from '../js/domain.mjs';

const TODAY = '2025-11-23';

function base(overrides = {}) {
  return {
    merchant: 'Nordisk Home',
    item: 'Coffee grinder',
    purchaseDate: '2025-11-01',
    returnBy: '2025-11-30',
    orderNumber: 'A-1234',
    amount: '89.00',
    currency: 'usd',
    status: 'open',
    notes: '',
    followUpDate: '',
    followUpNote: '',
    ...overrides,
  };
}

function record(overrides = {}) {
  const r = normalizePurchase(base(overrides));
  assert.equal(r.ok, true, `fixture must normalize: ${r.errors.join(' ')}`);
  return r.purchase;
}

test('normalizePurchase validates required fields', () => {
  let r = normalizePurchase({ merchant: '', item: 'x', purchaseDate: '2025-11-01', returnBy: '2025-11-30' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Merchant or store is required')));

  r = normalizePurchase({ merchant: 'Acme', item: '', purchaseDate: '2025-11-01', returnBy: '2025-11-30' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Item name is required')));

  r = normalizePurchase({ merchant: 'Acme', item: 'Mug', purchaseDate: '', returnBy: '2025-11-30' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Purchase date is required')));

  r = normalizePurchase({ merchant: 'Acme', item: 'Mug', purchaseDate: '2025-01-99', returnBy: '2025-11-30' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('valid date')));
});

test('normalizePurchase harmonizes types and defaults', () => {
  const r = normalizePurchase(base());
  assert.equal(r.ok, true);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.purchase.currency, 'USD'); // uppercased
  assert.equal(r.purchase.amount, 89); // number, not string
  assert.equal(r.purchase.status, 'open');
  assert.ok(typeof r.purchase.id === 'string' && r.purchase.id.length > 8);
  assert.equal(typeof r.purchase.createdAt, 'string');
});

test('normalizePurchase amount and currency validation', () => {
  let r = normalizePurchase(base({ amount: '12.345' }));
  assert.equal(r.purchase.amount, 12.35, 'rounds to two decimals');
  r = normalizePurchase(base({ amount: 'not-a-number' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Amount must be')));
  r = normalizePurchase(base({ amount: '-5' }));
  assert.equal(r.ok, false);
  r = normalizePurchase(base({ amount: '' }));
  assert.equal(r.purchase.amount, null);
  r = normalizePurchase(base({ currency: 'DOLLARS' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('3-letter code')));
  r = normalizePurchase(base({ currency: 'eUr' }));
  assert.equal(r.purchase.currency, 'EUR');
});

test('normalizePurchase status handling', () => {
  let r = normalizePurchase(base({ status: '' }));
  assert.equal(r.purchase.status, 'open');
  assert.ok(r.warnings.some((w) => w.includes('starts as "Return window open"')));
  r = normalizePurchase(base({ status: 'teleported' }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('Status "teleported"')));
  for (const s of STATUSES) {
    r = normalizePurchase(base({ status: s }));
    assert.equal(r.purchase.status, s);
  }
});

test('normalizePurchase date sanity warnings, id and timestamps preserved', () => {
  // returnBy before purchaseDate is a warning, not a hard error
  const r = normalizePurchase(base({ purchaseDate: '2025-11-30', returnBy: '2025-11-01' }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.includes('earlier than the purchase date')));

  // missing returnBy: warning normally, error when the form requires it
  const optional = normalizePurchase(base({ returnBy: '' }));
  assert.equal(optional.ok, true);
  assert.ok(optional.warnings.some((w) => w.includes('No return-by date')));
  const required = normalizePurchase(base({ returnBy: '' }), { requireReturnBy: true });
  assert.equal(required.ok, false);
  assert.ok(required.errors.some((e) => e.includes('Return-by date is required')));

  // id/createdAt preserved on edit
  const edited = normalizePurchase(base({ id: 'keep-me', createdAt: '2025-11-01T10:00:00.000Z' }));
  assert.equal(edited.purchase.id, 'keep-me');
  assert.equal(edited.purchase.createdAt, '2025-11-01T10:00:00.000Z');
});

test('follow-up date interaction with status', () => {
  const okPending = normalizePurchase(base({ status: 'pending', followUpDate: '2025-11-26' }));
  assert.equal(okPending.ok, true);
  assert.equal(okPending.warnings.length, 0);
  const offStatus = normalizePurchase(base({ status: 'open', followUpDate: '2025-11-26' }));
  assert.equal(offStatus.ok, true);
  assert.ok(offStatus.warnings.some((w) => w.includes('only highlighted on Today')));
  const badDate = normalizePurchase(base({ status: 'pending', followUpDate: '2025-13-40' }));
  assert.equal(badDate.ok, false);
});

test('workflow transitions are deliberate', () => {
  // forward flow
  assert.ok(canTransition('open', 'started'));
  assert.ok(canTransition('started', 'pending'));
  assert.ok(canTransition('pending', 'received'));
  assert.ok(canTransition('open', 'kept'));
  assert.ok(canTransition('pending', 'kept'));
  assert.ok(canTransition('started', 'kept'));
  // reopen paths from terminal states
  assert.ok(canTransition('received', 'open'));
  assert.ok(canTransition('kept', 'open'));
  // invalid / nonsense
  assert.equal(canTransition('open', 'received'), false, 'cannot claim refund received before starting');
  assert.equal(canTransition('received', 'kept'), false);
  assert.equal(canTransition('kept', 'received'), false, 'no direct kept -> received');
  assert.equal(canTransition('open', 'banana'), false);
  assert.equal(canTransition('', 'started'), false);
});

test('nextActions gives the expected primary action per status', () => {
  assert.equal(nextActions(record({ status: 'open' }))[0].to, 'started');
  assert.equal(nextActions(record({ status: 'started' }))[0].to, 'pending');
  assert.equal(nextActions(record({ status: 'pending' }))[0].to, 'received');
  assert.equal(nextActions(record({ status: 'received' }))[0].to, 'open');
  assert.equal(nextActions(record({ status: 'kept' }))[0].to, 'open');
});

test('filtering and search', () => {
  const list = [
    record({ id: 'a', status: 'open', merchant: 'Acme', item: 'Kettle', orderNumber: '111' }),
    record({ id: 'b', status: 'started', merchant: 'Bolaget', item: 'Lamp', orderNumber: '222' }),
    record({ id: 'c', status: 'pending', merchant: 'Acme', item: 'Chair', orderNumber: '333' }),
    record({ id: 'd', status: 'received', merchant: 'Duka', item: 'Mug', orderNumber: '444' }),
    record({ id: 'e', status: 'kept', merchant: 'Else', item: 'Vase', orderNumber: '555' }),
  ];
  assert.deepEqual(list.filter((p) => matchesFilter(p, 'open')).map((p) => p.id), ['a']);
  assert.deepEqual(list.filter((p) => matchesFilter(p, 'started')).map((p) => p.id), ['b']);
  assert.deepEqual(list.filter((p) => matchesFilter(p, 'pending')).map((p) => p.id), ['c']);
  assert.deepEqual(list.filter((p) => matchesFilter(p, 'closed')).map((p) => p.id), ['d', 'e']);
  assert.deepEqual(list.filter((p) => matchesFilter(p, 'all')).length, 5);

  assert.ok(searchMatches(list[0], 'acme')); // merchant, case-insensitive
  assert.ok(searchMatches(list[0], 'kett')); // item
  assert.ok(searchMatches(list[0], '111')); // order number
  assert.equal(searchMatches(list[0], '999'), false);
  assert.equal(searchMatches(list[0], ''), true);

  const filtered = filterPurchases(list, { query: 'acme', filter: 'open' });
  assert.deepEqual(filtered.map((p) => p.id), ['a']);
});

test('sorting: nearest deadline or follow-up first; missing dates last', () => {
  const list = [
    record({ id: 'far', returnBy: '2025-12-31' }),
    record({ id: 'near', returnBy: '2025-11-24' }),
    record({ id: 'nodate', returnBy: '' }),
    record({ id: 'pend', status: 'pending', returnBy: '2025-12-15', followUpDate: '2025-11-25' }),
    record({ id: 'pendnodate', status: 'pending', returnBy: '2025-12-15', followUpDate: '' }),
  ];
  const sorted = sortPurchases(list).map((p) => p.id);
  // 'pend' sorts by follow-up date; 'pendnodate' falls back to its return-by date
  assert.deepEqual(sorted, ['near', 'pend', 'pendnodate', 'far', 'nodate']);
  assert.equal(sortKey(record({ status: 'pending', returnBy: '2025-12-15', followUpDate: '2025-11-25' })), '2025-11-25');
});

test('summarize counts action items, overdue, and follow-ups', () => {
  const list = [
    record({ id: 'open-soon', status: 'open', returnBy: '2025-11-25' }),
    record({ id: 'open-late', status: 'open', returnBy: '2025-11-10' }), // overdue
    record({ id: 'started', status: 'started', returnBy: '2025-11-24' }),
    record({ id: 'pending-future', status: 'pending', returnBy: '2025-11-24', followUpDate: '2025-12-01' }),
    record({ id: 'pending-due', status: 'pending', returnBy: '2025-11-24', followUpDate: '2025-11-23' }),
    record({ id: 'pending-overdue', status: 'pending', returnBy: '2025-11-24', followUpDate: '2025-11-20' }),
    record({ id: 'received', status: 'received', returnBy: '2025-11-24' }),
    record({ id: 'kept', status: 'kept', returnBy: '2025-11-24' }),
  ];
  const s = summarize(list, TODAY);
  assert.equal(s.total, 8);
  assert.equal(s.needsActionCount, 3, 'open + started records need a decision');
  assert.deepEqual(s.overdue.map((p) => p.id), ['open-late'], 'overdue items stay counted');
  assert.equal(s.pendingCount, 3);
  assert.equal(s.followUpsDueCount, 2, 'due today + overdue follow-ups');
  assert.ok(followUpIsDue(list[4], TODAY));
  assert.ok(followUpIsDue(list[5], TODAY));
  assert.equal(followUpIsDue(list[3], TODAY), false);
  assert.equal(followUpIsDue(list[6], TODAY), false, 'non-pending records never count');
});

test('mostUrgent picks the earliest deadline among actionable records', () => {
  const list = [
    record({ id: 'later', status: 'open', returnBy: '2025-12-10' }),
    record({ id: 'earlier', status: 'started', returnBy: '2025-11-26' }),
    record({ id: 'closed', status: 'received', returnBy: '2025-11-24' }), // closed: not actionable
    record({ id: 'nodate', status: 'open', returnBy: '' }),
  ];
  assert.equal(mostUrgent(list).id, 'earlier');
  assert.equal(mostUrgent([list[2]]), null, 'closed records are not actionable');
  assert.equal(needsReturnAction(list[2]), false);
});

test('generateId produces unique ids', () => {
  const ids = new Set(Array.from({ length: 200 }, () => generateId()));
  assert.equal(ids.size, 200);
});
