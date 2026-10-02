// The code hosts, GitHub (fetch.mjs) and Azure DevOps (ado.mjs), read into one shape for the judge (JUDGE.md step 2):
//   work             the user's PBIs / work items under way, each with its PRs nested ({kind: "pbi", prs}), then their
//                    PRs with none ({kind: "pr"})
//   review_requests  others' PRs waiting on the user's review; `rereview`: the author came back to it after the
//                    user's last review
//   mentions         where someone @mentioned the user
// Each adapter fetches; what its answer means is decided here, without the network, so it can be tested.

export const BODY = 20000, COMMENT = 2000;   // caps against pasted logs, not against reading
export const comment = c => ({ by: c.by, at: c.at, url: c.url, text: String(c.text || '').slice(0, COMMENT) });
export const daysSince = (t, now = Date.now()) => Math.floor((now - Date.parse(t)) / 864e5);
const max = xs => xs.filter(Boolean).sort().pop() ?? null;

// Feedback on the user's own PR counts only if it came after both the window start and their own last reply:
// newest last, so .at(-1) is the one to open. Items: { by_me, at }.
export function freshFeedback(items, since) {
  const after = max([since, ...items.filter(f => f.by_me).map(f => f.at)]);
  return items.filter(f => !f.by_me && f.at > after).sort((a, b) => a.at.localeCompare(b.at));
}

// The links in `text` (the previous run's items, mail, chats) to items a host looks up one by one, so the run can tell
// a merged or closed one from one still open: those matching `pattern` (a /g regex), each once, minus the ones the
// host's own lists already carry, at most `cap` of them
export const carriedOver = (text, pattern, known, cap) =>
  [...new Set(String(text).match(pattern) || [])].filter(u => !known.includes(u)).slice(0, cap);

// "My work": one row per PBI with its PRs nested; PRs that belong to none of them sit flat
export function workTree(pbis, prs, belongs) {
  return [
    ...pbis.map(b => ({ ...b, kind: 'pbi', prs: prs.filter(r => belongs(r, b)) })),
    ...prs.filter(r => !pbis.some(b => belongs(r, b))).map(r => ({ ...r, kind: 'pr' })),
  ];
}

// ---- GitHub: the GraphQL answer fetch.mjs asks for (me, review, mine, issues) -> work and review_requests

// drop a size prefix, e.g. "XL⚠️ ◾ feat: ..." -> "feat: ..."
const clean = s => (s || '').replace(/^[^◾]{0,8}◾\s*/u, '');
// a sprint runs from its start for `duration` days: current when start <= today < end
const sprintEnd = sp => new Date(Date.parse(`${sp.startDate}T00:00:00Z`) + sp.duration * 864e5).toISOString().slice(0, 10);
const current = (sp, today) => !!sp && sp.startDate <= today && sprintEnd(sp) > today;

export function githubLists(d, { since, today, now = Date.now() }) {
  const me = d.me.login;
  const nodes = x => (x?.nodes || []).filter(Boolean);

  // Each PR resolved to its parent PBI, in trust order: GitHub's closing reference, a "1234-" branch prefix, then a
  // line-anchored "Part of / Fixes #N". A bare "#N" in prose is never used - it is usually incidental discussion.
  const prs = nodes(d.mine).map(p => {
    const fb = [...nodes(p.comments), ...nodes(p.reviews)].filter(f => f.author?.__typename === 'User' || f.author?.login === me)
      .map(f => ({ by_me: f.author?.login === me, at: f.createdAt, url: f.url }));
    const fresh = freshFeedback(fb, since);
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
      // what it says: the whole body and its comments
      assignees: nodes(i.assignees).map(a => a.login), body: (i.body || '').slice(0, BODY),
      comments: nodes(i.comments).map(c => comment({ by: c.author?.login, at: c.createdAt, url: c.url, text: c.body })),
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
      since, waiting_days: daysSince(since, now),
    };
  });

  return { review_requests, work: workTree(pbis, prs, (r, b) => r.repo === b.repo && r.parent === b.number) };
}

// ---- Azure DevOps: what ado.mjs reads, decided here

// My PR's review, from the other reviewers' votes (10 approved, 5 approved with suggestions, -5 waiting for the author,
// -10 rejected). Approved: every required reviewer approved - or, with none required, someone approved and nobody objects.
export function adoReview(votes) {
  if (votes.some(r => r.vote === -10)) return 'CHANGES_REQUESTED';
  if (votes.some(r => r.vote === -5)) return 'WAITING_FOR_AUTHOR';
  const required = votes.filter(r => r.isRequired);
  return (required.length ? required.every(r => r.vote >= 5) : votes.some(r => r.vote >= 5)) ? 'APPROVED' : 'PENDING';
}

// My PR's CI, from its build checks' statuses
export const adoCi = checks => checks.includes('rejected') ? 'FAILURE' : checks.some(s => s === 'running' || s === 'queued') ? 'PENDING'
  : checks.length ? 'SUCCESS' : 'NONE';

// Whether a PR I'm a reviewer on waits on me, and since when: not once I approved. A PR I voted down is the author's
// move - until they push again after my last word, which makes it a re-review. `myLast` and `pushed` matter only then.
export function adoReviewWait({ vote, created, myLast, pushed }) {
  if (vote >= 5) return null;
  if (vote >= 0) return { since: created, rereview: false };
  return pushed && (!myLast || pushed > myLast) ? { since: pushed, rereview: true } : null;
}
