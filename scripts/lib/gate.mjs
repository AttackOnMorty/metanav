// When Meta-Nav runs: the schedule's slots and hours, and the lock that keeps runs one at a time.
// `schedule` is config.schedule with its defaults: { every_minutes, start_hour, end_hour }.
import { mkdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

// The lock is a folder in the output dir, stamped with when its run started. A run takes at most this long (collect
// 5 minutes, the judge 20, then rendering): an older lock is left over from a run that died (power off, a crash).
const MAX_RUN = 30 * 60e3;
const lockOf = dir => join(dir, '.running');
const startedAt = dir => { try { return statSync(lockOf(dir)).mtimeMs; } catch { return null; } };

// A run holds the lock now (not one that died)
export function busy(dir, now = Date.now()) {
  const t = startedAt(dir);
  return t !== null && now - t < MAX_RUN;
}

// Take the lock for a run starting now; false when another run holds it
export function acquire(dir, now = Date.now()) {
  if (busy(dir, now)) return false;
  rmSync(lockOf(dir), { recursive: true, force: true });
  try { mkdirSync(lockOf(dir)); } catch { return false; }   // another run took it just now
  utimesSync(lockOf(dir), now / 1000, now / 1000);
  return true;
}

export function release(dir) {
  rmSync(lockOf(dir), { recursive: true, force: true });
}

// A scheduled run goes ahead on weekdays from start_hour until end_hour is over; one the user asked for, at any time
export function allowed(now, schedule, manual = false) {
  const day = now.getDay(), hour = now.getHours();
  return manual || (day >= 1 && day <= 5 && hour >= schedule.start_hour && hour <= schedule.end_hour);
}

// Slots are every so many minutes, counted from midnight (every 60: on the hour)
const minutes = d => d.getHours() * 60 + d.getMinutes();

// Which slot a time falls in: a scheduled run starts when this changes
export const slotOf = (d, schedule) => `${d.toDateString()} ${Math.floor(minutes(d) / schedule.every_minutes)}`;

// When the next scheduled run starts: the next slot that's allowed (Friday evening -> Monday morning)
export function nextRun(after, schedule) {
  const every = schedule.every_minutes;
  let t = after;
  for (let i = 0; i < 8 * 1440; i++) {   // a week of slots, whatever the interval
    const next = (Math.floor(minutes(t) / every) + 1) * every;
    // past midnight, the new day's first slot
    t = next < 1440 ? new Date(t.getFullYear(), t.getMonth(), t.getDate(), 0, next) : new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
    if (allowed(t, schedule)) return t;
  }
  return null;
}
