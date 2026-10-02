import { test } from 'node:test';
import assert from 'node:assert/strict';
import { intake } from '../intake.mjs';

const ok = {
  collected_at: '2026-10-02T03:55:12.345Z',
  mail: { signin_needed: false, folders: { Inbox: [] }, calendar: [] },
  teams: { signin_needed: false, conversations: [] },
  github: { ok: true, review_requests: [], work: [], mentions: [] },
  ado: { ok: true, skipped: true },
};

test('lists the judge left out are empty, and who is always a list of names', () => {
  const b = intake({ waiting: [{ id: 'w', who: 'Sam, Taylor', what: 'x' }] }, ok, null);
  assert.deepEqual([b.queue, b.highlights, b.done, b.waiting[0].who, b.waiting[0].not_waiting], [[], [], [], ['Sam', 'Taylor'], []]);
});

const sources = (inputs, judged = {}) => intake(judged, { ...ok, ...inputs }, null).sources;
const failed = list => list.filter(s => !s.ok).map(({ name, note, signin }) => ({ name, note, ...(signin && { signin }) }));

test('the sources are what the collector saw, whatever the judge wrote about them', () => {
  const list = sources({}, { sources: [{ name: 'GitHub', ok: false, note: 'please log in' }] });
  assert.deepEqual(list.map(s => [s.name, s.ok]), [['Outlook', true], ['Teams', true], ['GitHub', true]]);
});

test('Outlook stuck at sign-in fails Outlook and Teams, with one Microsoft sign-in', () => {
  assert.deepEqual(failed(sources({ mail: { ...ok.mail, signin_needed: true } })), [
    { name: 'Outlook', note: 'sign-in needed', signin: 'microsoft' },
    { name: 'Teams', note: 'sign-in needed', signin: 'microsoft' },
  ]);
});

test('a GitHub failure says why, with no sign-in button', () => {
  assert.deepEqual(failed(sources({ github: { ok: false, error: 'GitHub 401 /graphql - run `gh auth status`' } })),
    [{ name: 'GitHub', note: 'GitHub 401 /graphql - run `gh auth status`' }]);
});

test('Azure DevOps shows only when organisations are listed, and a failure offers the Azure sign-in', () => {
  assert.deepEqual(failed(sources({ ado: { ok: false, error: 'no Azure DevOps token - run `az login`' } })),
    [{ name: 'Azure DevOps', note: 'no Azure DevOps token - run `az login`', signin: 'azure' }]);
  assert.equal(sources({}).some(s => s.name === 'Azure DevOps'), false);
});

test('an organisation that could not be read fails Azure DevOps and is named', () => {
  assert.deepEqual(failed(sources({ ado: { ok: true, orgs: ['https://dev.azure.com/a'], errors: ['https://dev.azure.com/b: Azure DevOps 404'] } })),
    [{ name: 'Azure DevOps', note: 'https://dev.azure.com/b: Azure DevOps 404' }]);
});

test('a source the collector never got to is failed, not quiet', () => {
  assert.deepEqual(failed(sources({ teams: undefined, mail: { error: 'browser start failed' } })), [
    { name: 'Outlook', note: 'browser start failed' },
    { name: 'Teams', note: 'not read' },
  ]);
});

test('the brief is timed when the collector read everything, not when the judge thinks it is', () => {
  assert.equal(intake({ generated_at: '2026-10-02T09:00:00Z' }, ok, null).generated_at, '2026-10-02T03:55:12Z');
});

const prev = {
  generated_at: '2026-10-02T02:55:00Z',
  queue: [{ id: 'q1', title: 'Was mine' }, { id: 'q2', title: 'Still mine' }],
  waiting: [{ id: 'w1', who: ['Sam'], what: 'Was theirs' }],
  highlights: [{ id: 'h1', title: 'Old news', at: '2026-10-02T01:00:00Z' }],
};
const flags = x => ({ new: x.new, moved: x.moved, updated: x.updated });

test('since the last run: new, moved over from the other list, or updated', () => {
  const b = intake({
    queue: [{ id: 'w1', title: 'Back to me' }, { id: 'q2', title: 'Still mine', last_activity: '2026-10-02T03:10:00Z' }, { id: 'q3', title: 'Brand new' }],
    waiting: [{ id: 'q1', who: ['Ann'], what: 'Now theirs' }],
  }, ok, prev);
  assert.deepEqual(b.queue.map(flags), [
    { new: false, moved: true, updated: false }, { new: false, moved: false, updated: true }, { new: true, moved: false, updated: false }]);
  assert.deepEqual(flags(b.waiting[0]), { new: false, moved: true, updated: false });
});

test('a highlight with something newer on it is updated', () => {
  const b = intake({ highlights: [{ id: 'h1', title: 'Old news, again', at: '2026-10-02T03:20:00Z' }] }, ok, prev);
  assert.equal(b.highlights[0].updated, true);
});

test('a first run marks nothing new: there is nothing to compare with', () => {
  const b = intake({ queue: [{ id: 'q3', title: 'Brand new' }] }, ok, null);
  assert.deepEqual(flags(b.queue[0]), { new: undefined, moved: undefined, updated: undefined });
});
