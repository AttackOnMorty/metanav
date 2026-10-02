import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, nextRun, slotOf } from '../gate.mjs';

const HOURLY = { every_minutes: 60, start_hour: 9, end_hour: 18 };
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m);   // October 2026: the 2nd is a Friday

test('a scheduled run goes ahead on a weekday within the hours', () => {
  assert.equal(allowed(at(2, 10), HOURLY), true);
});

test('a scheduled run waits out the weekend and the evening', () => {
  assert.equal(allowed(at(3, 10), HOURLY), false);       // Saturday
  assert.equal(allowed(at(2, 19), HOURLY), false);       // Friday evening
  assert.equal(allowed(at(2, 18, 30), HOURLY), true);    // the end hour itself still runs
});

test('a run the user asked for goes ahead at any hour', () => {
  assert.equal(allowed(at(3, 22), HOURLY, true), true);
});

test('the next run is the next slot, not an interval after the last run', () => {
  assert.deepEqual(nextRun(at(2, 10, 37), HOURLY), at(2, 11));
});

test('after the last run of the week, the next one is Monday morning', () => {
  assert.deepEqual(nextRun(at(2, 18, 5), HOURLY), at(5, 9));
});

test('a half-hourly schedule runs on the half hour', () => {
  assert.deepEqual(nextRun(at(2, 10, 5), { ...HOURLY, every_minutes: 30 }), at(2, 10, 30));
});

test('a slot turns on the hour, and at midnight', () => {
  assert.equal(slotOf(at(2, 10), HOURLY), slotOf(at(2, 10, 59), HOURLY));
  assert.notEqual(slotOf(at(2, 10, 59), HOURLY), slotOf(at(2, 11), HOURLY));
  assert.notEqual(slotOf(at(2, 23, 59), HOURLY), slotOf(at(3, 0), HOURLY));
});
