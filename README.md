# ReturnWindow

**A local-first returns tracker: capture what you bought, make the return deadline actionable, follow up until the refund lands.**

ReturnWindow answers two simple questions that shopping apps rarely handle well:

- *How long do I have to return this?* — one countdown per purchase, with an overdue state that never silently disappears.
- *Did the refund actually arrive?* — a deliberate refund follow-up state with a next-follow-up date and note.

Everything lives **on your device**. There is no account, no server, no sync, no telemetry.

> This project exists because tracking orders and return windows is a real, recurring ask — see the Reddit discussion that motivated it:
> [“What app do people use to track online orders and (how long they have to) return items?”](https://www.reddit.com/r/iosapps/comments/1d7lr72/what_app_do_people_use_to_track_online_orders_and/) (r/iosapps). Replies recommend package trackers plus separate calendar reminders, and ask for refund-progress tracking — which is exactly the gap ReturnWindow fills.

---

## Features

- **Today overview** — the most urgent return deadline with a clear countdown (`Due today`, `3 days left`, `Deadline passed 12 days ago`), how many purchases still need a return decision, refunds awaiting follow-up, quick actions (add, import), and per-item one-tap status moves.
- **Purchase capture** — merchant, item, order number, purchase date, **return-by date you set yourself**, optional amount/currency, notes, and an optional receipt/order-confirmation attachment (photo, screenshot, or PDF; mobile camera capture where supported).
- **Return workflow** — five statuses with deliberate one-tap transitions:
  | Status | Meaning |
  |---|---|
  | Return window open | bought, nothing started yet |
  | Return started | shipped back or drop-off scheduled |
  | Refund pending | waiting on the merchant |
  | Refund received | **you** recorded the refund (user-reported) |
  | Kept / closed | decided to keep it, or otherwise closed |
- **Deadline honesty** — items past their return-by date stay visible with an explicit “deadline passed” cue so you can still try (or close them as kept).
- **Refund follow-up** — for `Refund pending`, set a follow-up date and a note/reference (case number, who you spoke to). Due and overdue follow-ups surface on the Today screen. Marking a refund received is your report; ReturnWindow never claims bank verification.
- **Calendar reminders** — download a standard `.ics` event for the return deadline, and for the follow-up date when one is set.
- **Search & filter** — search by merchant, item, or order number; filter by open windows / return started / refund pending / closed; sorted with nearest deadline or follow-up first.
- **Import/export** — CSV import with a validation preview, ReturnWindow JSON backup (merge or replace, always with confirmation), CSV export, JSON backup export.

## Privacy, storage, and limits — read this

- **Local-first.** Purchases and receipt files are stored in your browser's IndexedDB on this device. The app makes **no network requests at runtime**; after first load it works fully offline (a service worker caches the app's own shell files).
- **No accounts, no cloud sync, no analytics, no ads**, and **no access to your email or bank accounts**. ReturnWindow never scans receipts or email — you type or paste the details yourself.
- **Data can be lost.** Clearing this browser's site data, using private/incognito mode, reinstalling the OS, or losing the device erases your records. **Export a JSON backup regularly** and keep it somewhere safe.
- **Dates are yours.** The return-by date is entered by you, from your receipt or the merchant's policy. Return windows vary by merchant and by region, can change, and ReturnWindow makes **no automatic claim about any retailer's policy**. Nothing in this app is legal advice or proof of what a merchant will accept.
- **Receipts in backups.** The JSON backup includes receipt attachments while their combined size stays under ~8 MB; larger receipts are omitted and the backup says so — download those individually (available on each purchase's detail page) before erasing data. **CSV never contains attachments.**
- **Reminders are calendar files.** The `.ics` download adds a reminder **through your own calendar app**. ReturnWindow has no servers and does **not** send background or push notifications while the app is closed.

## Scope: this is not a warranty vault

ReturnWindow deliberately does one thing: return deadlines and refund follow-up. It is **not** a warranty manager and does not duplicate comprehensive warranty trackers like [Warracker](https://github.com/sassanix/warracker) (a self-hosted warranty tracker with warranty records, claims, documents, alerts, exports, and team features). No warranty periods, no serial numbers, no claims workflows, no team access — by design. If you need those, run Warracker alongside this.

## Install and run

Any static file host works for production. For local development a tiny dependency-free Node server is included (Node ≥ 18, no `npm install` needed — there are **no dependencies**):

```bash
npm start          # serves the app at http://127.0.0.1:8080/ (set PORT to change)
```

Then open the URL on your phone or desktop. The service worker is registered automatically on `localhost` (registered in normal browsing; best-effort only — the app works without it).

## Tests and checks (no network access required)

```bash
npm test           # unit tests via Node's built-in test runner (node --test)
npm run check      # syntax check (node --check) + offline policy scan + manifest/JSON validation
```

The unit suite covers date/countdown classification (due today, overdue, month/year/leap/DST boundaries, time-zone-safe day math), workflow and follow-up logic, CSV parsing/validation (quoting, BOM, headers, row errors), JSON backup round-trips and validation, and `.ics` layout/escaping/folding.

`npm run check` additionally scans every JS/HTML source for forbidden patterns — `eval`, dynamic `Function`, `document.write`, runtime network APIs, and remote URLs outside the two documented sources above — so the “local-only” promise stays enforceable in CI.

## CSV import schema

Columns (a header row is optional; with a header the order does not matter, without one this exact order is required):

```
merchant,item,purchaseDate,returnBy,orderNumber,amount,currency,status,notes,followUpDate,followUpNote
```

Example:

```csv
merchant,item,purchaseDate,returnBy,orderNumber,amount,currency,status,notes,followUpDate,followUpNote
Nordisk Home,Coffee grinder,2025-11-01,2025-11-15,A-1234,89.00,USD,open,Unused gift,,,
```

- `merchant`, `item`, `purchaseDate` are required; `returnBy` is strongly recommended (a record without one shows no countdown but still warns).
- Dates are `YYYY-MM-DD`. `amount` is a plain number. `currency` is a 3-letter code (e.g. `USD`).
- `status` is one of: `open`, `started`, `pending`, `received`, `kept` (blank = `open`).
- `followUpDate`/`followUpNote` matter while the status is `Refund pending`.
- The import always shows a **preview with a validation report first**; invalid rows are skipped with reasons, and nothing existing is modified or overwritten. Quoted fields, embedded commas/newlines, and CRLF files are handled; a UTF-8 BOM is tolerated.

## Backup and restore

- **Export** (Today → Data & privacy): *Export backup (JSON)* produces a portable, standards-versioned file with all purchases (and receipts within the size limit); *Export CSV* produces the plain-text table shown above.
- **Import (JSON)**: you choose **Merge** (add records not already present — id collisions are skipped) or **Replace** (permanently erases all current data first). Both paths show an explicit preview and require confirmation; there is no silent overwrite.
- **Import (CSV)**: preview-and-confirm only; invalid rows are skipped with per-row explanations.

## Tech

Dependency-free static PWA: plain ES modules, hand-rolled CSV/ICS/backup format code, IndexedDB for records and receipt blobs, DOM text APIs for all user content (no unsanitized HTML, no `eval`), inline SVG icons, system fonts. Modules under `js/`:

| File | Role |
|---|---|
| `domain.mjs` | statuses, transitions, validation, countdown/day math, sorting |
| `db.mjs` | IndexedDB wrapper (records + receipt blobs) with plain-language errors |
| `csv.mjs` | CSV parse/serialize + import validation |
| `backup.mjs` | JSON backup build/validate (with attachment size policy) |
| `ics.mjs` | RFC 5545 calendar file output |
| `app.mjs` | views, router, dialogs, toasts (single-page, hash navigation) |

MIT licensed — see `LICENSE`. This is an **early MVP**: it has not been verified on every browser/device, and it intentionally keeps a small feature surface.
