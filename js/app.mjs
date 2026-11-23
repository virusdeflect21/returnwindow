// app.mjs — ReturnWindow single-page app (ES modules, zero dependencies).
// All UI is built with DOM APIs; user content is never rendered as HTML.

import {
  STATUSES,
  STATUS_LABELS,
  canTransition,
  classifyDeadline,
  classifyFollowUp,
  filterPurchases,
  summarize,
  mostUrgent,
  needsReturnAction,
  todayISO,
  isValidISODate,
  normalizePurchase,
  nextActions,
} from './domain.mjs';
import * as db from './db.mjs';
import { parsePurchasesCSV, purchasesToCSV, CSV_COLUMNS } from './csv.mjs';
import { createBackup, validateBackup } from './backup.mjs';
import { buildICS, purchaseEvents } from './ics.mjs';

const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const GENERIC_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'SEK', 'NOK', 'DKK', 'CHF', 'PLN', 'INR'];

const state = {
  purchases: [],
  loadError: null,
  query: '',
  filter: 'all',
};

/* ------------------------------------------------- DOM utils ------------------------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'value') node.value = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') node.append(document.createTextNode(String(child)));
    else node.append(child);
  }
  return node;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  check: '<path d="M5 13l4 4L19 7"/>',
  box: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  replay: '<path d="M4 12a8 8 0 1 0 3-6.3"/><path d="M4 4v5h5"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  edit: '<path d="M4 20l4-1 11-11-3-3-11 11z"/>',
  trash: '<path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  upload: '<path d="M12 20V8M7 13l5-5 5 5M5 4h14"/>',
  receipt: '<path d="M6 3h12v18l-2-2-2 2-2-2-2 2-2-2-2 2z"/><path d="M9 8h6M9 12h6"/>',
  doc: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4M9 12h6M9 16h6"/>',
  store: '<path d="M4 9l1.5-4h13L20 9M4 9v11h16V9M4 9h16M10 20v-6h4v6"/>',
  alert: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/>',
  back: '<path d="M14 5l-7 7 7 7"/>',
};

function svgIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('ic');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/* ------------------------------------------------- dialog / toast ------------------------------------------------- */

function dialogEl() {
  return $('#dialog');
}

function openDialog({ title, bodyNodes = [], buttons = [] }) {
  return new Promise((resolve) => {
    const d = dialogEl();
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (d.open) d.close();
      d.oncancel = null;
      d.onclick = null;
      resolve(value);
    };
    d.oncancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    d.onclick = (event) => {
      if (event.target === d) finish(null);
    };
    const footer = buttons.length
      ? el('div', { class: 'dialog-footer' }, buttons.map((b) =>
          el('button', { class: `btn ${b.className || ''}`, onclick: () => finish(b.value) }, b.labelNodes || b.label)
        ))
      : null;
    d.replaceChildren(
      el('h2', { id: 'dialog-title', text: title }),
      el('div', { class: 'dialog-body' }, bodyNodes),
      footer
    );
    d.showModal();
  });
}

function confirmDialog({ title, message, details = [], confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  return openDialog({
    title,
    bodyNodes: [
      el('p', { class: 'mt-0', text: message }),
      details.length ? el('ul', {}, details.map((t) => el('li', { text: t }))) : null,
    ],
    buttons: [
      { label: cancelLabel, value: false, className: '' },
      { label: confirmLabel, value: true, className: danger ? 'btn-danger' : 'btn-primary' },
    ],
  });
}

function infoDialog(title, lines) {
  return openDialog({
    title,
    bodyNodes: lines.map((line) => el('p', { class: 'mt-0', text: line })),
    buttons: [{ label: 'OK', value: true, className: 'btn-primary' }],
  });
}

let toastTimer = null;
function toast(message, kind = 'ok') {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('toast-bad', kind === 'bad');
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 5000);
}

/* ------------------------------------------------- formatting ------------------------------------------------- */

function fmtDateHuman(iso) {
  if (!iso || !isValidISODate(iso)) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(date);
  } catch {
    return iso;
  }
}

function fmtAmount(purchase) {
  if (purchase.amount === null || purchase.amount === undefined) return '';
  if (purchase.currency && /^[A-Z]{3}$/.test(purchase.currency)) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: purchase.currency }).format(purchase.amount);
    } catch {
      /* fall through to plain number */
    }
  }
  return String(purchase.amount);
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function findPurchase(id) {
  return state.purchases.find((p) => p.id === id) || null;
}

/* ------------------------------------------------- data actions ------------------------------------------------- */

async function reload() {
  try {
    state.purchases = await db.listPurchases();
    state.loadError = null;
  } catch (err) {
    state.loadError = err.message || 'Local storage could not be read.';
  }
}

async function applyStatus(id, to) {
  const purchase = findPurchase(id);
  if (!purchase) return;
  if (!canTransition(purchase.status, to)) {
    toast('That status change is not offered from this one.', 'bad');
    return;
  }
  try {
    await db.putPurchase({ ...purchase, status: to, updatedAt: new Date().toISOString() });
    await reload();
    toast(`“${purchase.item}” is now: ${STATUS_LABELS[to]}.`);
    render();
  } catch (err) {
    toast(err.message || 'The change could not be saved.', 'bad');
  }
}

async function saveFollowUp(id) {
  const purchase = findPurchase(id);
  if (!purchase) return;
  const date = $(`#fu-date-${CSS.escape(id)}`)?.value || '';
  const note = $(`#fu-note-${CSS.escape(id)}`)?.value || '';
  if (date && !isValidISODate(date)) {
    toast('The follow-up date must be a valid date.', 'bad');
    return;
  }
  try {
    await db.putPurchase({
      ...purchase,
      followUpDate: date,
      followUpNote: note.trim().slice(0, 300),
      updatedAt: new Date().toISOString(),
    });
    await reload();
    toast(date ? 'Follow-up saved.' : 'Follow-up date cleared.');
    render();
  } catch (err) {
    toast(err.message || 'The follow-up could not be saved.', 'bad');
  }
}

/* ------------------------------------------------- downloads ------------------------------------------------- */

let liveObjectUrls = [];

