// db.mjs — IndexedDB persistence. Records live in the `purchases` store,
// receipt blobs in the `files` store (keyed by purchase id).
// All failures reject with an Error carrying a plain-language message.

const DB_NAME = 'returnwindow';
const DB_VERSION = 1;
export const STORE_PURCHASES = 'purchases';
export const STORE_FILES = 'files';

let dbPromise = null;

function friendlyError(err) {
  if (err instanceof Error) return err;
  const e = new Error(err && err.message ? err.message : 'Storage operation failed.');
  e.cause = err;
  return e;
}

function openDatabase() {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(
      new Error('This browser does not support local storage (IndexedDB), so ReturnWindow cannot save your records.')
    );
  }
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db_ = req.result;
      if (!db_.objectStoreNames.contains(STORE_PURCHASES)) db_.createObjectStore(STORE_PURCHASES, { keyPath: 'id' });
      if (!db_.objectStoreNames.contains(STORE_FILES)) db_.createObjectStore(STORE_FILES, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db_ = req.result;
      db_.onversionchange = () => db_.close();
      resolve(db_);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(
        new Error(
          'Local storage could not be opened. Private browsing or blocked site data prevents saving. Records cannot be stored in this browser mode.'
        )
      );
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('Local storage is locked by another tab using an older version of ReturnWindow. Close other ReturnWindow tabs and retry.'));
    };
  }).catch(friendlyError);
  return dbPromise;
}

function tx(storeName, mode, fn) {
  return openDatabase().then(
    (db_) =>
      new Promise((resolve, reject) => {
        const t = db_.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        let result;
        const request = fn(store);
        if (request) {
          request.onsuccess = () => {
            result = request.result;
          };
          request.onerror = () => reject(friendlyError(request.error));
        }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(friendlyError(t.error));
        t.onabort = () => reject(friendlyError(t.error || new Error('Storage operation was aborted.')));
      })
  );
}

export async function listPurchases() {
  const rows = await tx(STORE_PURCHASES, 'readonly', (s) => s.getAll());
  return Array.isArray(rows) ? rows : [];
}

export function putPurchase(purchase) {
  if (!purchase || typeof purchase.id !== 'string') {
    return Promise.reject(new Error('The record is missing an id, so it cannot be saved.'));
  }
  return tx(STORE_PURCHASES, 'readwrite', (s) => s.put(purchase));
}

export function getPurchase(id) {
  return tx(STORE_PURCHASES, 'readonly', (s) => s.get(id));
}

export async function savePurchases(purchases) {
  // small sequential writes; keeps transaction scope small and errors precise
  for (const p of purchases) await putPurchase(p);
  return purchases.length;
}

export function deletePurchase(id) {
  return Promise.all([
    tx(STORE_PURCHASES, 'readwrite', (s) => s.delete(id)),
    tx(STORE_FILES, 'readwrite', (s) => s.delete(id)),
  ]).then(() => undefined);
}

export async function clearAll() {
  await tx(STORE_PURCHASES, 'readwrite', (s) => s.clear());
  await tx(STORE_FILES, 'readwrite', (s) => s.clear());
}

/* ------------------------------------------------- files ------------------------------------------------- */

export function putFile(fileRecord) {
  if (!fileRecord || typeof fileRecord.id !== 'string') {
    return Promise.reject(new Error('The attachment is missing a record id to link to.'));
  }
  return tx(STORE_FILES, 'readwrite', (s) => s.put({ id: fileRecord.id, name: fileRecord.name, type: fileRecord.type, size: fileRecord.size, blob: fileRecord.blob }));
}

export function getFile(id) {
  return tx(STORE_FILES, 'readonly', (s) => s.get(id));
}

export async function listFileRecords() {
  const rows = await tx(STORE_FILES, 'readonly', (s) => s.getAll());
  return Array.isArray(rows) ? rows : [];
}

export function deleteFile(id) {
  return tx(STORE_FILES, 'readwrite', (s) => s.delete(id));
}

// Attachment blob -> data URL (for JSON backups).
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The attachment could not be read for the backup.'));
    reader.readAsDataURL(blob);
  });
}

// Data URL -> Blob (for JSON imports).
export function dataUrlToBlob(dataUrl) {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3];
  try {
    if (isBase64) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(payload)], { type: mime });
  } catch {
    return null;
  }
}

export async function storageEstimate() {
  if (globalThis.navigator && navigator.storage && typeof navigator.storage.estimate === 'function') {
    try {
      const est = await navigator.storage.estimate();
      if (est && typeof est.usage === 'number') return est;
    } catch {
      /* ignore — estimate is best-effort */
    }
  }
  return null;
}
