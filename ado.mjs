// Azure DevOps for Meta-Nav, read the way GitHub is: the work assigned to you that's under way, pull requests waiting
// on your review, your own pull requests' next step, and where someone @mentioned you - in each organisation listed in
// config.azure_devops.orgs. Deterministic, no judgement; the shapes match GitHub's.
import { ado, config } from './common.mjs';

const V = 'api-version=7.1';
const text = html => String(html || '').replace(/<br\s*\/?>|<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const daysSince = t => Math.floor((Date.now() - Date.parse(t)) / 864e5);
const name = u => u?.displayName?.replace(/\s*\[[^\]]*\]$/, '') || null;   // "Sam Lee [Acme]" -> "Sam Lee"

export async function fromAdo(SINCE, LOOKBACK) {
  // one that can't be read doesn't hold up the others
  const orgs = config.azure_devops.orgs;
  if (!orgs.length) return { ok: true, skipped: true };
  const out = { ok: true, me: null, orgs: [], review_requests: [], work: [], mentions: [], errors: [] };
  for (const ORG of orgs) {
    try {
      const r = await fromOrg(ORG, SINCE, LOOKBACK);
      out.orgs.push(ORG);
      out.me ??= r.me;
      for (const k of ['review_requests', 'work', 'mentions']) out[k].push(...r[k]);
    } catch (e) { out.errors.push(`${ORG}: ${String(e.message || e).slice(0, 200)}`); }
  }
  if (!out.orgs.length) throw new Error(out.errors[0]);
  if (!out.errors.length) delete out.errors;
  return out;
}