function downloadBlob(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function slugify(value) {
  return String(value || 'purchase')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'purchase';
}

function downloadReminderICS(purchase) {
  const events = purchaseEvents(purchase);
  if (events.length === 0) {
    toast('Set a return-by (and follow-up) date first — then download the reminder.', 'bad');
    return;
  }
  downloadBlob(buildICS(events), `returnwindow-${slugify(purchase.merchant)}-${purchase.returnBy || purchase.followUpDate}.ics`, 'text/calendar');
  toast('Calendar file downloaded. Open it (or import it) into your calendar to set the reminder.');
}

async function exportCSVFile() {
  try {
    const rows = [...state.purchases].sort((a, b) => (a.returnBy || '9999').localeCompare(b.returnBy || '9999'));
    downloadBlob(purchasesToCSV(rows), `returnwindow-${todayISO()}.csv`, 'text/csv;charset=utf-8');
    toast('CSV downloaded (records only — receipts are not included in CSV).');
  } catch (err) {
    toast(err.message || 'The CSV could not be created.', 'bad');
  }
}

async function exportBackupFile() {
  try {
    let attachments = new Map();
    try {
      const fileRecords = await db.listFileRecords();
      for (const rec of fileRecords) {
        try {
          const dataUrl = await db.blobToDataUrl(rec.blob);
          attachments.set(rec.id, { name: rec.name, type: rec.type, size: rec.size, dataUrl });
        } catch {
          /* leave the receipt out; the backup policy notes it */
        }
      }
    } catch {
      /* receipts unavailable — backup still records the omission */
    }
    const backup = createBackup(state.purchases, attachments);
    downloadBlob(JSON.stringify(backup, null, 2), `returnwindow-backup-${todayISO()}.json`, 'application/json');
    const omitted = backup.attachmentPolicy.omitted;
    if (omitted > 0) {
      toast(`Backup downloaded — ${omitted} receipt(s) were left out because of the size limit. Download them individually.`, 'bad');
    } else {
      toast('Backup downloaded. Keep it somewhere safe — it is your only off-device copy.');
    }
  } catch (err) {
    toast(err.message || 'The backup could not be created.', 'bad');
  }
}

async function openAttachment(purchase, mode) {
  try {
    const rec = await db.getFile(purchase.id);
    if (!rec || !rec.blob) {
      toast('The attached file is missing from local storage.', 'bad');
      return;
    }
    const url = URL.createObjectURL(rec.blob);
    liveObjectUrls.push(url);
    if (mode === 'download') {
      const a = el('a', { href: url, download: rec.name || 'receipt' });
      document.body.append(a);
      a.click();
      a.remove();
      toast('Receipt download started.');
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (err) {
    toast(err.message || 'The attachment could not be opened.', 'bad');
  }
}

/* ------------------------------------------------- imports ------------------------------------------------- */

async function handleImportCSV(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    toast('The CSV file could not be read.', 'bad');
    return;
  }
  const report = parsePurchasesCSV(text);
  if (report.fatalErrors.length > 0) {
    await infoDialog('CSV import problem', report.fatalErrors);
    return;
  }
  if (report.validCount === 0) {
    const sample = report.rows.filter((r) => !r.ok).slice(0, 8).map((r) => `Row ${r.line}: ${r.errors.join(' ')}`);
    await infoDialog('Nothing to import', ['No valid rows were found in this CSV file.', ...sample]);
    return;
  }
  const invalid = report.rows.filter((r) => !r.ok);
  const invalidShown = invalid.slice(0, 10).map((r) => `Row ${r.line}: ${r.errors.join(' ')}`);
  const preview = report.validPurchases.slice(0, 5).map((p) => `${p.merchant} — ${p.item}${p.returnBy ? ` (return by ${p.returnBy})` : ''}`);
  const value = await openDialog({
    title: 'Import from CSV',
    bodyNodes: [
      el('p', {
        class: 'mt-0',
        text: `Found ${report.validCount} valid row(s)${invalid.length ? ` and ${invalid.length} row(s) with problems (those are skipped, nothing else is touched).` : '.'}`,
      }),
      preview.length ? el('ul', {}, preview.map((t) => el('li', { text: t }))) : null,
      invalidShown.length
        ? el('ul', { style: 'color: var(--red);' }, invalidShown.map((t) => el('li', { text: t })))
        : null,
      invalid.length > 10
        ? el('p', { class: 'small muted', text: `${invalid.length - 10} more problem row(s) not listed.` })
        : null,
      el('p', { class: 'small muted', text: 'Date fields and label switches are re-checked; your existing records are not modified.' }),
    ],
    buttons: [
      { label: 'Cancel', value: false, className: '' },
      { label: `Import ${report.validCount} purchase(s)`, value: true, className: 'btn-primary' },
    ],
  });
  if (!value) return;
  try {
    await db.savePurchases(report.validPurchases);
    await reload();
    toast(`Imported ${report.validCount} purchase(s)${invalid.length ? `; skipped ${invalid.length} invalid row(s).` : '.'}`);
    go(`#/list`);
  } catch (err) {
    toast(err.message || 'The import could not be saved.', 'bad');
  }
}

async function handleImportBackup(file) {
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch {
    toast('The backup file could not be read.', 'bad');
    return;
  }
  const result = validateBackup(text);
  if (!result.ok) {
    await infoDialog('Backup import problem', result.errors);
    return;
  }
  const existingIds = new Set(state.purchases.map((p) => p.id));
  const duplicates = result.purchases.filter((p) => existingIds.has(p.id)).length;
  const attCount = result.attachments.size;

  const mergeRadio = el('input', { type: 'radio', name: 'import-mode', id: 'mode-merge', value: 'merge', checked: true });
  const replaceRadio = el('input', { type: 'radio', name: 'import-mode', id: 'mode-replace', value: 'replace' });

  const value = await openDialog({
    title: 'Import backup',
    bodyNodes: [
      el('p', {
        class: 'mt-0',
        text: `This backup contains ${result.meta.count} purchase(s)${attCount ? ` and ${attCount} receipt attachment(s)` : ''}${result.meta.exportedAt ? `, exported ${result.meta.exportedAt.slice(0, 10)}` : ''}.`,
      }),
      el('p', {}, [
        el('span', { class: 'radio-line' }, [
          mergeRadio,
          el('label', { for: 'mode-merge' }, [
            'Merge (recommended) — add the backup records to this device',
            el('span', { class: 'radio-desc', text: duplicates ? `${duplicates} record(s) with identical ids already exist here and would be skipped.` : 'No existing records would be touched.' }),
          ]),
        ]),
      ]),
      el('p', {}, [
        el('span', { class: 'radio-line' }, [
          replaceRadio,
          el('label', { for: 'mode-replace' }, [
            'Replace everything',
            el('span', { class: 'radio-desc', text: `Permanently deletes all ${state.purchases.length} purchase(s) and their receipts on this device first, then imports the backup. This cannot be undone.` }),
          ]),
        ]),
      ]),
      result.warnings.length ? el('ul', { class: 'small', style: 'color: var(--amber);' }, result.warnings.map((w) => el('li', { text: w }))) : null,
    ],
    buttons: [
      { label: 'Cancel', value: false, className: '' },
      { label: 'Import backup', value: true, className: 'btn-primary' },
    ],
  });
  const mode = replaceRadio.checked ? 'replace' : 'merge';
  if (!value) return;
  try {
    if (mode === 'replace') {
      const okToErase = await confirmDialog({
        title: 'Replace all data?',
        message: `All ${state.purchases.length} purchase(s) and receipts on this device will be deleted before the backup is imported.`,
        confirmLabel: 'Erase and import',
        danger: true,
      });
      if (!okToErase) return;
      await db.clearAll();
    }
    const toSave = mode === 'replace' ? result.purchases : result.purchases.filter((p) => !existingIds.has(p.id));
    await db.savePurchases(toSave);
    for (const [id, att] of result.attachments) {
      if (!toSave.some((p) => p.id === id)) continue;
      const blob = db.dataUrlToBlob(att.dataUrl);
      if (blob) await db.putFile({ id, name: att.name, type: att.type, size: blob.size, blob });
    }
    await reload();
    toast(
      mode === 'replace'
        ? `Imported ${toSave.length} purchase(s) from the backup (previous data replaced).`
        : `Imported ${toSave.length} purchase(s) from the backup${duplicates ? `; skipped ${duplicates} already present.` : '.'}`
    );
    go(`#/list`);
  } catch (err) {
    toast(err.message || 'The backup could not be imported.', 'bad');
  }
}

async function eraseAll() {
  const ok = await confirmDialog({
    title: 'Erase all ReturnWindow data?',
    message: `This deletes all ${state.purchases.length} purchase record(s) and every stored receipt on this device.`,
    details: ['This cannot be undone — export a backup first if you might want them back.'],
    confirmLabel: 'Erase everything',
    danger: true,
  });
  if (!ok) return;
  const ok2 = await confirmDialog({
    title: 'Really erase everything?',
    message: 'Last check: erase all purchases and receipts stored by ReturnWindow in this browser?',
    confirmLabel: 'Yes, erase it all',
    danger: true,
  });
  if (!ok2) return;
  try {
    await db.clearAll();
    await reload();
    toast('All records erased from this device.');
    render();
  } catch (err) {
    toast(err.message || 'The data could not be erased.', 'bad');
  }
}

/* ------------------------------------------------- chips & cards ------------------------------------------------- */

function statusChip(purchase) {
  const cls = {
    open: 'chip-open',
    started: 'chip-started',
    pending: 'chip-pending',
    received: 'chip-received',
    kept: 'chip-kept',
  }[purchase.status] || 'chip-neutral';
  return el('span', { class: `chip ${cls}`, text: STATUS_LABELS[purchase.status] || purchase.status });
}

function deadlineInfo(purchase, today) {
  return classifyDeadline(purchase.returnBy, today);
}

function deadlineChipClass(info) {
  if (info.state === 'overdue') return 'chip-overdue';
  if (info.state === 'today') return 'chip-today';
  if (info.state === 'soon') return 'chip-soon';
  return 'chip-neutral';
}

function deadlineChip(info) {
  return el('span', { class: `chip ${deadlineChipClass(info)}`, text: info.label });
}

function followUpChip(purchase, today) {
  if (purchase.status !== 'pending' || !purchase.followUpDate) return null;
  const info = classifyFollowUp(purchase.followUpDate, today);
  return el('span', { class: `chip ${info.overdue || info.state === 'due' ? 'chip-today' : 'chip-neutral'}`, text: info.label });
}

function quickActionButton(purchase, { small = true } = {}) {
  const action = nextActions(purchase)[0];
  if (!action) return null;
  const isReopen = action.to === 'open';
  const btn = el(
    'button',
    {
      class: `btn btn-sm ${isReopen ? 'btn-quiet' : 'btn-primary'}`,
      onclick: () => applyStatus(purchase.id, action.to),
    },
    [svgIcon(action.icon), action.label]
  );
  return btn;
}

function detailsLinkButton(purchase) {
  return el('a', { class: 'btn btn-sm', href: `#/item/${purchase.id}` }, [svgIcon('doc'), 'Details']);
}

function reminderButton(purchase, { small = true } = {}) {
  return el(
    'button',
    {
      class: 'btn btn-sm btn-quiet',
      'aria-label': `Download calendar reminder for ${purchase.item}`,
      onclick: () => downloadReminderICS(purchase),
    },
    [svgIcon('calendar'), 'Calendar reminder']
  );
}

function purchaseCard(purchase, today, { showQuickAction = true } = {}) {
  const info = deadlineInfo(purchase, today);
  const urgent = needsReturnAction(purchase) && (info.overdue || info.urgent);
  const card = el('article', { class: `card purchase-card ${info.overdue ? 'is-overdue' : urgent ? 'is-urgent' : ''}` }, [
    el('div', { class: 'pc-top' }, [
      el('div', {}, [
        el('p', { class: 'pc-merchant', text: purchase.merchant }),
        el('h3', { class: 'pc-item', text: purchase.item }),
        purchase.orderNumber ? el('p', { class: 'pc-meta', text: `Order ${purchase.orderNumber}` }) : null,
        el('p', { class: 'pc-meta' }, [
          info.state === 'none' ? 'No return-by date set yet' : 'Return by ',
          info.state === 'none' ? null : el('span', { class: 'pc-date', text: fmtDateHuman(purchase.returnBy) }),
        ]),
      ]),
      fmtAmount(purchase) ? el('span', { class: 'pc-amount', text: fmtAmount(purchase) }) : null,
    ]),
    el('div', { class: 'chip-row' }, [
      statusChip(purchase),
      deadlineChip(info),
      followUpChip(purchase, today),
      purchase.attachment ? el('span', { class: 'chip chip-neutral' }, [svgIcon('receipt'), 'Receipt']) : null,
    ]),
    el('div', { class: 'actions-row' }, [
      showQuickAction ? quickActionButton(purchase) : null,
      detailsLinkButton(purchase),
      reminderButton(purchase),
    ]),
  ]);
  return card;
}

function emptyState({ title, message, actions = [] }) {
  return el('section', { class: 'empty-state', 'aria-label': title }, [
    svgIcon('store'),
    el('h2', { text: title }),
    el('p', { text: message }),
    actions.length ? el('div', { class: 'actions-row' }, actions) : null,
  ]);
}

/* ------------------------------------------------- views ------------------------------------------------- */

function viewToday(today) {
  const s = summarize(state.purchases, today);
  const frag = el('div');

  frag.append(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Today' }),
        el('p', { class: 'page-sub', text: fmtDateHuman(today) }),
      ]),
      el('div', { class: 'actions-row' }, [
        el('a', { class: 'btn btn-primary', href: '#/edit/new' }, [svgIcon('plus'), 'Add purchase']),
        el('a', { class: 'btn', href: '#/data' }, [svgIcon('upload'), 'Import']),
      ]),
    ])
  );

  if (state.loadError) {
    frag.append(
      el('div', { class: 'card notice bad', role: 'alert' }, [
        el('p', { class: 'mt-0', text: state.loadError }),
        el('button', { class: 'btn btn-sm', onclick: () => reload().then(render) }, [svgIcon('replay'), 'Try again']),
      ])
    );
  }

  if (s.total === 0) {
    frag.append(
      emptyState({
        title: 'Nothing to track yet',
        message:
          'Add a purchase with its return-by date, or import your records. ReturnWindow keeps deadlines and refund follow-ups in view — everything stays on this device.',
        actions: [
          el('a', { class: 'btn btn-primary', href: '#/edit/new' }, [svgIcon('plus'), 'Add your first purchase']),
          el('a', { class: 'btn', href: '#/data' }, [svgIcon('upload'), 'Import a backup or CSV']),
        ],
      }),
      el('p', { class: 'fine-print', text: 'You set the return-by date yourself (from your receipt or the merchant’s policy) — return windows vary by merchant and region, so ReturnWindow never guesses them.' })
    );
    return frag;
  }

  const urgent = mostUrgent(state.purchases);
  if (urgent) {
    const info = classifyDeadline(urgent.returnBy, today);
    frag.append(
      el('section', { class: `card ${info.overdue ? 'is-overdue' : 'is-urgent'}`, 'aria-label': 'Most urgent return deadline' }, [
        el('p', { class: 'pc-merchant', text: 'Most urgent return deadline' }),
        el('h2', { style: 'margin: 2px 0 4px; font-size: 1.2rem;', text: `${urgent.item}` }),
        el('p', { class: 'pc-meta', text: `${urgent.merchant}${urgent.orderNumber ? ` · order ${urgent.orderNumber}` : ''}` }),
        el('div', { class: 'countdown-hero' }, [
          el('span', { class: `chip big-chip ${deadlineChipClass(info)}`, text: info.label }),
          el('span', { class: 'chip chip-neutral' }, `Return by ${fmtDateHuman(urgent.returnBy)}`),
          fmtAmount(urgent) ? el('span', { class: 'chip chip-neutral', text: fmtAmount(urgent) }) : null,
        ]),
        info.overdue
          ? el('p', { class: 'small', style: 'color: var(--red); font-weight: 600;' }, [svgIcon('alert'), ` The deadline has passed. The record stays visible so you can still try the return, or close it as kept.`])
          : null,
        el('div', { class: 'actions-row' }, [
          quickActionButton(urgent),
          detailsLinkButton(urgent),
          reminderButton(urgent),
        ]),
      ])
    );
  }

  frag.append(
    el('div', { class: 'stat-tiles' }, [
      el('a', { class: 'stat-tile', href: '#/list', onclick: () => { state.filter = 'all'; } }, [
        el('span', { class: 'num', text: String(s.needsActionCount) }),
        el('span', { class: 'lbl', text: s.needsActionCount === 1 ? 'purchase needs a return decision' : 'purchases need a return decision' }),
      ]),
      el('a', { class: 'stat-tile', href: '#/list', onclick: () => { state.filter = 'pending'; } }, [
        el('span', { class: 'num', text: String(s.pendingCount) }),
        el('span', { class: 'lbl' }, [
          s.pendingCount === 1 ? 'refund awaiting follow-up' : 'refunds awaiting follow-up',
          s.followUpsDueCount
            ? el('b', { text: ` — ${s.followUpsDueCount} due now` })
            : el('span', { text: ' — none due today' }),
        ]),
      ]),
    ])
  );

  if (s.followUpsDueCount > 0) {
    frag.append(el('h2', { class: 'section-title', text: 'Refund follow-ups due' }));
    for (const purchase of sortFollowUps(s.followUpsDue)) {
      const info = classifyFollowUp(purchase.followUpDate, today);
      frag.append(
        el('article', { class: `card ${info.overdue ? 'is-overdue' : 'is-urgent'}` }, [
          el('p', { class: 'pc-merchant', text: `${info.label}` }),
          el('h3', { class: 'pc-item', text: purchase.item }),
          el('p', { class: 'pc-meta', text: `${purchase.merchant}${purchase.followUpNote ? ` — ${purchase.followUpNote}` : ''}` }),
          el('p', { class: 'small muted', text: '“Refund received” is marked by you — ReturnWindow cannot see your bank activity.' }),
          el('div', { class: 'actions-row' }, [
            quickActionButton(purchase),
            detailsLinkButton(purchase),
          ]),
        ])
      );
    }
  }

  if (s.overdueCount > 0) {
    frag.append(el('h2', { class: 'section-title', text: 'Past deadline — still worth a try' }));
    for (const purchase of s.overdue) frag.append(purchaseCard(purchase, today));
  }

  const dueSoon = s.dueSoon.filter((p) => classifyDeadline(p.returnBy, today).state !== 'overdue');
  if (dueSoon.length > 0) {
    frag.append(el('h2', { class: 'section-title', text: 'Act within 7 days' }));
    for (const purchase of dueSoon) frag.append(purchaseCard(purchase, today));
  }

  if (s.pendingCount > 0 && s.followUpsDueCount === 0) {
    frag.append(
      el('p', { class: 'small muted', style: 'margin-top: 18px;' }, [
        `${s.pendingCount} refund(s) pending — no follow-up date is due today. `,
        el('a', { class: 'link', href: '#/list', onclick: () => { state.filter = 'pending'; } }, 'Review pending refunds'),
      ])
    );
  }

  return frag;
}

