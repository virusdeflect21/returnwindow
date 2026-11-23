// csv.mjs — dependency-free CSV parsing/serialization plus import mapping/validation.
// Pure logic; runs in Node (tests) and the browser. No dependencies, no eval.

import { normalizePurchase, isValidISODate, STATUSES } from './domain.mjs';

// Documented import column format (README is the source of truth).
export const CSV_COLUMNS = [
  'merchant',
  'item',
  'purchaseDate',
  'returnBy',
  'orderNumber',
  'amount',
  'currency',
  'status',
  'notes',
  'followUpDate',
  'followUpNote',
];

const CANONICAL_BY_LOWER = new Map(CSV_COLUMNS.map((name) => [name.toLowerCase(), name]));

function rowIsBlank(row) {
  return row.length === 1 && row[0].trim() === '';
}

/* ------------------------------------------------- parsing ------------------------------------------------ */

// Parse CSV text into rows of strings. Supports quoted fields, "" escapes, CRLF/CR/LF.
// Returns { rows, error } — error is a plain-language string for a malformed file.
export function parseCSV(text) {
  const rows = [];
  let error = null;
  // strip a UTF-8 BOM (common in spreadsheet exports) so the first header cell reads cleanly
  const input = String(text ?? '').replace(/^\uFEFF/, '');
  let row = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const n = input.length;

  while (i < n) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (!rowIsBlank(row)) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (inQuotes) {
    error = 'The file ends inside a quoted value — check for a missing closing quote ("").';
  }
  // complete any field/row that was still pending when the file ended
  if (field !== '' || row.length > 0) row.push(field);
  if (row.length > 0 && !rowIsBlank(row)) rows.push(row);
  return { rows, error };
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCSV(rows) {
  return rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

/* --------------------------------------------- purchase mapping -------------------------------------------- */

function rowToRecord(cells, headerNames) {
  const rec = {};
  if (headerNames) {
    // map each cell by its header name and *that header's* position in the file,
    // restoring the canonical (camelCase) key (headers are matched case-insensitively)
    headerNames.forEach((lower, position) => {
      const canonical = CANONICAL_BY_LOWER.get(lower) || lower;
      rec[canonical] = cells[position] ?? '';
    });
  } else {
    CSV_COLUMNS.forEach((name, idx) => {
      rec[name] = cells[idx] ?? '';
    });
  }
  return rec;
}

// Detect the documented header row (order-independent, case-insensitive).
function isHeaderRow(cells) {
  const names = cells.map((c) => String(c).trim().toLowerCase());
  if (names.length !== CSV_COLUMNS.length) return false;
  const set = new Set(names);
  if (set.size !== CSV_COLUMNS.length) return false;
  return CSV_COLUMNS.every((c) => set.has(c.toLowerCase()));
}

// Import pipeline: parse → per-row validation → report.
// Returns {
//   hadHeader, rows: [{line, cells, ok, purchase, errors, warnings}],
//   validCount, invalidCount, validPurchases
// }
export function parsePurchasesCSV(text) {
  const parsed = parseCSV(text);
  const rows = parsed.rows;
  const result = {
    hadHeader: false,
    rows: [],
    validCount: 0,
    invalidCount: 0,
    validPurchases: [],
    fatalErrors: [],
    warnings: [],
  };
  if (parsed.error) result.fatalErrors.push(parsed.error);
  if (rows.length === 0) {
    result.fatalErrors.push('The CSV file is empty.');
    return result;
  }

  let body = rows;
  let headerNames = null;
  if (isHeaderRow(rows[0])) {
    result.hadHeader = true;
    body = rows.slice(1);
    headerNames = rows[0].map((c) => String(c).trim().toLowerCase());
    if (body.length === 0) result.warnings.push('The file only contains a header row — no purchases to import.');
  }

  body.forEach((cells, i) => {
    const line = result.hadHeader ? i + 2 : i + 1;
    const entry = { line, cells, ok: false, purchase: null, errors: [], warnings: [] };
    if (cells.length !== CSV_COLUMNS.length) {
      entry.errors.push(
        `Row ${line} has ${cells.length} column${cells.length === 1 ? '' : 's'} but the format needs exactly ${CSV_COLUMNS.length}.`
      );
      result.rows.push(entry);
      result.invalidCount += 1;
      return;
    }
    const rec = rowToRecord(cells, headerNames);
    const norm = normalizePurchase(rec);
    entry.errors = norm.errors;
    entry.warnings = norm.warnings;
    entry.ok = norm.ok;
    entry.purchase = norm.purchase;
    if (norm.ok) {
      result.validCount += 1;
      result.validPurchases.push(norm.purchase);
    } else {
      result.invalidCount += 1;
    }
    result.rows.push(entry);
  });
  return result;
}

/* ------------------------------------------------- export ------------------------------------------------- */

export function purchaseToCSVRow(p) {
  return [
    p.merchant,
    p.item,
    p.purchaseDate || '',
    p.returnBy || '',
    p.orderNumber || '',
    p.amount === null || p.amount === undefined ? '' : String(p.amount),
    p.currency || '',
    p.status || '',
    p.notes || '',
    p.followUpDate || '',
    p.followUpNote || '',
  ];
}

export function purchasesToCSV(purchases) {
  return toCSV([CSV_COLUMNS, ...purchases.map(purchaseToCSVRow)]);
}
