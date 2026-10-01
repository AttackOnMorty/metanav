// GitHub + Azure DevOps state for Meta-Nav. Deterministic, no judgement.
// Usage: node fetch.mjs <SINCE ISO8601 UTC>   -> prints one JSON object (collect.mjs imports fetchAll instead)
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ado, config, github, graphql } from './common.mjs';

const pad = n => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysSince = t => Math.floor((Date.now() - Date.parse(t)) / 864e5);
const max = xs => xs.filter(Boolean).sort().pop() ?? null;
// drop a size prefix, e.g. "XL⚠️ ◾ feat: ..." -> "feat: ..."
const clean = s => (s || '').replace(/^[^◾]{0,8}◾\s*/u, '');
// a sprint runs from its start for `duration` days: current when start <= today < end
const sprintEnd = sp => new Date(Date.parse(`${sp.startDate}T00:00:00Z`) + sp.duration * 864e5).toISOString().slice(0, 10);
const current = (sp, today) => !!sp && sp.startDate <= today && sprintEnd(sp) > today;

async function fromGithub(SINCE) {
  const owner = config.github_owner;
  const q = s => JSON.stringify(`${s} org:${owner} archived:false`);
  const d = await graphql(`{ me: viewer { login }
  review: search(query: ${q('is:pr is:open review-requested:@me')}, type: ISSUE, first: 30) { nodes { ... on PullRequest {
    number title url createdAt isDraft author { login } repository { name } additions deletions changedFiles
    reviews(last: 30) { nodes { author { login } submittedAt } } } } }
  mine: search(query: ${q('is:pr is:open author:@me')}, type: ISSUE, first: 30) { nodes { ... on PullRequest {
    number title url createdAt isDraft reviewDecision repository { name } headRefName body additions deletions changedFiles
    closingIssuesReferences(first: 1) { nodes { number repository { name } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    comments(last: 30) { nodes { url author { __typename login } createdAt } }
    reviews(last: 30) { nodes { url author { __typename login } createdAt state } }
    reviewThreads(last: 50) { nodes { isResolved } } } } }
  issues: search(query: ${q('is:issue is:open assignee:@me')}, type: ISSUE, first: 50) { nodes { ... on Issue {
    number title url createdAt body repository { name } assignees(first: 5) { nodes { login } }
    timelineItems(itemTypes: [ASSIGNED_EVENT], last: 10) { nodes { ... on AssignedEvent { createdAt assignee { ... on User { login } } } } }
    comments(last: 20) { nodes { url author { login } createdAt body } }
    projectItems(first: 3) { nodes {
      status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
      sprint: fieldValueByName(name: "Sprint") { ... on ProjectV2ItemFieldIterationValue { title startDate duration } } } } } } }
}`);
  const me = d.me.login, today = localDay();
  const nodes = x => (x?.nodes || []).filter(Boolean);

  // Each PR resolved to its parent PBI, in trust order: GitHub's closing reference, a "1234-" branch prefix, then a
  // line-anchored "Part of / Fixes #N". A bare "#N" in prose is never used - it is usually incidental discussion.
  const prs = nodes(d.mine).map(p => {
    const fb = [...nodes(p.comments), ...nodes(p.reviews)];
    // feedback counts only if it came after both the window start and my own last reply
    const after = max([SINCE, ...fb.filter(f => f.author?.login === me).map(f => f.createdAt)]);
    const fresh = fb.filter(f => f.author?.__typename === 'User' && f.author.login !== me && f.createdAt > after)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const keyword = (p.body || '').match(/^\s*(?:part of|fixes|fixed|closes|closed|resolves|resolved) #(\d{2,6})/im);
    return {
      repo: p.repository.name, number: p.number, title: clean(p.title), url: p.url, draft: p.isDraft, since: p.createdAt,
      size: { files: p.changedFiles, added: p.additions, removed: p.deletions },
      review: p.reviewDecision || 'PENDING',
      ci: nodes(p.commits)[0]?.commit?.statusCheckRollup?.state || 'NONE',
      unresolved_threads: nodes(p.reviewThreads).filter(t => !t.isResolved).length,
      new_feedback: fresh.length,
      // the newest of that feedback, to open it directly rather than the top of the PR
      latest_feedback_url: fresh.at(-1)?.url ?? null,
      parent: nodes(p.closingIssuesReferences)[0]?.number ?? (+(p.headRefName.match(/^(\d{2,6})-/) || [])[1] || null)
        ?? (keyword ? +keyword[1] : null),
    };
  });

  const pbis = nodes(d.issues).flatMap(i => {
    const p = nodes(i.projectItems)[0] || {}, status = p.status?.name || '';
    if (/done/i.test(status) || !(current(p.sprint, today) || /progress|review|block/i.test(status))) return [];
    return [{
      repo: i.repository.name, number: i.number, title: i.title, url: i.url,
      // when it became theirs: the last time it was assigned to them, else when it was opened
      since: nodes(i.timelineItems).filter(e => e.assignee?.login === me).at(-1)?.createdAt || i.createdAt,
      // what it says: the whole body and its comments (each capped only against pasted logs)
      assignees: nodes(i.assignees).map(a => a.login), body: (i.body || '').slice(0, 20000),
      comments: nodes(i.comments).map(c => ({ by: c.author?.login, at: c.createdAt, url: c.url, text: (c.body || '').slice(0, 2000) })),
      status: status || '-', sprint: p.sprint?.title || '-',
      // the day the sprint ends - the PBI deadline, when its board runs sprints and this one is current
      sprint_end: current(p.sprint, today) ? sprintEnd(p.sprint) : null,
    }];
  });

  // A re-request after my review is a new wait: count from my last review, not from PR creation.
  // Drafts stay in: an author may park a PR as a draft while it waits on my review. The run decides whether it matters.
  const review_requests = nodes(d.review).map(p => {
    const mine = max(nodes(p.reviews).filter(r => r.author?.login === me).map(r => r.submittedAt));
    const since = max([p.createdAt, mine || p.createdAt]);
    return {
      repo: p.repository.name, number: p.number, title: clean(p.title), url: p.url, author: p.author?.login,
      draft: p.isDraft, rereview: mine != null,
      size: { files: p.changedFiles, added: p.additions, removed: p.deletions },   // what a review of it takes
      since, waiting_days: daysSince(since),
    };
  });

  // "My work": one row per PBI with its PRs nested; PRs with no PBI on the board sit flat
  const work = [
    ...pbis.map(b => ({ ...b, kind: 'pbi', prs: prs.filter(r => r.repo === b.repo && r.parent === b.number) })),
    ...prs.filter(r => !pbis.some(b => b.repo === r.repo && b.number === r.parent)).map(r => ({ ...r, kind: 'pr' })),
  ];

  // @mentions since SINCE. They reach the user only as GitHub notification mail, which the run never reads; the
  // notifications API gives them directly, and a GET marks nothing read. Each carries the issue or PR itself - state,
  // assignees, whole body, latest comments - so the run can tell whose it is and whether the user already answered.
  let mentions = [];
  try {
    const notes = await github(`/notifications?participating=true&all=true&since=${encodeURIComponent(SINCE)}&per_page=50`);
    mentions = await Promise.all(notes.filter(n => n.reason === 'mention' || n.reason === 'team_mention').map(async n => {
      const m = { reason: n.reason, unread: n.unread, updated: n.updated_at, repo: n.repository.full_name, type: n.subject.type, title: n.subject.title,
        url: (n.subject.url || '').replace('api.github.com/repos', 'github.com').replace('/pulls/', '/pull/') };
      const api = (n.subject.url || '').replace('/pulls/', '/issues/');   // a PR is an issue too, for its body and comments
      const detail = api ? await github(api).catch(() => null) : null;
      const comments = api ? ((await github(`${api}/comments?per_page=100`).catch(() => [])) || []).slice(-20)
        .map(c => ({ by: c.user?.login, at: c.created_at, url: c.html_url, text: (c.body || '').slice(0, 2000) })) : [];
      const extra = detail ? { state: detail.state, assignees: (detail.assignees || []).map(a => a.login), author: detail.user?.login, body: (detail.body || '').slice(0, 20000) } : {};
      const last_by = comments.at(-1)?.by ?? extra.author ?? null;
      return { ...m, ...extra, comments, last_by, answered: last_by === me };
    }));
  } catch { /* mentions are extra: a failure here leaves the rest of GitHub standing */ }

  return { ok: true, review_requests, work, mentions };
}

// Azure DevOps (optional): the latest release of one pipeline. base_url is https://dev.azure.com/<org>/<project>
async function fromAdo(SINCE) {
  const { base_url, release_definition } = config.ado || {};
  if (!base_url || !release_definition) return { ok: true, skipped: true };
  const [, org, project] = base_url.match(/dev\.azure\.com\/([^/]+)\/([^/?#]+)/) || [];
  const rm = `https://vsrm.dev.azure.com/${org}/${project}/_apis/release/releases`;
  const list = await ado(`${rm}?definitionId=${release_definition}&$top=1&api-version=7.1`);
  const id = list.value?.[0]?.id;
  if (!id) return { ok: false, error: 'no release found' };
  const r = await ado(`${rm}/${id}?api-version=7.1`);
  return { ok: true, release: {
    name: r.name, created: r.createdOn, stages: (r.environments || []).map(e => ({ name: e.name, status: e.status })),
    url: `${base_url}/_releaseProgress?_a=release-pipeline-progress&releaseId=${id}`, is_new: r.createdOn >= SINCE } };
}

export async function fetchAll(SINCE) {
  const [gh, az] = await Promise.all([
    fromGithub(SINCE).catch(e => ({ ok: false, error: `${String(e.message || e).slice(0, 200)} - run \`gh auth status\`` })),
    fromAdo(SINCE).catch(e => ({ ok: false, error: `${String(e.message || e).slice(0, 200)} - run \`az login\`` })),
  ]);
  return { since: SINCE, github: gh, ado: az };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) console.log(JSON.stringify(await fetchAll(process.argv[2])));