function sortFollowUps(list) {
  return [...list].sort((a, b) => (a.followUpDate || '').localeCompare(b.followUpDate || ''));
}

function viewList(today) {
  const frag = el('div');
  frag.append(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Purchases' }),
        el('p', { class: 'page-sub', text: `${state.purchases.length} record(s) on this device` }),
      ]),
      el('a', { class: 'btn btn-primary', href: '#/edit/new' }, [svgIcon('plus'), 'Add purchase']),
    ])
  );

  if (state.purchases.length === 0) {
    frag.append(
      emptyState({
        title: 'No purchases yet',
        message: 'Purchases you add appear here, sorted with the nearest return deadline (or follow-up) first.',
        actions: [
          el('a', { class: 'btn btn-primary', href: '#/edit/new' }, [svgIcon('plus'), 'Add purchase']),
          el('a', { class: 'btn', href: '#/data' }, [svgIcon('upload'), 'Import']),
        ],
      })
    );
    return frag;
  }

  const searchInput = el('input', {
    type: 'search',
    id: 'purchase-search',
    placeholder: 'Search merchant, item, or order number',
    'aria-label': 'Search purchases by merchant, item, or order number',
    value: state.query,
    autocomplete: 'off',
  });

  const counts = {
    all: state.purchases.length,
    open: state.purchases.filter((p) => p.status === 'open').length,
    started: state.purchases.filter((p) => p.status === 'started').length,
    pending: state.purchases.filter((p) => p.status === 'pending').length,
    closed: state.purchases.filter((p) => p.status === 'received' || p.status === 'kept').length,
  };
  const filterChips = el(
    'div',
    { class: 'chip-row', role: 'group', 'aria-label': 'Filter purchases by status' },
    [
      ['all', 'All'],
      ['open', 'Open window'],
      ['started', 'Return started'],
      ['pending', 'Refund pending'],
      ['closed', 'Closed'],
    ].map(([key, label]) => {
      const btn = el('button', {
        class: 'chip-btn',
        'aria-pressed': state.filter === key ? 'true' : 'false',
        onclick: () => {
          state.filter = key;
          for (const child of btn.parentElement.children) child.setAttribute('aria-pressed', String(child === btn));
          renderList();
        },
      }, [`${label} (${counts[key]})`]);
      return btn;
    })
  );

  const listContainer = el('div', { id: 'purchase-list' });

  function renderList() {
    const list = filterPurchases(state.purchases, { query: state.query, filter: state.filter });
    listContainer.replaceChildren();
    if (list.length === 0) {
      const message =
        state.query.trim() !== ''
          ? `No purchases match “${state.query.trim()}”.`
          : state.filter === 'closed'
            ? 'No purchases have been closed as “Refund received” or “Kept” yet.'
            : state.filter === 'pending'
              ? 'No refunds are waiting on follow-up right now.'
              : state.filter === 'started'
                ? 'No returns are in progress right now.'
                : state.filter === 'open'
                  ? 'No open return windows right now.'
                  : 'No purchases yet.';
      listContainer.append(
        emptyState({
          title: 'Nothing here',
          message,
          actions: state.query
            ? []
            : [
                el('a', { class: 'btn btn-primary', href: '#/edit/new' }, [svgIcon('plus'), 'Add purchase']),
                el('button', { class: 'btn', onclick: () => { searchInput.value = ''; state.query = ''; renderList(); } }, [svgIcon('replay'), 'Clear all filters']),
              ],
        })
      );
      return;
    }
    for (const purchase of list) listContainer.append(purchaseCard(purchase, today));
  }

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value;
    renderList();
  });

  frag.append(
    el('div', { class: 'search-bar' }, [
      el('label', { for: 'purchase-search', class: 'visually-hidden', text: 'Search merchant, item, or order number' }),
      el('div', { class: 'chip-row', style: 'margin-bottom: 10px;' }, [searchInput]),
      filterChips,
    ])
  );
  frag.append(listContainer);
  renderList();
  return frag;
}