async function fromOrg(ORG, SINCE, LOOKBACK) {
  const me = (await ado(`${ORG}/_apis/connectionData?api-version=7.1-preview`)).authenticatedUser;
  const isMe = u => u && (u.id === me.id || u.uniqueName === me.properties?.Account?.$value);
  const wiql = async q => ((await ado(`${ORG}/_apis/wit/wiql?${V}`, { query: q })).workItems || []).map(w => w.id);
  const items = async ids => {
    const out = [];
    for (let i = 0; i < ids.length; i += 200) out.push(...(await ado(`${ORG}/_apis/wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&${V}`)).value);
    return out;
  };
  const f = (w, k) => w.fields[`System.${k}`];
  const wiUrl = w => `${ORG}/${encodeURIComponent(f(w, 'TeamProject'))}/_workitems/edit/${w.id}`;
  const comments = async w => ((await ado(`${ORG}/${encodeURIComponent(f(w, 'TeamProject'))}/_apis/wit/workItems/${w.id}/comments?$top=200&api-version=7.1-preview.4`)).comments || [])
    .sort((a, b) => a.createdDate.localeCompare(b.createdDate)).slice(-20)
    .map(c => ({ by: name(c.createdBy), me: isMe(c.createdBy), at: c.createdDate, url: wiUrl(w), text: text(c.text).slice(0, 2000) }));

  // Each project's states and what they mean (Proposed / InProgress / Resolved / Completed / Removed), and each sprint's dates
  const stateCats = {}, sprints = {};
  const category = async (project, type, state) => {
    stateCats[project] ??= ado(`${ORG}/${encodeURIComponent(project)}/_apis/wit/workitemtypes?${V}`)
      .then(r => Object.fromEntries(r.value.map(t => [t.name, Object.fromEntries((t.states || []).map(s => [s.name, s.category]))])));
    return (await stateCats[project])[type]?.[state] || 'InProgress';
  };
  const sprint = async (project, path) => {
    const rest = path.split('\\').slice(1).map(encodeURIComponent).join('/');
    if (!rest) return null;   // the project root: no sprint
    sprints[path] ??= ado(`${ORG}/${encodeURIComponent(project)}/_apis/wit/classificationnodes/Iterations/${rest}?${V}`)
      .then(r => r.attributes || null).catch(() => null);
    return sprints[path];
  };
  const today = new Date().toISOString().slice(0, 10);

  // Work under way: assigned to you, not finished, and in a sprint running now - or in progress and touched within the
  // lookback (an "Active" task nobody has touched for years isn't work under way)
  const assigned = await items(await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Done', 'Closed', 'Removed')`));
  const pbis = [];
  for (const w of assigned) {
    const cat = await category(f(w, 'TeamProject'), f(w, 'WorkItemType'), f(w, 'State'));
    if (cat === 'Completed' || cat === 'Removed') continue;
    const sp = await sprint(f(w, 'TeamProject'), f(w, 'IterationPath'));
    const current = !!sp?.startDate && sp.startDate.slice(0, 10) <= today && sp.finishDate?.slice(0, 10) >= today;
    if (!current && !(cat !== 'Proposed' && f(w, 'ChangedDate') >= LOOKBACK)) continue;
    // when it became yours: the last time it was assigned to you, else when it was created
    const updates = (await ado(`${ORG}/_apis/wit/workItems/${w.id}/updates?$top=200&${V}`).catch(() => ({ value: [] }))).value;
    const assignedAt = updates.filter(u => isMe(u.fields?.['System.AssignedTo']?.newValue)).at(-1)?.fields?.['System.ChangedDate']?.newValue;
    pbis.push({
      repo: f(w, 'TeamProject'), number: w.id, title: f(w, 'Title'), url: wiUrl(w), type: f(w, 'WorkItemType'),
      since: assignedAt || f(w, 'CreatedDate'),
      assignees: [name(f(w, 'AssignedTo'))].filter(Boolean), body: text(f(w, 'Description')).slice(0, 20000),
      comments: await comments(w),
      status: f(w, 'State'), sprint: current ? f(w, 'IterationPath').split('\\').pop() : '-',
      sprint_end: current ? sp.finishDate.slice(0, 10) : null,
    });
  }

  // Pull requests, org-wide. A PR's web page, its discussion threads, its build checks and the work items it's linked to.
  const prUrl = p => `${ORG}/${encodeURIComponent(p.repository.project.name)}/_git/${encodeURIComponent(p.repository.name)}/pullrequest/${p.pullRequestId}`;
  const prApi = p => `${ORG}/${encodeURIComponent(p.repository.project.name)}/_apis/git/repositories/${p.repository.id}/pullRequests/${p.pullRequestId}`;
  const prList = q => ado(`${ORG}/_apis/git/pullrequests?${q}&searchCriteria.status=active&$top=100&${V}`).then(r => r.value || []);
  const threads = async p => ((await ado(`${prApi(p)}/threads?${V}`)).value || []).filter(t => !t.isDeleted)
    .map(t => ({ ...t, comments: (t.comments || []).filter(c => c.commentType !== 'system' && !c.isDeleted) })).filter(t => t.comments.length);
  const lastPush = async p => ((await ado(`${prApi(p)}/iterations?${V}`)).value || []).map(i => i.createdDate).sort().pop();
  const files = async p => {
    const its = (await ado(`${prApi(p)}/iterations?${V}`)).value || [];
    if (!its.length) return null;
    return ((await ado(`${prApi(p)}/iterations/${its.at(-1).id}/changes?$top=2000&${V}`)).changeEntries || []).length;
  };

  const mine = [];
  for (const p of await prList(`searchCriteria.creatorId=${me.id}`)) {
    const ts = await threads(p);
    const all = ts.flatMap(t => t.comments.map(c => ({ ...c, thread: t.id })));
    // feedback counts only if it came after both the window start and my own last reply
    const after = [SINCE, ...all.filter(c => isMe(c.author)).map(c => c.publishedDate)].sort().pop();
    const fresh = all.filter(c => !isMe(c.author) && c.publishedDate > after).sort((a, b) => a.publishedDate.localeCompare(b.publishedDate));
    const votes = (p.reviewers || []).filter(r => !isMe(r));
    const checks = await ado(`${ORG}/${encodeURIComponent(p.repository.project.name)}/_apis/policy/evaluations?artifactId=${encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${p.repository.project.id}/${p.pullRequestId}`)}&api-version=7.1-preview.1`)
      .then(r => (r.value || []).filter(e => /build/i.test(e.configuration?.type?.displayName || '')).map(e => e.status)).catch(() => []);
    const linked = await ado(`${prApi(p)}/workitems?${V}`).then(r => r.value || []).catch(() => []);
    mine.push({
      repo: `${p.repository.project.name}/${p.repository.name}`, number: p.pullRequestId, title: p.title, url: prUrl(p), draft: !!p.isDraft, since: p.creationDate,
      size: { files: await files(p).catch(() => null) },
      // approved: every required reviewer approved - or, with none required, someone approved and nobody objects
      review: votes.some(r => r.vote === -10) ? 'CHANGES_REQUESTED' : votes.some(r => r.vote === -5) ? 'WAITING_FOR_AUTHOR'
        : (votes.some(r => r.isRequired) ? votes.filter(r => r.isRequired).every(r => r.vote >= 5) : votes.some(r => r.vote >= 5)) ? 'APPROVED' : 'PENDING',
      merge: p.mergeStatus,   // "conflicts" means it can't merge as it is
      ci: checks.includes('rejected') ? 'FAILURE' : checks.some(s => s === 'running' || s === 'queued') ? 'PENDING' : checks.length ? 'SUCCESS' : 'NONE',
      unresolved_threads: ts.filter(t => t.status === 'active').length,
      new_feedback: fresh.length,
      latest_feedback_url: fresh.length ? `${prUrl(p)}?discussionId=${fresh.at(-1).thread}` : null,
      // its work item, as the PR itself links it - no guessing from the title or the branch
      parent: linked.length ? +linked[0].id : null,
    });
  }

  // Waiting on your review: you're a reviewer, you haven't approved, and it isn't your own. A PR you voted down is the
  // author's move - until they push again after your last word, which makes it a re-review.
  const review_requests = [];
  for (const p of await prList(`searchCriteria.reviewerId=${me.id}`)) {
    if (isMe(p.createdBy)) continue;
    const vote = (p.reviewers || []).find(isMe)?.vote ?? 0;
    if (vote >= 5) continue;
    const myLast = vote < 0 ? (await threads(p)).flatMap(t => t.comments).filter(c => isMe(c.author)).map(c => c.publishedDate).sort().pop() : null;
    const pushed = vote < 0 ? await lastPush(p) : null;
    if (vote < 0 && !(pushed && (!myLast || pushed > myLast))) continue;
    const since = vote < 0 ? pushed : p.creationDate;
    review_requests.push({
      repo: `${p.repository.project.name}/${p.repository.name}`, number: p.pullRequestId, title: p.title, url: prUrl(p), author: name(p.createdBy),
      draft: !!p.isDraft, rereview: vote < 0, size: { files: await files(p).catch(() => null) }, since, waiting_days: daysSince(since),
    });
  }

  // "My work": one row per work item with its PRs nested; PRs linked to none of them sit flat
  const work = [
    ...pbis.map(b => ({ ...b, kind: 'pbi', prs: mine.filter(r => r.parent === b.number) })),
    ...mine.filter(r => !pbis.some(b => b.number === r.parent)).map(r => ({ ...r, kind: 'pr' })),
  ];

  // @mentions in work item discussions since SINCE (@RecentMentions: the last 30 days). Mentions in PR comments come
  // as notification mail.
  const mentioned = await items(await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (@RecentMentions) AND [System.ChangedDate] >= '${SINCE.slice(0, 10)}'`));
  const mentions = [];
  for (const w of mentioned) {
    const cs = await comments(w);
    const last = cs.at(-1);
    mentions.push({
      repo: f(w, 'TeamProject'), type: f(w, 'WorkItemType'), title: f(w, 'Title'), url: wiUrl(w), updated: f(w, 'ChangedDate'),
      state: f(w, 'State'), assignees: [name(f(w, 'AssignedTo'))].filter(Boolean), author: name(f(w, 'CreatedBy')),
      body: text(f(w, 'Description')).slice(0, 20000), comments: cs.map(({ me: _, ...c }) => c),
      last_by: last?.by ?? name(f(w, 'CreatedBy')), answered: !!last?.me,
    });
  }
  pbis.forEach(b => b.comments.forEach(c => delete c.me));
  return { me: me.providerDisplayName || null, review_requests, work, mentions };
}

