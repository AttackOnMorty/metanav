import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubLists } from '../scripts/collect/codehost.mjs';

// GitHub's GraphQL answer, in the shape github.mjs asks for, with only what each test needs
const ME = 'jane';
const pr = (n, over = {}) => ({
  number: n, title: `PR ${n}`, url: `https://github.com/acme/api/pull/${n}`, createdAt: '2026-09-28T00:00:00Z', isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED', repository: { name: 'api' }, headRefName: 'feature', body: '', additions: 1, deletions: 1, changedFiles: 1,
  closingIssuesReferences: { nodes: [] }, commits: { nodes: [] }, comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...over,
});
const issue = (n, over = {}) => ({
  number: n, title: `Issue ${n}`, url: `https://github.com/acme/api/issues/${n}`, createdAt: '2026-09-20T00:00:00Z', body: '', repository: { name: 'api' },
  assignees: { nodes: [{ login: ME }] }, timelineItems: { nodes: [] }, comments: { nodes: [] },
  projectItems: { nodes: [{ status: { name: 'In progress' }, sprint: null }] }, ...over,
});
const data = over => ({ me: { login: ME }, review: { nodes: [] }, mine: { nodes: [] }, issues: { nodes: [] }, ...over });
const ctx = { since: '2026-10-01T00:00:00Z', today: '2026-10-02', now: Date.parse('2026-10-02T04:00:00Z') };
const parents = lists => Object.fromEntries(lists.work.map(w => [w.kind === 'pbi' ? `#${w.number}` : `PR ${w.number}`, (w.prs || []).map(p => p.number)]));

test('a PR sits under its PBI: GitHub\'s closing reference, else a "1234-" branch, else a "Part of #N" line - never a bare #N', () => {
  const lists = githubLists(data({
    issues: { nodes: [issue(101), issue(102), issue(103)] },
    mine: { nodes: [
      pr(1, { closingIssuesReferences: { nodes: [{ number: 101, repository: { name: 'api' } }] }, headRefName: '102-other' }),
      pr(2, { headRefName: '102-fix-login' }),
      pr(3, { body: 'Some notes\nPart of #103' }),
      pr(4, { body: 'As discussed in #101, this is separate' }),
    ] },
  }), ctx);
  assert.deepEqual(parents(lists), { '#101': [1], '#102': [2], '#103': [3], 'PR 4': [] });
});

test('feedback on my PR is new only after my own last reply and the window start; the newest is the one to open', () => {
  const by = (login, createdAt, url, __typename = 'User') => ({ author: { login, __typename }, createdAt, url });
  const [p] = githubLists(data({ mine: { nodes: [pr(5, {
    comments: { nodes: [by('sam', '2026-09-30T00:00:00Z', 'old'), by(ME, '2026-10-01T05:00:00Z', 'mine'), by('sam', '2026-10-01T06:00:00Z', 'c1'), by('ci-bot', '2026-10-01T07:00:00Z', 'bot', 'Bot')] },
    reviews: { nodes: [by('alex', '2026-10-01T04:00:00Z', 'before-mine'), by('alex', '2026-10-01T08:00:00Z', 'r1')] },
  })] } }), ctx).work;
  assert.deepEqual([p.new_feedback, p.latest_feedback_url], [2, 'r1']);
});

test('a review asked for again after my review waits from my review, as a re-review', () => {
  const [r] = githubLists(data({ review: { nodes: [{ ...pr(9), author: { login: 'sam' },
    reviews: { nodes: [{ author: { login: ME }, submittedAt: '2026-09-30T04:00:00Z' }] } }] } }), ctx).review_requests;
  assert.deepEqual([r.rereview, r.since, r.waiting_days], [true, '2026-09-30T04:00:00Z', 2]);
});

test('PBIs under way: in the current sprint, or in progress / review / blocked - never done', () => {
  const sprint = { title: 'Sprint 12', startDate: '2026-09-28', duration: 14 };
  const board = (status, sp = null) => ({ projectItems: { nodes: [{ status: { name: status }, sprint: sp }] } });
  const { work } = githubLists(data({ issues: { nodes: [
    issue(1, board('Ready', sprint)), issue(2, board('Blocked')), issue(3, board('Done', sprint)), issue(4, board('Ready')),
  ] } }), ctx);
  assert.deepEqual(work.map(w => [w.number, w.sprint_end]), [[1, '2026-10-12'], [2, null]]);
});