function kv(term, ...valueNodes) {
  return [el('dt', { text: term }), el('dd', {}, valueNodes.filter(Boolean))];
}

function viewItem(id, today) {
  const frag = el('div');
  const purchase = findPurchase(id);
  if (!purchase) {
    frag.append(
      el('div', { class: 'page-head' }, [el('h1', { text: 'Record not found' })]),
      emptyState({
        title: 'This purchase is not on this device',
        message: 'It may have been deleted, or this link is from another device or an older backup.',
        actions: [el('a', { class: 'btn', href: '#/list' }, 'Back to purchases')],
      })
    );
    return frag;
  }

  const info = classifyDeadline(purchase.returnBy, today);
  frag.append(
    el('p', {}, [el('a', { class: 'link', href: '#/list' }, '← Purchases')]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: purchase.item }),
        el('p', { class: 'page-sub', text: purchase.merchant }),
      ]),
      el('a', { class: 'btn', href: `#/edit/${purchase.id}` }, [svgIcon('edit'), 'Edit']),
    ]),
    el('div', { class: `card ${info.overdue ? 'is-overdue' : needsReturnAction(purchase) && info.urgent ? 'is-urgent' : ''}` }, [
      el('div', { class: 'chip-row' }, [
        statusChip(purchase),
        deadlineChip(info),
        followUpChip(purchase, today),
      ]),
      el('dl', { class: 'kv-list', style: 'margin-top: 10px;' }, [
        ...kv('Return by', info.state === 'none' ? '— (not set)' : `${fmtDateHuman(purchase.returnBy)} (${info.label})`),
        ...kv('Purchase date', purchase.purchaseDate ? fmtDateHuman(purchase.purchaseDate) : '—'),
        ...(purchase.orderNumber ? kv('Order number', purchase.orderNumber) : []),
        ...(fmtAmount(purchase) ? kv('Amount', fmtAmount(purchase)) : []),
        ...(purchase.status === 'pending' ? kv('Follow-up', purchase.followUpDate ? `${fmtDateHuman(purchase.followUpDate)} — ${classifyFollowUp(purchase.followUpDate, today).label}` : 'No follow-up date set') : []),
        ...(purchase.followUpNote && purchase.status === 'pending' ? kv('Follow-up note / reference', purchase.followUpNote) : []),
      ]),
    ])
  );

  if (purchase.notes) {
    frag.append(
      el('section', { class: 'card' }, [
        el('h2', { style: 'margin: 0 0 6px; font-size: 1rem;', text: 'Notes & return instructions' }),
        el('p', { class: 'mt-0', style: 'white-space: pre-wrap;', text: purchase.notes }),
      ])
    );
  }

  // Attachment
  const attachmentSection = el('section', { class: 'card' }, [
    el('h2', { style: 'margin: 0 0 8px; font-size: 1rem;', text: 'Receipt / confirmation' }),
  ]);
  frag.append(attachmentSection);
  fillAttachmentSection(attachmentSection, purchase);

  // Status actions
  frag.append(
    el('section', { class: 'card' }, [
      el('h2', { style: 'margin: 0 0 4px; font-size: 1rem;', text: 'Update status' }),
      el('p', { class: 'small muted', text: 'One tap each. Everything is what you report — ReturnWindow does not contact the merchant or check your bank.' }),
      el('div', { class: 'actions-row' },
        nextActions(purchase).map((action) =>
          el(
            'button',
            {
              class: `btn ${action.to === 'received' ? 'btn-primary' : action.to === 'open' ? 'btn-quiet' : ''}`,
              onclick: () => applyStatus(purchase.id, action.to),
            },
            [svgIcon(action.icon), action.label]
          )
        )
      ),
    ])
  );

  // Follow-up editor while refund is pending
  if (purchase.status === 'pending') {
    frag.append(
      el('section', { class: 'card' }, [
        el('h2', { style: 'margin: 0 0 4px; font-size: 1rem;', text: 'Plan the next follow-up' }),
        el('p', { class: 'small muted', text: 'Set when you will chase the refund, plus a note or reference (case number, who you spoke to …). Due and overdue follow-ups show up on Today.' }),
        el('div', { class: 'form-grid' }, [
          el('div', { class: 'field-row' }, [
            el('div', { class: 'field' }, [
              el('label', { for: `fu-date-${purchase.id}`, text: 'Follow-up date' }),
              el('input', { type: 'date', id: `fu-date-${purchase.id}`, value: purchase.followUpDate || '' }),
            ]),
            el('div', { class: 'field' }, [
              el('label', { for: `fu-note-${purchase.id}`, text: 'Note / reference' }),
              el('input', { type: 'text', id: `fu-note-${purchase.id}`, value: purchase.followUpNote || '', maxlength: '300' }),
            ]),
          ]),
          el('button', { class: 'btn btn-primary btn-sm', onclick: () => saveFollowUp(purchase.id) }, [svgIcon('check'), 'Save follow-up']),
        ]),
      ])
    );
  }

  // Calendar reminders
  frag.append(
    el('section', { class: 'card' }, [
      el('h2', { style: 'margin: 0 0 4px; font-size: 1rem;', text: 'Calendar reminder' }),
      el('p', { class: 'small muted', text: 'Downloads a standard calendar file (.ics). Open it (or import it) into your calendar app to set the reminder. ReturnWindow has no servers, so it cannot notify you while it is closed.' }),
      el('div', { class: 'actions-row' }, [
        purchase.returnBy
          ? el('button', { class: 'btn', onclick: () => downloadReminderICS(purchase) }, [svgIcon('calendar'), `Return deadline (.ics)`])
          : el('span', { class: 'chip chip-neutral', text: 'No return-by date set — add one to get a reminder' }),
        purchase.status === 'pending' && purchase.followUpDate
          ? el('button', { class: 'btn', onclick: () => downloadReminderICS(purchase) }, [svgIcon('calendar'), 'Also follow-up (.ics)'])
          : null,
      ]),
    ])
  );

  // Danger zone
  frag.append(
    el('section', { class: 'card', style: 'border-left: 4px solid var(--red);' }, [
      el('h2', { style: 'margin: 0 0 4px; font-size: 1rem;', text: 'Danger zone' }),
      el('div', { class: 'actions-row' }, [
        el('button', {
          class: 'btn btn-danger',
          onclick: async () => {
            const ok = await confirmDialog({
              title: 'Delete this purchase?',
              message: `“${purchase.item}” from ${purchase.merchant} will be deleted from this device.`,
              details: purchase.attachment ? ['The attached receipt file will be deleted too.'] : [],
              confirmLabel: 'Delete purchase',
              danger: true,
            });
            if (!ok) return;
            try {
              await db.deletePurchase(purchase.id);
              await reload();
              toast('Purchase deleted.');
              go('#/list');
            } catch (err) {
              toast(err.message || 'The purchase could not be deleted.', 'bad');
            }
          },
        }, [svgIcon('trash'), 'Delete purchase']),
      ]),
    ])
  );

  return frag;
}

