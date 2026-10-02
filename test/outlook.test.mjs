import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarEvents, isMeeting, meetingTime, rowTime } from '../scripts/collect/outlook.mjs';

// Outlook on the web set to English, day/month/year dates and a 12-hour clock (README)
test('a mail row\'s time is read day first, on a 12-hour clock', () => {
  assert.equal(rowTime('Thu 1/10/2026 3:05 PM'), new Date(2026, 9, 1, 15, 5).getTime());
  assert.equal(rowTime('Fri 2/10/2026 12:10 AM'), new Date(2026, 9, 2, 0, 10).getTime());
  assert.equal(rowTime('Fri 2/10/2026 12:10 PM'), new Date(2026, 9, 2, 12, 10).getTime());
  assert.ok(Number.isNaN(rowTime(undefined)));
});

test('today\'s meetings are the day view\'s event labels, each once - not its time slots or its "3 events" summaries', () => {
  const standup = 'Stand-up, 9:30 AM to 9:45 AM, Friday, October 2, 2026, By Sam Lee, Busy, Recurring event';
  const leave = 'Public holiday, all day event, Friday, October 2, 2026, Free';
  assert.deepEqual(calendarEvents([standup, '9:30 AM', '10:00 AM to 10:30 AM', '3 events, Friday', leave, standup, 'Next week']), [standup, leave]);
});

test('a meeting invite\'s own time comes off its card: a time range, or all day', () => {
  assert.equal(meetingTime('Sam Lee\nScript review\nThu 8/10/2026 5:30 PM - 8:00 PM\nAccept'), 'Thu 8/10/2026 5:30 PM - 8:00 PM');
  assert.equal(meetingTime('Offsite\nMon 12/10/2026 (all day)'), 'Mon 12/10/2026 (all day)');
  assert.equal(meetingTime('No card yet'), null);
});

test('a row is a meeting invite when its label says so near the start', () => {
  assert.equal(isMeeting({ label: 'Unread Meeting Sam Lee Script review' }), true);
  assert.equal(isMeeting({ label: 'Sam Lee Re: notes from the Meeting yesterday' }), false);
});
