import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adoCi, adoReview, adoReviewWait, workTree } from '../scripts/collect/codehost.mjs';

test('my PR\'s review state from the other reviewers\' votes', () => {
  const v = (vote, isRequired = false) => ({ vote, isRequired });
  assert.equal(adoReview([v(10), v(-10)]), 'CHANGES_REQUESTED');
  assert.equal(adoReview([v(10), v(-5)]), 'WAITING_FOR_AUTHOR');
  assert.equal(adoReview([v(10, true), v(5, true), v(0)]), 'APPROVED');     // every required reviewer approved
  assert.equal(adoReview([v(10, true), v(0, true)]), 'PENDING');
  assert.equal(adoReview([v(5), v(0)]), 'APPROVED');                        // none required: someone approved, nobody objects
  assert.equal(adoReview([v(0)]), 'PENDING');
});

test('my PR\'s CI from its build checks', () => {
  assert.equal(adoCi(['approved', 'rejected']), 'FAILURE');
  assert.equal(adoCi(['approved', 'running']), 'PENDING');
  assert.equal(adoCi(['approved']), 'SUCCESS');
  assert.equal(adoCi([]), 'NONE');
});

test('a PR waits on my review from its creation, until I approve', () => {
  assert.deepEqual(adoReviewWait({ vote: 0, created: '2026-09-29T00:00:00Z' }), { since: '2026-09-29T00:00:00Z', rereview: false });
  assert.equal(adoReviewWait({ vote: 10, created: '2026-09-29T00:00:00Z' }), null);
});

test('a PR I voted down is the author\'s move, until they push after my last word', () => {
  const base = { vote: -10, created: '2026-09-25T00:00:00Z', myLast: '2026-09-30T00:00:00Z' };
  assert.equal(adoReviewWait({ ...base, pushed: '2026-09-29T00:00:00Z' }), null);
  assert.deepEqual(adoReviewWait({ ...base, pushed: '2026-10-01T00:00:00Z' }), { since: '2026-10-01T00:00:00Z', rereview: true });
});

test('a work item\'s PRs sit under it by their linked id; the rest stay flat', () => {
  const tree = workTree([{ number: 7 }], [{ number: 1, parent: 7 }, { number: 2, parent: null }], (r, b) => r.parent === b.number);
  assert.deepEqual(tree.map(w => [w.kind, w.number, (w.prs || []).map(p => p.number)]), [['pbi', 7, [1]], ['pr', 2, []]]);
});

test('the carried-over links a host looks up: its own kind, each once, not ones its lists already have, at most so many', async () => {
  const { carriedOver } = await import('../scripts/collect/codehost.mjs');
  const text = JSON.stringify(['https://github.com/acme/api/pull/1', 'see https://github.com/acme/api/pull/2 and /pull/1 again https://github.com/acme/api/pull/1',
    'https://github.com/acme/api/issues/3', 'https://github.com/acme/web/pull/4']);
  const urls = carriedOver(text, /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g, ['https://github.com/acme/api/pull/2'], 2);
  assert.deepEqual(urls, ['https://github.com/acme/api/pull/1', 'https://github.com/acme/web/pull/4']);
});