function fillAttachmentSection(section, purchase) {
  if (!purchase.attachment) {
    section.append(el('p', { class: 'mt-0 muted', text: 'No receipt attached. Use Edit to attach a photo or PDF — it is stored locally with this record.' }));
    return;
  }
  const previewBox = el('div', { class: 'attachment-preview' });
  const isImage = /^image\//.test(purchase.attachment.type || '');
  const placeholder = el('span', { class: 'chip chip-neutral', 'aria-hidden': 'true' }, [svgIcon(isImage ? 'receipt' : 'doc'), purchase.attachment.name]);
  previewBox.append(placeholder, el('div', {}, [
    el('p', { class: 'mt-0 small', text: `${purchase.attachment.name} · ${fmtSize(purchase.attachment.size)}` }),
    el('div', { class: 'actions-row' }, [
      el('button', { class: 'btn btn-sm', onclick: () => openAttachment(purchase, 'view') }, [svgIcon('doc'), 'View']),
      el('button', { class: 'btn btn-sm', onclick: () => openAttachment(purchase, 'download') }, [svgIcon('download'), 'Download']),
    ]),
  ]));
  section.append(previewBox);
  if (isImage) {
    db.getFile(purchase.id)
      .then((rec) => {
        if (rec && rec.blob) {
          const url = URL.createObjectURL(rec.blob);
          liveObjectUrls.push(url);
          const img = el('img', { alt: `Receipt image for ${purchase.item}` });
          img.src = url;
          previewBox.replaceChild(img, placeholder);
        }
      })
      .catch(() => { /* keep the file-name chip */ });
  }
}

