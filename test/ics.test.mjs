// .ics calendar file tests: escaping, structure, folding, per-purchase events
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildICS, escapeICSText, purchaseEvents } from '../js/ics.mjs';

test('escapeICSText follows RFC 5545 escaping rules', () => {
  assert.equal(escapeICSText('plain text'), 'plain text');
  assert.equal(escapeICSText('comma, semicolon; backslash\\ slash'), 'comma\\, semicolon\\; backslash\\\\ slash');
  assert.equal(escapeICSText('line1\nline2'), 'line1\\nline2');
  assert.equal(escapeICSText('line1\r\nline2'), 'line1\\nline2');
  assert.equal(escapeICSText(null), '');
});

test('buildICS emits a well-formed all-day event', () => {
  const ics = buildICS(
    [{ date: '2025-11-30', uid: 'abc@returnwindow.local', title: 'Return deadline: Acme — Kettle', description: 'Return by 2025-11-30.' }],
    { stamp: new Date(Date.UTC(2025, 10, 23, 12, 0, 0)) }
  );
  const lines = ics.split('\r\n');
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.ok(ics.includes('VERSION:2.0'));
  assert.ok(ics.includes('PRODID:-//ReturnWindow//return-deadline-reminder//EN'));
  assert.ok(ics.includes('UID:abc@returnwindow.local'));
  assert.ok(ics.includes('DTSTAMP:20251123T120000Z'));
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20251130'));
  assert.ok(ics.includes('DTEND;VALUE=DATE:20251201'), 'DTEND is exclusive for all-day events');
  assert.ok(ics.includes('SUMMARY:Return deadline: Acme — Kettle'));
  assert.ok(ics.includes('BEGIN:VEVENT'));
  assert.ok(ics.includes('END:VEVENT'));
  assert.equal(lines[lines.length - 2], 'END:VCALENDAR');
  assert.ok(ics.endsWith('\r\n'), 'file ends with CRLF');
  // no stray bare LF/CRLF mixes
  assert.equal(ics.includes('\n\r'), false);
});

test('buildICS escapes commas and newlines in event text', () => {
  const ics = buildICS(
    [{ date: '2025-12-01', uid: 'x@y', title: 'Refund, follow-up', description: 'line one\nline two; done' }],
    { stamp: new Date(Date.UTC(2025, 0, 1)) }
  );
  assert.ok(ics.includes('SUMMARY:Refund\\, follow-up'));
  assert.ok(ics.includes('DESCRIPTION:line one\\nline two\\; done'));
});

test('buildICS folds long lines to 75 octets and keeps CRLF continuations', () => {
  const longTitle = `Return deadline: ${'Very Long Merchant Name '.repeat(20)} — ${'Item '.repeat(30)}`;
  const ics = buildICS([{ date: '2025-12-01', uid: 'long@y', title: longTitle }], { stamp: new Date(Date.UTC(2025, 0, 1)) });
  const lines = ics.split('\r\n');
  const summaryIndex = lines.findIndex((l) => l.startsWith('SUMMARY:'));
  assert.ok(summaryIndex > -1);
  for (const line of lines) {
    const octets = Buffer.byteLength(line, 'utf8');
    assert.ok(octets <= 75 || line.startsWith(' '), `line exceeds 75 octets: ${octets}`);
  }
  const joined = lines.slice(summaryIndex).filter((l) => l.startsWith(' ') || l.includes('SUMMARY:'))[0];
  // continuation lines start with a single space
  const continuation = lines[summaryIndex + 1];
  assert.ok(continuation.startsWith(' '), 'continuation lines start with a space');
});

test('purchaseEvents builds a deadline event, and a follow-up event only while refund is pending', () => {
  const base = { id: 'id-1', merchant: 'Acme', item: 'Kettle', orderNumber: 'A-1', status: 'open', returnBy: '2025-11-30', followUpDate: '2025-12-05', followUpNote: 'case #77' };
  let events = purchaseEvents(base);
  assert.equal(events.length, 1, 'not pending: no follow-up event');
  assert.equal(events[0].date, '2025-11-30');
  assert.ok(events[0].title.includes('Acme'));
  assert.ok(events[0].description.includes('check your receipt or merchant policy'), 'discloses that dates are user-entered');

  events = purchaseEvents({ ...base, status: 'pending' });
  assert.equal(events.length, 2);
  assert.equal(events[1].date, '2025-12-05');
  assert.ok(events[1].title.includes('Refund follow-up'));
  assert.ok(events[1].description.includes('case #77'));
  assert.ok(events[1].description.includes('does not verify bank activity'));

  // missing return date: nothing to remind about
  const empty = purchaseEvents({ ...base, returnBy: '', status: 'pending', followUpDate: '' });
  assert.equal(empty.length, 0);
  assert.equal(purchaseEvents(null).length, 0);
});
