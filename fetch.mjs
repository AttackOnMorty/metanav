// GitHub + Azure DevOps state for Meta-Nav. Deterministic, no judgement: the GitHub adapter (fetched here, read into
// codehost.mjs's shape) and, through ado.mjs, Azure DevOps.
// Usage: node fetch.mjs <SINCE> [LOOKBACK]   (ISO 8601 UTC) -> prints one JSON object; collect.mjs imports fetchAll instead
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromAdo } from './ado.mjs';
import { BODY, carriedOver, comment, githubLists } from './codehost.mjs';
import { config, github, graphql } from './common.mjs';

const pad = n => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

async function fromGithub(SINCE) {
  const owner = config.github.org;
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
  const me = d.me.login;
  const lists = githubLists(d, { since: SINCE, today: localDay() });

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
        .map(c => comment({ by: c.user?.login, at: c.created_at, url: c.html_url, text: c.body })) : [];
      const extra = detail ? { state: detail.state, assignees: (detail.assignees || []).map(a => a.login), author: detail.user?.login, body: (detail.body || '').slice(0, BODY) } : {};
      const last_by = comments.at(-1)?.by ?? extra.author ?? null;
      return { ...m, ...extra, comments, last_by, answered: last_by === me };
    }));
  } catch { /* mentions are extra: a failure here leaves the rest of GitHub standing */ }

  return { ok: true, ...lists, mentions };
}

export async function fetchAll(SINCE, LOOKBACK) {
  const [gh, az] = await Promise.all([
    fromGithub(SINCE).catch(e => ({ ok: false, error: `${String(e.message || e).slice(0, 200)} - run \`gh auth status\`` })),
    fromAdo(SINCE, LOOKBACK).catch(e => ({ ok: false, error: `${String(e.message || e).slice(0, 200)} - run \`az login\`` })),
  ]);
  return { since: SINCE, github: gh, ado: az };
}

// GitHub PRs and issues the run points at that this run's lists don't carry - the previous run's items (`carried`, its
// links), and for PRs also links in mail and chats (`linked`, text) - with their state now, so the run needn't look
// them up one by one and can re-judge whose an issue is when nothing new came in about it. One GraphQL call each.
export async function githubStates(carried, linked, gh) {
  const prsKnown = [...(gh.review_requests || []), ...(gh.work || []).flatMap(w => [w, ...(w.prs || [])])].map(p => p.url);
  const issuesKnown = [...(gh.work || []).map(w => w.url), ...(gh.mentions || []).map(m => m.url)];
  const prs = carriedOver(JSON.stringify([carried, linked]), /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g, prsKnown, 40);
  const issues = carriedOver(JSON.stringify(carried), /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/g, issuesKnown, 30);
  const lookup = async (urls, field, ask, shape) => {
    if (!urls.length) return {};
    const parts = urls.map((u, i) => {
      const [, owner, repo, n] = u.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/);
      return `x${i}: repository(owner: "${owner}", name: "${repo}") { ${field}(number: ${n}) { ${ask} } }`;
    });
    try {
      const data = await graphql(`query { ${parts.join('\n')} }`);
      return Object.fromEntries(urls.map((u, i) => [u, data[`x${i}`]?.[field] ? shape(data[`x${i}`][field]) : null]));
    } catch (e) {
      return { error: String(e.message || e).slice(0, 200) };
    }
  };
  return {
    pr_states: await lookup(prs, 'pullRequest', 'title state isDraft reviewDecision mergedAt closedAt updatedAt author { login } latestReviews(first: 10) { nodes { author { login } state submittedAt } }', x => x),
    issue_states: await lookup(issues, 'issue', 'title state body assignees(first: 5) { nodes { login } } comments(last: 20) { nodes { url author { login } createdAt body } }',
      x => ({ title: x.title, state: x.state, assignees: x.assignees.nodes.map(a => a.login), body: (x.body || '').slice(0, BODY),
        comments: x.comments.nodes.map(c => comment({ by: c.author?.login, at: c.createdAt, url: c.url, text: c.body })) })),
  };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) console.log(JSON.stringify(await fetchAll(process.argv[2], process.argv[3] || process.argv[2])));