/* ------------------------------------------------- add / edit form ------------------------------------------------- */

const FIELD_ERROR_MAP = [
  [/^Merchant or store/, 'f-merchant'],
  [/^Item name/, 'f-item'],
  [/^Order number/, 'f-order-number'],
  [/^Purchase date/, 'f-purchase-date'],
  [/^Return-by date/, 'f-return-by'],
  [/^Amount/, 'f-amount'],
  [/^Currency/, 'f-currency'],
  [/^Status/, 'f-status'],
  [/^Notes/, 'f-notes'],
  [/^Follow-up date/, 'f-follow-up-date'],
  [/^Follow-up note/, 'f-follow-up-note'],
  [/attachment|Receipt/, 'f-attachment'],
];

function fieldIdForError(message) {
  for (const [re, id] of FIELD_ERROR_MAP) if (re.test(message)) return id;
  return null;
}

function isValidAttachmentFile(file) {
  return /^image\//.test(file.type || '') || file.type === 'application/pdf';
}

function viewEdit(id, today) {
  const purchase = id ? findPurchase(id) : null;
  if (id && !purchase) {
    return el('div', {}, [
      el('div', { class: 'page-head' }, [el('h1', { text: 'Record not found' })]),
      emptyState({
        title: 'This purchase is not on this device',
        message: 'It may have been deleted, or this link is from another device or an older backup.',
        actions: [el('a', { class: 'btn', href: '#/list' }, 'Back to purchases')],
      }),
    ]);
  }
  const editing = Boolean(purchase);
  const frag = el('div');

  frag.append(
    el('p', {}, [el('a', { class: 'link', href: editing ? `#/item/${id}` : '#/list' }, '← Back')]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: editing ? 'Edit purchase' : 'Add purchase' }),
        el('p', { class: 'page-sub', text: 'Enter what you bought and when it must be returned by. Dates are yours to set.' }),
      ]),
    ])
  );

  let pendingFile = null;
  let removeAttachmentChecked = false;

  const errorSummary = el('div', { class: 'error-summary', role: 'alert', hidden: true }, []);
  frag.append(errorSummary);

  const currencyList = el('datalist', { id: 'currency-list' }, GENERIC_CURRENCIES.map((c) => el('option', { value: c })));
  frag.append(currencyList);

  const statusSelect = el('select', { id: 'f-status' },
    STATUSES.map((s) =>
      el('option', { value: s, selected: (purchase?.status || 'open') === s }, STATUS_LABELS[s])
    )
  );

  const followUpFields = el('div', { class: 'field-row' }, [
    el('div', { class: 'field' }, [
      el('label', { for: 'f-follow-up-date', text: 'Next follow-up date' }),
      el('input', { type: 'date', id: 'f-follow-up-date', value: purchase?.followUpDate || '' }),
      el('p', { class: 'hint', text: 'Shown while the status is “Refund pending”.' }),
    ]),
    el('div', { class: 'field' }, [
      el('label', { for: 'f-follow-up-note', text: 'Follow-up note / reference' }),
      el('input', { type: 'text', id: 'f-follow-up-note', maxlength: '300', value: purchase?.followUpNote || '', placeholder: 'Case number, “called support” …' }),
    ]),
  ]);

  const attachmentField = el('div', { class: 'field' }, [
    el('label', { for: 'f-attachment', text: 'Receipt or order confirmation (optional)' }),
  ]);
  if (purchase?.attachment) {
    attachmentField.append(
      el('p', { class: 'hint' }, [
        `Currently attached: ${purchase.attachment.name} (${fmtSize(purchase.attachment.size)}). `,
        el('button', {
          class: 'btn btn-sm btn-ghost',
          onclick: (event) => {
            event.preventDefault();
            openAttachment(purchase, 'view');
          },
        }, 'View it'),
      ]),
      el('div', { class: 'field' }, [
        el('label', {}, [
          el('input', {
            type: 'checkbox',
            onchange: (event) => { removeAttachmentChecked = event.target.checked; },
          }),
          ' Remove the attached file',
        ]),
      ])
    );
  }
  const fileInput = el('input', {
    type: 'file',
    id: 'f-attachment',
    accept: 'image/*,application/pdf',
    capture: 'environment',
    'aria-describedby': 'f-attachment-hint',
  });
  fileInput.addEventListener('change', () => {
    pendingFile = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
  });
  attachmentField.append(
    fileInput,
    el('p', { class: 'hint', id: 'f-attachment-hint', text: `A photo or PDF of the receipt, stored on this device only. Up to ${fmtSize(ATTACHMENT_MAX_BYTES)}. On phones this can open the camera.` })
  );

  const form = el(
    'form',
    { class: 'card form-grid', novalidate: true, onsubmit: (event) => event.preventDefault() },
    [
      el('div', { class: 'field' }, [
        el('label', { for: 'f-merchant', text: 'Merchant / store' }, [el('span', { class: 'req', text: ' *' })]),
        el('input', { type: 'text', id: 'f-merchant', maxlength: '120', autocomplete: 'off', value: purchase?.merchant || '', required: true }),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'f-item', text: 'Item name' }, [el('span', { class: 'req', text: ' *' })]),
        el('input', { type: 'text', id: 'f-item', maxlength: '200', autocomplete: 'off', value: purchase?.item || '', required: true }),
      ]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'f-purchase-date', text: 'Purchase date' }, [el('span', { class: 'req', text: ' *' })]),
          el('input', { type: 'date', id: 'f-purchase-date', value: purchase?.purchaseDate || today, required: true }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'f-return-by', text: 'Return by' }, [el('span', { class: 'req', text: ' *' })]),
          el('input', { type: 'date', id: 'f-return-by', value: purchase?.returnBy || '', required: true }),
          el('p', { class: 'hint', text: 'Set this from your receipt or the merchant’s policy — return windows vary by merchant and region, so it is never guessed for you.' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'f-order-number', text: 'Order number (optional)' }),
        el('input', { type: 'text', id: 'f-order-number', maxlength: '80', autocomplete: 'off', value: purchase?.orderNumber || '' }),
      ]),
      el('div', { class: 'field-row' }, [
        el('div', { class: 'field' }, [
          el('label', { for: 'f-amount', text: 'Amount (optional)' }),
          el('input', { type: 'number', id: 'f-amount', min: '0', step: '0.01', inputmode: 'decimal', value: purchase?.amount ?? '' }),
        ]),
        el('div', { class: 'field' }, [
          el('label', { for: 'f-currency', text: 'Currency (optional)' }),
          el('input', { type: 'text', id: 'f-currency', maxlength: '3', list: 'currency-list', value: purchase?.currency || '', placeholder: 'USD' }),
          el('p', { class: 'hint', text: 'Three-letter code, e.g. USD, EUR, GBP.' }),
        ]),
      ]),
      el('div', { class: 'field' }, [
        el('label', { for: 'f-status', text: 'Status' }),
        statusSelect,
        el('p', { class: 'hint', text: 'Everything here is manual — the status changes only when you change it.' }),
      ]),
      followUpFields,
      el('div', { class: 'field' }, [
        el('label', { for: 'f-notes', text: 'Notes / return instructions (optional)' }),
        el('textarea', { id: 'f-notes', rows: '3', maxlength: '2000', placeholder: 'Print label, drop-off point, chats with support …' }, purchase?.notes || ''),
      ]),
      attachmentField,
      el('div', { class: 'actions-row' }, [
        el('button', { type: 'submit', class: 'btn btn-primary' }, [svgIcon('check'), editing ? 'Save changes' : 'Save purchase']),
        el('a', { class: 'btn', href: editing ? `#/item/${id}` : '#/list' }, 'Cancel'),
      ]),
    ]
  );

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    // gather raw input
    const raw = {
      id: purchase?.id,
      merchant: $('#f-merchant').value,
      item: $('#f-item').value,
      purchaseDate: $('#f-purchase-date').value,
      returnBy: $('#f-return-by').value,
      orderNumber: $('#f-order-number').value,
      amount: $('#f-amount').value,
      currency: $('#f-currency').value,
      status: statusSelect.value,
      notes: $('#f-notes').value,
      followUpDate: $('#f-follow-up-date').value,
      followUpNote: $('#f-follow-up-note').value,
      createdAt: purchase?.createdAt,
    };
    const problems = [];
    if (pendingFile) {
      if (!isValidAttachmentFile(pendingFile)) {
        problems.push('Attachments must be an image (photo/screenshot) or a PDF.');
      } else if (pendingFile.size > ATTACHMENT_MAX_BYTES) {
        problems.push(`The attached file is ${fmtSize(pendingFile.size)} — the limit is ${fmtSize(ATTACHMENT_MAX_BYTES)} so it stays on your device sensibly. Try a photo or a lighter scan.`);
      }
    }
    const norm = normalizePurchase(raw, { requireReturnBy: true });
    problems.push(...norm.errors);

    if (problems.length > 0 || !norm.ok) {
      errorSummary.replaceChildren(
        el('p', { class: 'mt-0', text: 'Please fix the following:' }),
        el('ul', {}, problems.map((msg) => el('li', { text: msg })))
      );
      errorSummary.hidden = false;
      // mark offending fields
      const seen = new Set();
      for (const msg of problems) {
        const fieldId = fieldIdForError(msg);
        if (fieldId) {
          const input = $(`#${fieldId}`);
          if (input) {
            input.setAttribute('aria-invalid', 'true');
            seen.add(fieldId);
          }
        }
      }
      for (const input of form.querySelectorAll('[aria-invalid]')) {
        if (!seen.has(input.id)) input.removeAttribute('aria-invalid');
      }
      errorSummary.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    errorSummary.hidden = true;
    for (const input of form.querySelectorAll('[aria-invalid]')) input.removeAttribute('aria-invalid');

    try {
      const record = norm.purchase;
      // attachment bookkeeping
      if (pendingFile) {
        record.attachment = { name: pendingFile.name || 'receipt', type: pendingFile.type || 'application/octet-stream', size: pendingFile.size };
      } else if (removeAttachmentChecked) {
        record.attachment = null;
      } else if (purchase?.attachment) {
        record.attachment = purchase.attachment;
      }
      await db.putPurchase(record);
      if (pendingFile) {
        await db.putFile({ id: record.id, name: record.attachment.name, type: record.attachment.type, size: record.attachment.size, blob: pendingFile });
      } else if (removeAttachmentChecked && purchase?.attachment) {
        await db.deleteFile(record.id);
      }
      await reload();
      toast(editing ? 'Changes saved.' : `“${record.item}” saved.`);
      go(`#/item/${record.id}`);
    } catch (err) {
      toast(err.message || 'The purchase could not be saved.', 'bad');
    }
  });

  frag.append(form);
  return frag;
}

