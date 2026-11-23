// date/countdown classification tests, including time-zone and boundary cases
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidISODate,
  todayISO,
  daysBetween,
  addDaysISO,
  classifyDeadline,
  classifyFollowUp,
} from '../js/domain.mjs';

test('isValidISODate accepts real dates and rejects malformed ones', () => {
  assert.equal(isValidISODate('2025-11-23'), true);
  assert.equal(isValidISODate('2024-02-29'), true); // leap year
  assert.equal(isValidISODate('2023-02-29'), false); // not a leap year
  assert.equal(isValidISODate('2025-13-01'), false); // month out of range
  assert.equal(isValidISODate('2025-00-10'), false);
  assert.equal(isValidISODate('2025-04-31'), false); // April has 30 days
  assert.equal(isValidISODate('2025-4-31'), false); // zero-padded only
  assert.equal(isValidISODate('25-04-30'), false);
  assert.equal(isValidISODate(''), false);
  assert.equal(isValidISODate(null), false);
  assert.equal(isValidISODate(20250430), false);
});

test('todayISO uses the local calendar date, not UTC', () => {
  // 23:30 local on Feb 5 -> must report 02-05 regardless of timezone shifts
  const d = new Date(2025, 1, 5, 23, 30);
  assert.equal(todayISO(d), '2025-02-05');
  // 00:20 local on Jan 1
  const d2 = new Date(2025, 0, 1, 0, 20);
  assert.equal(todayISO(d2), '2025-01-01');
});

test('daysBetween is whole-day, month/year-safe and DST-safe', () => {
  assert.equal(daysBetween('2025-11-23', '2025-11-23'), 0);
  assert.equal(daysBetween('2025-11-23', '2025-11-24'), 1);
  assert.equal(daysBetween('2025-11-30', '2025-12-01'), 1); // month boundary
  assert.equal(daysBetween('2025-12-31', '2026-01-01'), 1); // year boundary
  assert.equal(daysBetween('2025-02-28', '2025-03-01'), 1); // non-leap February
  assert.equal(daysBetween('2024-02-28', '2024-03-01'), 2); // leap year
  assert.equal(daysBetween('2025-03-08', '2025-03-10'), 2); // US DST spring-forward window
  assert.equal(daysBetween('2025-11-02', '2025-11-01'), -1); // negative
  assert.equal(daysBetween('2025-01-01', '2025-12-31'), 364);
  assert.equal(daysBetween('bad', '2025-01-01'), null); // invalid input
});

test('addDaysISO crosses month and year boundaries', () => {
  assert.equal(addDaysISO('2025-11-30', 1), '2025-12-01');
  assert.equal(addDaysISO('2025-12-31', 1), '2026-01-01');
  assert.equal(addDaysISO('2025-01-01', -1), '2024-12-31');
  assert.equal(addDaysISO('2024-02-28', 1), '2024-02-29');
});

test('classifyDeadline boundaries: overdue, today, soon, upcoming, none', () => {
  const today = '2025-11-23';

  // due today
  let c = classifyDeadline('2025-11-23', today);
  assert.equal(c.state, 'today');
  assert.equal(c.days, 0);
  assert.equal(c.label, 'Due today');
  assert.equal(c.urgent, true);
  assert.equal(c.overdue, false);

  // one day overdue
  c = classifyDeadline('2025-11-22', today);
  assert.equal(c.state, 'overdue');
  assert.equal(c.overdue, true);
  assert.equal(c.label, 'Deadline passed yesterday');

  // far overdue
  c = classifyDeadline('2025-10-24', today);
  assert.equal(c.state, 'overdue');
  assert.equal(c.days, -30);
  assert.equal(c.label, 'Deadline passed 30 days ago');

  // exactly one day left
  c = classifyDeadline('2025-11-24', today);
  assert.equal(c.state, 'soon');
  assert.equal(c.days, 1);
  assert.equal(c.label, '1 day left');
  assert.equal(c.urgent, true);

  // a week out: soon but not urgent-3-days
  c = classifyDeadline('2025-11-30', today);
  assert.equal(c.state, 'soon');
  assert.equal(c.label, '7 days left');
  assert.equal(c.urgent, false);

  // more than a week out
  c = classifyDeadline('2025-12-05', today);
  assert.equal(c.state, 'upcoming');
  assert.equal(c.label, '12 days left');
  assert.equal(c.urgent, false);

  // no date set
  c = classifyDeadline('', today);
  assert.equal(c.state, 'none');
  assert.equal(c.days, null);
  assert.equal(c.overdue, false);
});

test('classifyDeadline across a leap boundary and full-year span', () => {
  const c = classifyDeadline('2024-03-01', '2024-02-28');
  assert.equal(c.days, 2);
  const year = classifyDeadline('2026-11-23', '2025-11-23');
  assert.equal(year.days, 365);
  assert.equal(year.label, '365 days left');
});

test('classifyFollowUp: due, overdue, upcoming, none', () => {
  const today = '2025-11-23';
  assert.equal(classifyFollowUp('', today).state, 'none');
  let f = classifyFollowUp('2025-11-23', today);
  assert.equal(f.state, 'due');
  assert.equal(f.label, 'Follow up today');
  assert.equal(f.due, true);
  f = classifyFollowUp('2025-11-22', today);
  assert.equal(f.state, 'overdue');
  assert.equal(f.label, 'Follow-up a day overdue');
  assert.equal(f.overdue, true);
  f = classifyFollowUp('2025-11-25', today);
  assert.equal(f.state, 'upcoming');
  assert.equal(f.label, 'Follow up in 2 days');
  assert.equal(f.due, false);
});
