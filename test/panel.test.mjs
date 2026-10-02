import { test } from 'node:test';
import assert from 'node:assert/strict';
import Panel from '../panel.cjs';

const { model, record } = Panel;
// Friday 2 October 2026, local time
const at = (h, m = 0, d = 2) => new Date(2026, 9, d, h, m);
const iso = (h, m = 0, d = 2) => at(h, m, d).toISOString();
const NOW = at(14);

const brief = (over = {}) => ({ generated_at: iso(13, 55), next_run: iso(15), interval_min: 60, queue: [], waiting: [], highlights: [], done: [], sources: [], ...over });
const review = { id: 'https://github.com/o/r/pull/7', title: 'Review #7', last_activity: iso(9), effort: 'C' };
const titles = xs => xs.map(x => x.title || x.what);

test('a ticked request leaves the list and shows in today\'s DONE! rows, with its undo key', () => {
  const clicks = { done: { [review.id]: record(review, 'done', at(11)) }, read: {} };
  const V = model(brief({ queue: [review] }), clicks, NOW);
  assert.deepEqual(titles(V.ranked), []);
  assert.deepEqual(V.done.map(d => [d.what, d.key, !!d.dropped]), [['Review #7', review.id, false]]);
});

test('something new on a ticked request brings it back, and its tick no longer counts as done', () => {
  const clicks = { done: { [review.id]: record(review, 'done', at(11)) }, read: {} };
  const V = model(brief({ queue: [{ ...review, last_activity: iso(12) }] }), clicks, NOW);
  assert.deepEqual(titles(V.ranked), ['Review #7']);
  assert.deepEqual(V.done, []);
});

test('a dropped request is listed as DROPPED, not DONE!', () => {
  const clicks = { done: { [review.id]: record(review, 'drop', at(11)) }, read: {} };
  const [row] = model(brief({ queue: [review] }), clicks, NOW).done;
  assert.equal(row.dropped, true);
});

test('when the run confirms a tick, what happened shows under it and the run\'s own row isn\'t shown twice', () => {
  const clicks = { done: { [review.id]: record(review, 'done', at(11)) }, read: {} };
  const confirmed = { id: review.id, what: 'Reviewed #7 (approved)', at: iso(13), effort: 'C' };
  const V = model(brief({ done: [confirmed] }), clicks, NOW);
  assert.deepEqual(V.done.map(d => [d.what, d.note]), [['Review #7', 'Reviewed #7 (approved)']]);
});

test('yesterday\'s tick keeps the item hidden but isn\'t one of today\'s rows', () => {
  const clicks = { done: { [review.id]: record(review, 'done', at(17, 0, 1)) }, read: {} };
  const V = model(brief({ queue: [review] }), clicks, NOW);
  assert.deepEqual([titles(V.ranked), V.done], [[], []]);
});

test('Waiting On puts whoever is worth chasing first, then the longest wait', () => {
  const w = (who, day, nudge_now = false) => ({ id: who, who: [who], what: `${who}'s part`, since: iso(9, 0, day), nudge_now });
  // Ann asked yesterday, Bob today but it's time to chase him, Cy on 27 September
  const V = model(brief({ waiting: [w('Ann', 1), w('Bob', 2, true), w('Cy', -3)] }), { done: {}, read: {} }, NOW);
  assert.deepEqual(V.ledger.map(p => p.name), ['Bob', 'Cy', 'Ann']);
});

test('the sync line names the next run, and goes stale only once that run is well overdue', () => {
  const B = brief({ generated_at: iso(18, 2), next_run: new Date(2026, 9, 5, 9).toISOString() });   // Friday evening -> Monday
  assert.deepEqual([model(B, { done: {}, read: {} }, at(21)).sync.state, model(B, { done: {}, read: {} }, at(21)).sync.next], ['ok', 'Mon 09:00']);
  assert.equal(model(brief(), { done: {}, read: {} }, at(15, 20)).sync.state, 'ok');
  assert.equal(model(brief(), { done: {}, read: {} }, at(15, 40)).sync.state, 'stale');
});

test('every item shows one change, MOVED before NEW before UPDATE - the target included', () => {
  const q = [{ ...review, moved: true, updated: true }, { id: 'a', title: 'New ask', new: true }, { id: 'b', title: 'Nudged', updated: true }, { id: 'c', title: 'Quiet' }];
  const V = model(brief({ queue: q }), { done: {}, read: {} }, NOW);
  assert.deepEqual([V.top.change, ...V.rest.map(x => x.change)], ['MOVED', 'NEW', 'UPDATE', '']);
});

test('a request back after a tick shows UPDATE', () => {
  const clicks = { done: { [review.id]: record(review, 'done', at(11)) }, read: {} };
  assert.equal(model(brief({ queue: [{ ...review, last_activity: iso(12) }] }), clicks, NOW).top.change, 'UPDATE');
});

test('Got it hides a post until something newer happens on it, then it is back as UPDATE', () => {
  const post = { id: 'p', title: 'Sprint review moved', at: iso(9) };
  const read = { p: record(post, 'read', at(10)) };
  assert.deepEqual(model(brief({ highlights: [post] }), { done: {}, read }, NOW).highlights, []);
  const [back] = model(brief({ highlights: [{ ...post, at: iso(12) }] }), { done: {}, read }, NOW).highlights;
  assert.equal(back.change, 'UPDATE');
});

test('a post read before the click store kept records (just its time) still counts as read', () => {
  const post = { id: 'p', title: 'Sprint review moved', at: iso(9) };
  assert.deepEqual(model(brief({ highlights: [post] }), { done: {}, read: { p: iso(9) } }, NOW).highlights, []);
});

test('resolving a Waiting On loop stores who owed it with what they owed', () => {
  const loop = { id: 'conv/1', who: ['Sam', 'Taylor'], what: 'Decide where the TV scripts live', last_activity: iso(9) };
  assert.deepEqual(record(loop, 'done', at(11)), { at: iso(9), when: iso(11), title: 'Sam, Taylor: Decide where the TV scripts live', url: '' });
});