/* ------------------------------------------------- data & privacy view ------------------------------------------------- */

function viewData(today) {
  const frag = el('div');
  const receipts = state.purchases.filter((p) => p.attachment).length;
  frag.append(
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: 'Data & privacy' }),
        el('p', { class: 'page-sub', text: 'Backups, imports, and where your records live' }),
      ]),
    ]),
    el('section', { class: 'card notice' }, [
      el('h2', { style: 'margin: 0 0 6px; font-size: 1.05rem;', text: 'Your records stay on this device' }),
      el('ul', { class: 'small', style: 'margin: 0; padding-left: 18px;' }, [
        el('li', { text: 'Purchases and receipts are stored locally in this browser (IndexedDB). Nothing is sent anywhere — the app works fully offline.' }),
        el('li', { text: 'No account, no cloud sync, no analytics, no ads, and no access to your email or bank accounts.' }),
        el('li', { text: 'Clearing this browser’s site data or losing this device erases your records — export a backup regularly.' }),
        el('li', { text: 'Return-by dates are entered by you and vary by merchant and region. Nothing here is legal advice or proof of a merchant’s policy.' }),
      ]),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { style: 'margin: 0 0 4px; font-size: 1.05rem;', text: 'Export' }),
      el('p', { class: 'small muted', text: `${state.purchases.length} purchase record(s), ${receipts} receipt file(s) on this device.` }),
      el('div', { class: 'actions-row' }, [
        el('button', { class: 'btn btn-primary', onclick: exportBackupFile }, [svgIcon('download'), 'Export backup (JSON)']),
        el('button', { class: 'btn', onclick: exportCSVFile }, [svgIcon('download'), 'Export CSV']),
      ]),
      el('p', { class: 'fine-print', text: 'The JSON backup restores everything, including receipts while they are small in total (up to about 8 MB). Receipts over the limit are left out and noted — download those individually before erasing data. CSV is a plain-text copy of the record fields, with no attachments.' }),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { style: 'margin: 0 0 4px; font-size: 1.05rem;', text: 'Import' }),
      el('p', { class: 'small muted', text: 'Nothing you import is sent anywhere — files are read in your browser and saved to this device.' }),
      el('h3', { style: 'margin: 14px 0 4px; font-size: 0.95rem;', text: 'Restore from a ReturnWindow backup (JSON)' }),
      el('p', { class: 'small muted', text: 'A backup made with the button above. You choose Merge (add to what is here) or Replace (delete everything here first) — always after a preview.' }),
      el('div', { class: 'actions-row' }, [
        (() => {
          const input = el('input', { type: 'file', id: 'import-backup', accept: '.json,application/json', class: 'btn' });
          input.addEventListener('change', () => {
            handleImportBackup(input.files ? input.files[0] : null);
            input.value = '';
          });
          return el('span', {}, [el('label', { for: 'import-backup', class: 'small muted', text: 'Choose backup file:' }), input]);
        })(),
      ]),
      el('h3', { style: 'margin: 18px 0 4px; font-size: 0.95rem;', text: 'Import purchases from CSV' }),
      el('p', { class: 'small muted', text: 'Column format (a header row is optional; without one, this exact order is expected):' }),
      el('pre', { class: 'code-sample', text: 'merchant,item,purchaseDate,returnBy,orderNumber,amount,currency,status,notes,followUpDate,followUpNote\nNordisk Home,Coffee grinder,2025-11-01,2025-11-15,A-1234,89.00,USD,open,Unused gift,,,' }),
      el('p', { class: 'small muted', text: `Dates are YYYY-MM-DD. Status is one of: ${STATUSES.map((s) => STATUS_LABELS[s]).join(', ')} (blank means “Return window open”). You get a validation preview with exact row problems before anything is saved; invalid rows are skipped, existing records are never modified.` }),
      el('div', { class: 'actions-row' }, [
        (() => {
          const input = el('input', { type: 'file', id: 'import-csv', accept: '.csv,text/csv', class: 'btn' });
          input.addEventListener('change', () => {
            handleImportCSV(input.files ? input.files[0] : null);
            input.value = '';
          });
          return el('span', {}, [el('label', { for: 'import-csv', class: 'small muted', text: 'Choose CSV file:' }), input]);
        })(),
      ]),
    ]),
    el('section', { class: 'card', style: 'border-left: 4px solid var(--red);' }, [
      el('h2', { style: 'margin: 0 0 4px; font-size: 1.05rem;', text: 'Danger zone' }),
      el('p', { class: 'small muted', text: 'Permanently erases every purchase and receipt stored by ReturnWindow in this browser. Export a backup first if you want to keep them.' }),
      el('div', { class: 'actions-row' }, [
        el('button', { class: 'btn btn-danger', onclick: eraseAll, disabled: state.purchases.length === 0 }, [svgIcon('trash'), 'Erase all data']),
      ]),
    ]),
    el('section', { class: 'card' }, [
      el('h2', { style: 'margin: 0 0 4px; font-size: 1.05rem;', text: 'About' }),
      el('p', { class: 'small muted', text: 'ReturnWindow is an early, local-first MVP: it does not verify merchant policies, does not track packages automatically, and does not confirm refunds with your bank. Every date and status is what you record. See README.md for details, the CSV schema, and how this differs from warranty trackers like Warracker.' }),
    ])
  );

  // best-effort storage usage line
  db.storageEstimate()
    .then((est) => {
      if (est && typeof est.usage === 'number') {
        const note = el('p', { class: 'small muted', text: `Local storage used by this app: about ${fmtSize(est.usage)}${est.quota ? ` of ${fmtSize(est.quota)} available` : ''}.` });
        frag.insertBefore(note, frag.children[2] ? frag.children[2] : null);
      }
    })
    .catch(() => {});
  return frag;
}

