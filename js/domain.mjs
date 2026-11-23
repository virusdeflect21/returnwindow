// domain.mjs — pure purchase/return/refund logic. No DOM, no storage, no network.
// Everything here must be safe to import and run in Node (for tests) and in the browser.

export const STATUSES = ['open', 'started', 'pending', 'received', 'kept'];

export const STATUS_LABELS = {
  open: 'Return window open',
  started: 'Return started',
  pending: 'Refund pending',
  received: 'Refund received',
  kept: 'Kept / closed',
};

export const FILTERS = ['all', 'open', 'started', 'pending', 'closed'];

// Deliberate workflow transitions. Everything is user-reported; nothing is automatic.
export const TRANSITIONS = {
  open: ['started', 'pending', 'kept'],
  started: ['open', 'pending', 'kept'],
  pending: ['received', 'kept', 'open'],
  received: ['open'],
  kept: ['open'],
};

export function canTransition(from, to) {
  if (!STATUSES.includes(to)) return false;
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/* -------------------------------------------------- dates -------------------------------------------------- */

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidISODate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Local-calendar date (not UTC) — what a person sees on their wall clock.
export function todayISO(date = new Date()) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function isoToUTC(value) {
  return Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
}

// Whole days from `fromISO` to `toISO` (negative when toISO is earlier).
// Compares UTC midnights of the two calendar dates, so it is immune to
// time zones and DST shifts on the device running this code.
export function daysBetween(fromISO, toISO) {
  if (!isValidISODate(fromISO) || !isValidISODate(toISO)) return null;
  return Math.round((isoToUTC(toISO) - isoToUTC(fromISO)) / 86_400_000);
}

export function addDaysISO(date, days) {
  const d = new Date(isoToUTC(date) + days * 86_400_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/* ---------------------------------------------- countdown ------------------------------------------------ */

// Classify a return-by date relative to `today` (both YYYY-MM-DD).
export function classifyDeadline(returnBy, today) {
  const none = { state: 'none', days: null, label: 'No return-by date set', overdue: false, urgent: false };
  if (!returnBy) return none;
  const days = daysBetween(today, returnBy);
  if (days === null) return none;
  if (days < 0) {
    const ago = days === -1 ? 'yesterday' : `${-days} days ago`;
    return { state: 'overdue', days, label: `Deadline passed ${ago}`, overdue: true, urgent: true };
  }
  if (days === 0) return { state: 'today', days, label: 'Due today', overdue: false, urgent: true };
  if (days === 1) return { state: 'soon', days, label: '1 day left', overdue: false, urgent: true };
  if (days <= 7) {
    return { state: 'soon', days, label: `${days} days left`, overdue: false, urgent: days <= 3 };
  }
  return { state: 'upcoming', days, label: `${days} days left`, overdue: false, urgent: false };
}

// Follow-up state for `Refund pending` records.
export function classifyFollowUp(followUpDate, today) {
  if (!followUpDate) return { state: 'none', days: null, label: 'No follow-up date set', due: false, overdue: false };
  const days = daysBetween(today, followUpDate);
  if (days === null) return { state: 'none', days: null, label: 'Invalid follow-up date', due: false, overdue: false };
  if (days < 0) {
    const ago = days === -1 ? 'a day overdue' : `${-days} days overdue`;
    return { state: 'overdue', days, label: `Follow-up ${ago}`, due: true, overdue: true };
  }
  if (days === 0) return { state: 'due', days, label: 'Follow up today', due: true, overdue: false };
  return { state: 'upcoming', days, label: `Follow up in ${days} days`, due: false, overdue: false };
}

/* ----------------------------------------------- validation ---------------------------------------------- */

const CURRENCY_RE = /^[A-Z]{3}$/;

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function hasText(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

export function generateId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for very old runtimes only.
  return `rw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Parse & validate raw purchase input (form values or imported rows).
// Returns { ok, purchase, errors: [], warnings: [] }.
// `purchase` is a plain record or null when invalid.
export function normalizePurchase(input, options = {}) {
  const errors = [];
  const warnings = [];
  const raw = input && typeof input === 'object' ? input : {};

  const merchant = clean(raw.merchant);
  const item = clean(raw.item);
  const orderNumber = clean(raw.orderNumber);
  const notes = clean(raw.notes);
  const followUpNote = clean(raw.followUpNote);

  if (!hasText(merchant)) errors.push('Merchant or store is required.');
  else if (merchant.length > 120) errors.push('Merchant or store must be 120 characters or fewer.');
  if (!hasText(item)) errors.push('Item name is required.');
  else if (item.length > 200) errors.push('Item name must be 200 characters or fewer.');
  if (orderNumber.length > 80) errors.push('Order number must be 80 characters or fewer.');
  if (notes.length > 2000) errors.push('Notes must be 2000 characters or fewer.');
  if (followUpNote.length > 300) errors.push('Follow-up note must be 300 characters or fewer.');

  const purchaseDate = clean(raw.purchaseDate);
  if (!hasText(purchaseDate)) errors.push('Purchase date is required.');
  else if (!isValidISODate(purchaseDate)) errors.push('Purchase date must be a valid date (YYYY-MM-DD).');

  const returnBy = clean(raw.returnBy);
  if (hasText(returnBy)) {
    if (!isValidISODate(returnBy)) errors.push('Return-by date must be a valid date (YYYY-MM-DD).');
    else if (!hasText(purchaseDate) || !isValidISODate(purchaseDate)) {
      warnings.push('Check the purchase date — it could not be validated against the return-by date.');
    } else if (daysBetween(purchaseDate, returnBy) < 0) {
      warnings.push('The return-by date is earlier than the purchase date — double-check it.');
    }
  } else if (options.requireReturnBy) {
    errors.push('Return-by date is required (you set this yourself from the merchant policy/receipt).');
  } else {
    warnings.push('No return-by date. This record will only show a countdown once one is set.');
  }

  let amount = null;
  if (raw.amount !== null && raw.amount !== undefined && String(raw.amount).trim() !== '') {
    const n = Number(String(raw.amount).trim().replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0) errors.push('Amount must be a non-negative number, for example 12.99.');
    else if (n > 9_999_999_999) errors.push('Amount is unreasonably large.');
    else amount = Math.round(n * 100) / 100;
  }

  const currency = clean(raw.currency).toUpperCase();
  if (hasText(currency) && !CURRENCY_RE.test(currency)) {
    errors.push('Currency must be a 3-letter code such as USD, EUR or GBP.');
  }

  let status = clean(raw.status);
  if (!hasText(status)) {
    status = 'open';
    warnings.push('No status given — this record starts as "Return window open".');
  } else if (!STATUSES.includes(status)) {
    errors.push(`Status "${status}" is not one of: ${STATUSES.map((s) => STATUS_LABELS[s]).join(', ')}.`);
    status = null;
  }

  const followUpDate = clean(raw.followUpDate);
  if (hasText(followUpDate)) {
    if (!isValidISODate(followUpDate)) errors.push('Follow-up date must be a valid date (YYYY-MM-DD).');
    else if (status && status !== 'pending') {
      warnings.push('A follow-up date is saved, but it is only highlighted on Today while the status is "Refund pending".');
    }
  }

  if (errors.length > 0) {
    return { ok: false, purchase: null, errors, warnings };
  }

  const purchase = {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : generateId(),
    merchant,
    item,
    orderNumber,
    purchaseDate: hasText(purchaseDate) ? purchaseDate : '',
    returnBy: hasText(returnBy) ? returnBy : '',
    amount,
    currency: currency || '',
    status: status || 'open',
    notes,
    followUpDate: hasText(followUpDate) ? followUpDate : '',
    followUpNote,
    createdAt: typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // Static metadata about the stored receipt file (blob lives in the `files` store).
    attachment: raw.attachment && typeof raw.attachment === 'object' ? {
      name: String(raw.attachment.name || 'attachment'),
      type: String(raw.attachment.type || 'application/octet-stream'),
      size: Number(raw.attachment.size) || 0,
    } : null,
  };
  return { ok: true, purchase, errors, warnings };
}

/* -------------------------------------------- queries / lists -------------------------------------------- */

export function isClosed(purchase) {
  return purchase.status === 'received' || purchase.status === 'kept';
}

// Requires the return decision: return not yet started/completed/closed.
export function needsReturnAction(purchase) {
  return purchase.status === 'open' || purchase.status === 'started';
}

export function matchesFilter(purchase, filter) {
  switch (filter) {
    case 'open': return purchase.status === 'open';
    case 'started': return purchase.status === 'started';
    case 'pending': return purchase.status === 'pending';
    case 'closed': return isClosed(purchase);
    case 'all':
    default: return true;
  }
}

export function searchMatches(purchase, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  return [purchase.merchant, purchase.item, purchase.orderNumber]
    .some((field) => String(field || '').toLowerCase().includes(q));
}

// Nearest deadline or follow-up first; records without dates go last.
export function sortKey(purchase) {
  if (purchase.status === 'pending') return purchase.followUpDate || purchase.returnBy || '9999-12-31';
  return purchase.returnBy || '9999-12-31';
}

export function sortPurchases(list) {
  return [...list].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const ca = a.createdAt || '';
    const cb = b.createdAt || '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

export function filterPurchases(list, { query = '', filter = 'all' } = {}) {
  return sortPurchases(list.filter((p) => matchesFilter(p, filter) && searchMatches(p, query)));
}

// Most urgent actionable return: earliest deadline among records that still
// need a return decision. Overdue stays visible and sorts first by date order.
export function mostUrgent(list) {
  const candidates = list.filter((p) => needsReturnAction(p) && p.returnBy);
  if (candidates.length === 0) return null;
  return sortPurchases(candidates)[0];
}

export function followUpIsDue(purchase, today) {
  if (purchase.status !== 'pending' || !purchase.followUpDate) return false;
  return classifyFollowUp(purchase.followUpDate, today).due;
}

export function summarize(list, today) {
  const needsAction = list.filter(needsReturnAction);
  const overdue = needsAction.filter((p) => classifyDeadline(p.returnBy, today).state === 'overdue');
  const dueSoon = needsAction.filter((p) => {
    const d = classifyDeadline(p.returnBy, today);
    return d.state === 'today' || d.state === 'soon';
  });
  const pending = list.filter((p) => p.status === 'pending');
  const followUpsDue = pending.filter((p) => followUpIsDue(p, today));
  return {
    total: list.length,
    needsAction,
    needsActionCount: needsAction.length,
    overdue,
    overdueCount: overdue.length,
    dueSoon,
    dueSoonCount: dueSoon.length,
    pending,
    pendingCount: pending.length,
    followUpsDue,
    followUpsDueCount: followUpsDue.length,
  };
}

// One-tap status actions offered for a record, in priority order.
export function nextActions(purchase) {
  const actions = {
    started: { key: 'start', label: 'Start return', icon: 'play', to: 'started' },
    pending: { key: 'markPending', label: 'Refund pending', icon: 'clock', to: 'pending' },
    received: { key: 'received', label: 'Record refund received', icon: 'check', to: 'received' },
    kept: { key: 'kept', label: 'Close as kept', icon: 'box', to: 'kept' },
    open: { key: 'reopen', label: 'Reopen', icon: 'replay', to: 'open' },
  };
  const order = [];
  if (purchase.status === 'open') order.push('started', 'pending', 'kept');
  else if (purchase.status === 'started') order.push('pending', 'kept', 'open');
  else if (purchase.status === 'pending') order.push('received', 'kept', 'open');
  else order.push('open');
  return order.map((k) => actions[k]).filter(Boolean);
}
