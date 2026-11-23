// ics.mjs — build RFC 5545 calendar files for return deadlines and refund follow-ups.
// All-day events, CRLF line endings, line folding, text escaping. Pure logic.

import { addDaysISO } from './domain.mjs';

export function escapeICSText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Fold content lines to 75 octets (first line) / 74 for continuations.
// Input is treated as UTF-8 when counting octets.
export function foldLine(line) {
  return foldLineImpl(line);
}

function foldLineImpl(line) {
  const enc = new TextEncoder();
  const octets = enc.encode(line);
  if (octets.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75;
  while (start < octets.length) {
    // never split inside a multi-byte character
    let end = Math.min(start + limit, octets.length);
    while (end > start && (octets[end] & 0xc0) === 0x80) end -= 1;
    out.push(new TextDecoder().decode(octets.subarray(start, end)));
    start = end;
    limit = 74;
  }
  return out.length === 1 ? out[0] : out[0] + '\r\n ' + out.slice(1).join('\r\n ');
}

function icsDateToStamp(d = new Date()) {
  return (
    d.getUTCFullYear().toString() +
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    String(d.getUTCDate()).padStart(2, '0') + 'T' +
    String(d.getUTCHours()).padStart(2, '0') +
    String(d.getUTCMinutes()).padStart(2, '0') +
    String(d.getUTCSeconds()).padStart(2, '0') + 'Z'
  );
}

// events: [{ date: 'YYYY-MM-DD', uid, title, description }]
export function buildICS(events, options = {}) {
  const stamp = icsDateToStamp(options.stamp instanceof Date ? options.stamp : new Date());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//ReturnWindow//return-deadline-reminder//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  for (const ev of events) {
    if (!ev || !ev.date) continue;
    const end = addDaysISO(ev.date, 1); // DTEND is exclusive for all-day events
    const compact = String(ev.date).replace(/-/g, '');
    const compactEnd = end.replace(/-/g, '');
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${compact}`);
    lines.push(`DTEND;VALUE=DATE:${compactEnd}`);
    lines.push(`SUMMARY:${escapeICSText(ev.title)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeICSText(ev.description)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLineImpl).join('\r\n') + '\r\n';
}

// Reminder events for one purchase (deadline + follow-up when present).
export function purchaseEvents(purchase) {
  const events = [];
  if (!purchase) return events;
  if (purchase.returnBy) {
    events.push({
      date: purchase.returnBy,
      uid: `${purchase.id}-return-by@returnwindow.local`,
      title: `Return deadline: ${purchase.merchant} — ${purchase.item}`,
      description:
        `Return by ${purchase.returnBy} for "${purchase.item}" from ${purchase.merchant}` +
        (purchase.orderNumber ? `, order ${purchase.orderNumber}` : '') +
        '. Date entered by you in ReturnWindow — check your receipt or merchant policy to confirm.' +
        ' Reminder added via a downloaded calendar file; ReturnWindow does not send background alerts.',
    });
  }
  if (purchase.followUpDate && purchase.status === 'pending') {
    events.push({
      date: purchase.followUpDate,
      uid: `${purchase.id}-follow-up@returnwindow.local`,
      title: `Refund follow-up: ${purchase.merchant} — ${purchase.item}`,
      description:
        `Check whether the refund was received for "${purchase.item}" from ${purchase.merchant}` +
        (purchase.followUpNote ? `. Note: ${purchase.followUpNote}` : '') +
        '. "Refund received" is self-reported — ReturnWindow does not verify bank activity.',
    });
  }
  return events;
}