/* ------------------------------------------------- router / boot ------------------------------------------------- */

function currentRoute() {
  const path = (location.hash || '#/today').replace(/^#\/?/, '');
  const [segment, param] = path.split('/');
  switch (segment) {
    case 'list':
      return { name: 'list' };
    case 'data':
      return { name: 'data' };
    case 'item':
      return { name: 'item', id: param || '' };
    case 'edit':
      return { name: 'edit', id: param || 'new' };
    default:
      return { name: 'today' };
  }
}

function go(hash) {
  if (location.hash === hash) {
    render(false);
  } else {
    location.hash = hash;
  }
}

function updateTabbar(route) {
  for (const tab of document.querySelectorAll('.tab')) {
    if (tab.dataset.route === route.name) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
}

function render(fromNavigation = false) {
  const today = todayISO();
  const route = currentRoute();
  // free any object URLs from the previous render
  for (const url of liveObjectUrls.splice(0)) {
    try { URL.revokeObjectURL(url); } catch { /* noop */ }
  }
  const main = $('#main');
  let view;
  switch (route.name) {
    case 'list': view = viewList(today); break;
    case 'data': view = viewData(today); break;
    case 'item': view = viewItem(route.id, today); break;
    case 'edit': view = viewEdit(route.id === 'new' ? null : route.id, today); break;
    default: view = viewToday(today);
  }
  main.replaceChildren(view);
  updateTabbar(route);
  if (fromNavigation) {
    window.scrollTo(0, 0);
    const heading = $('#main h1');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const host = location.hostname;
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(host)) return;
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is best-effort */ });
}

async function init() {
  try {
    state.purchases = await db.listPurchases();
  } catch (err) {
    state.loadError = err.message || 'Local storage could not be read — records may not be saveable in this browser mode.';
  }
  window.addEventListener('hashchange', () => render(true));
  registerServiceWorker();
  render(false);
}

init();