// Current state of Azure DevOps work items and PRs a carried-over item points at, by URL - so the run can tell a merged
// or closed one from one still open when nothing new came in about it
export async function adoStates(urls) {
  const out = {};
  for (const u of urls) {
    const wi = u.match(/^(https:\/\/dev\.azure\.com\/[^/]+)\/[^/]+\/_workitems\/edit\/(\d+)/);
    const pr = u.match(/^(https:\/\/dev\.azure\.com\/[^/]+)\/([^/]+)\/_git\/[^/]+\/pullrequest\/(\d+)/);
    try {
      if (wi) {
        const w = await ado(`${wi[1]}/_apis/wit/workitems/${wi[2]}?${V}`);
        out[u] = { title: w.fields['System.Title'], state: w.fields['System.State'], assignees: [name(w.fields['System.AssignedTo'])].filter(Boolean) };
      } else if (pr) {
        const p = await ado(`${pr[1]}/${pr[2]}/_apis/git/pullrequests/${pr[3]}?${V}`);
        out[u] = { title: p.title, state: p.status, isDraft: !!p.isDraft, closedAt: p.closedDate || null, author: name(p.createdBy),
          votes: (p.reviewers || []).map(r => ({ by: name(r), vote: r.vote })) };
      }
    } catch { out[u] = null; }
  }
  return out;
}
