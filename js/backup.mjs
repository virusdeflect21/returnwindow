// backup.mjs — ReturnWindow JSON backup creation and validation.
// Pure logic (runs in Node tests and the browser). File blobs are not touched here;
// callers pass attachment data encoded as data URLs.

import { normalizePurchase } from './domain.mjs';

export const BACKUP_FORMAT = 'returnwindow-backup';
export const BACKUP_VERSION = 1;

// Attachments are embedded as data URLs when the combined payload stays under
// this limit. Beyond it the backup omits them and says so explicitly.
export const MAX_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;

// attachmentData: Map<purchaseId, { name, type, size, dataUrl }>
export function createBackup(purchases, attachmentData, options = {}) {
  const now = options.now || new Date().toISOString();
  const att = attachmentData instanceof Map ? attachmentData : new Map();
  const files = [];
  let totalBytes = 0;
  let attachmentsIncluded = false;

  for (const p of purchases) {
    const a = att.get(p.id);
    if (!a || typeof a.dataUrl !== 'string') continue;
    const approxBytes = Math.floor((a.dataUrl.length * 3) / 4);
    if (totalBytes + approxBytes > MAX_ATTACHMENT_TOTAL_BYTES) continue;
    totalBytes += approxBytes;
    files.push({
      id: p.id,
      name: a.name,
      type: a.type,
      size: a.size,
      dataUrl: a.dataUrl,
    });
  }

  const attachments = new Map(files.map((f) => [f.id, f]));
  const outPurchases = purchases.map((p) => {
    const meta = p.attachment;
    const has = meta ? attachments.has(p.id) : false;
    return {
      id: p.id,
      merchant: p.merchant,
      item: p.item,
      orderNumber: p.orderNumber || '',
      purchaseDate: p.purchaseDate || '',
      returnBy: p.returnBy || '',
      amount: p.amount,
      currency: p.currency || '',
      status: p.status,
      notes: p.notes || '',
      followUpDate: p.followUpDate || '',
      followUpNote: p.followUpNote || '',
      createdAt: p.createdAt || '',
      updatedAt: p.updatedAt || '',
      attachment: meta ? { name: meta.name, type: meta.type, size: meta.size, includedInBackup: has } : null,
    };
  });

  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now,
    app: 'ReturnWindow',
    attachmentPolicy: {
      maxTotalBytes: MAX_ATTACHMENT_TOTAL_BYTES,
      included: files.length,
      omitted: purchases.filter((p) => p.attachment && !attachments.has(p.id)).length,
    },
    purchases: outPurchases,
  };
  if (files.length > 0) backup.attachments = files;
  attachmentsIncluded = files.length > 0;
  backup.attachmentPolicy.includedAny = attachmentsIncluded;
  return backup;
}

// Validate a parsed JSON backup.
// Returns { ok, errors, warnings, purchases, attachments: Map<id, {name,type,size,dataUrl}>, meta }
export function validateBackup(input) {
  const result = {
    ok: false,
    errors: [],
    warnings: [],
    purchases: [],
    attachments: new Map(),
    meta: null,
  };

  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      result.errors.push('The file is not valid JSON.');
      return result;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    result.errors.push('The backup file has an unexpected structure.');
    return result;
  }
  if (data.format !== BACKUP_FORMAT) {
    result.errors.push(`This is not a ReturnWindow backup (format: ${String(data.format)}).`);
    return result;
  }
  if (typeof data.version !== 'number' || !Number.isInteger(data.version)) {
    result.errors.push('The backup is missing a valid version number.');
    return result;
  }
  if (data.version > BACKUP_VERSION) {
    result.warnings.push(
      `The backup was made by a newer version (v${data.version} > v${BACKUP_VERSION}). Fields may be understood incorrectly.`
    );
  }
  if (!Array.isArray(data.purchases)) {
    result.errors.push('The backup has no purchases list.');
    return result;
  }

  const purchases = [];
  data.purchases.forEach((raw, i) => {
    const norm = normalizePurchase({ ...raw, id: raw && raw.id ? raw.id : undefined });
    if (norm.ok) {
      // Dates in a backup are trusted serialized output; re-run date sanity anyway.
      purchases.push(norm.purchase);
    } else {
      result.errors.push(`Purchase #${i + 1} in the backup is invalid: ${norm.errors.join(' ')}`);
    }
  });
  if (purchases.length === 0 && data.purchases.length > 0) {
    result.errors.push('None of the purchases in the backup could be read.');
    return result;
  }
  if (purchases.length < data.purchases.length) {
    result.warnings.push(`${data.purchases.length - purchases.length} purchase(s) in the backup could not be read and will be skipped.`);
  }

  if (Array.isArray(data.attachments)) {
    for (const att of data.attachments) {
      if (!att || typeof att.id !== 'string' || typeof att.dataUrl !== 'string') {
        result.warnings.push('One attachment in the backup could not be read and will be skipped.');
        continue;
      }
      if (!/^data:[^,]+,/.test(att.dataUrl)) {
        result.warnings.push(`The attachment "${att.name || att.id}" does not look like a file and will be skipped.`);
        continue;
      }
      const purchase = purchases.find((p) => p.id === att.id);
      if (!purchase) {
        result.warnings.push(`The attachment "${att.name || 'file'}" does not belong to any purchase in this backup and will be skipped.`);
        continue;
      }
      purchase.attachment = {
        name: String(att.name || 'attachment'),
        type: String(att.type || 'application/octet-stream'),
        size: Number(att.size) || 0,
      };
      result.attachments.set(att.id, {
        name: purchase.attachment.name,
        type: purchase.attachment.type,
        size: purchase.attachment.size,
        dataUrl: att.dataUrl,
      });
    }
  } else if (data.attachmentPolicy && data.attachmentPolicy.omitted > 0) {
    result.warnings.push(
      'Receipt attachments were omitted from this backup (they exceeded the size limit). Download them individually before wiping data.'
    );
  }

  result.meta = {
    format: data.format,
    version: data.version,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : '',
    app: typeof data.app === 'string' ? data.app : '',
    count: purchases.length,
  };
  result.purchases = purchases;
  result.ok = result.errors.length === 0;
  return result;
}
