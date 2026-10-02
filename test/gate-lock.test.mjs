import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquire, busy, release } from '../gate.mjs';

const folder = () => mkdtempSync(join(tmpdir(), 'metanav-gate-'));
const MIN = 60e3;

test('only one run holds the lock at a time', () => {
  const dir = folder(), now = Date.now();
  assert.equal(acquire(dir, now), true);
  assert.equal(acquire(dir, now + MIN), false);
  assert.equal(busy(dir, now + MIN), true);
});

test('a released lock can be taken again', () => {
  const dir = folder(), now = Date.now();
  acquire(dir, now);
  release(dir);
  assert.equal(busy(dir, now), false);
  assert.equal(acquire(dir, now), true);
});

test('a lock left by a run that died is not busy, and the next run takes it', () => {
  const dir = folder(), now = Date.now();
  acquire(dir, now);
  assert.equal(busy(dir, now + 31 * MIN), false);
  assert.equal(acquire(dir, now + 31 * MIN), true);
});

test('a slow run that is still within its time keeps the lock', () => {
  const dir = folder(), now = Date.now();
  acquire(dir, now);
  assert.equal(busy(dir, now + 25 * MIN), true);
});
