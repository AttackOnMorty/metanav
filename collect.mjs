#!/usr/bin/env node
// Meta-Nav's collector: reads Outlook (mail folders + today's calendar), Teams, and GitHub / Azure DevOps (fetch.sh, alongside
// the browser) in one go, with no model in the loop, and writes one JSON file for the run to judge (JUDGE.md, step 1).
//
// Usage: node collect.mjs <SINCE> <LOOKBACK> <first run: yes|no> <PREV run json, or ""> <out.json>
//
// Read-only: it reads list rows and the Teams cache, never opens a message, so nothing is marked read.
// The browser profile is the runs' own (named after the output dir); state.py's SIGN IN signs in on the same one.
import { chromium } from 'playwright-core';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const [SINCE, LOOKBACK, FIRST, PREV, OUT] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const outDir = config.output_dir.replace(/^~/, homedir());
const PROFILE = join(homedir(), 'Library/Caches/metanav', `chrome-${createHash('sha256').update(outDir).digest('hex').slice(0, 7)}`);
const BOTS = config.teams?.skip_chats ?? [];   // bot and reminder chats: not people

const t0 = Date.now();
const timings = {};
const timed = async (name, fn) => { const s = Date.now(); try { return await fn(); } finally { timings[name] = +((Date.now() - s) / 1000).toFixed(1); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A list draws about one screen of rows, newest first: read on, scrolling, until past SINCE (an hourly run doesn't scroll)
const ROWS = since => `(async () => {
  const SINCE = Date.parse('${since}');
  const lb = document.querySelector('[role=listbox]');
  if (!lb) return [];
  const sc = lb.querySelector('.customScrollBar') || lb;
  const when = t => { const m = t && t.match(/(\\d+)\\/(\\d+)\\/(\\d{4}) (\\d+):(\\d+) ([AP]M)/); return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4] % 12 + (m[6] === 'PM' ? 12 : 0), +m[5]).getTime() : NaN; };
  const rows = new Map();
  for (let i = 0; i < 60; i++) {
    for (const o of lb.querySelectorAll('[role=option]')) {
      const convid = o.getAttribute('data-convid');
      if (!convid || rows.has(convid)) continue;
      rows.set(convid, { convid, label: o.getAttribute('aria-label')?.slice(0, 400),
        unread: /^Unread/.test(o.getAttribute('aria-label') || '') || !!o.querySelector('button[aria-label="Mark as read"]'),
        time: o.querySelector('[title*="/20"]')?.getAttribute('title') });
    }
    const last = [...rows.values()].pop();
    if (!last || when(last.time) < SINCE) break;
    const top = sc.scrollTop;
    sc.scrollTop += sc.clientHeight * 0.8;
    await new Promise(r => setTimeout(r, 900));
    if (sc.scrollTop === top) break;
  }
  return [...rows.values()];
})()`;
const CALENDAR = `[...new Set([...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label'))
  .filter(l => /(\\d{1,2}:\\d{2} [AP]M to \\d{1,2}:\\d{2} [AP]M|all day)/i.test(l) && !/^\\d{1,2}:\\d{2}/.test(l) && !/\\d+ events?,/.test(l)))]`;

// After a quiet spell Outlook and Teams pass through Microsoft's sign-in page to renew the session and come straight back.
// Give it 20 seconds; still there means a real sign-in is needed.
async function signedIn(page) {
  for (let i = 0; i < 20 && /login\.microsoftonline\.com/.test(page.url()); i++) await sleep(1000);
  return !/login\.microsoftonline\.com/.test(page.url());
}

async function open(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  return signedIn(page);
}

// A meeting request's own time ("Thu 8/10/2026 5:30 PM - 8:00 PM") is on a card under its row, which Outlook draws
// several seconds after the list. The row's `time` is only when the invite arrived.
const MEETING_TIME = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}\/\d{1,2}\/\d{4}(?: \d{1,2}:\d{2} [AP]M(?: - \d{1,2}:\d{2} [AP]M)?| \(all day\))?/;
const isMeeting = r => /^(?:\S+ ){0,3}Meeting /.test(r.label || '');

async function meetingTimes(page, ids) {
  return page.evaluate(async ({ ids, re }) => {
    const rx = new RegExp(re), found = {};
    const sc = document.querySelector('[role=listbox] .customScrollBar') || document.querySelector('[role=listbox]');
    if (sc) sc.scrollTop = 0;   // invites are recent: back to the top, where their rows are drawn
    for (let i = 0; i < 12 && Object.keys(found).length < ids.length; i++) {
      for (const id of ids) {
        const o = document.querySelector(`[role=option][data-convid="${CSS.escape(id)}"]`);
        const m = o && o.innerText.match(rx);
        if (m) found[id] = m[0];
      }
      if (Object.keys(found).length < ids.length) await new Promise(r => setTimeout(r, 1000));
    }
    return found;
  }, { ids, re: MEETING_TIME.source });
}

async function readFolder(page, url) {
  if (!await open(page, url)) return null;
  await page.waitForSelector('[role=listbox] [role=option]', { timeout: 15000 }).catch(() => {});   // an empty folder has none
  // Outlook draws its own page first and only then goes to the sign-in page when the session has passed the
  // organisation's sign-in age - so look again once the list has had its chance, or that reads as an empty folder
  if (!await signedIn(page)) return null;
  await sleep(800);
  const rows = await page.evaluate(ROWS(SINCE));
  const invites = rows.filter(isMeeting).map(r => r.convid);
  if (invites.length) {
    const times = await meetingTimes(page, invites);
    rows.forEach(r => { if (times[r.convid]) r.meeting = times[r.convid]; });
  }
  return rows;
}

async function outlook(page, prev) {
  const mail = { signin_needed: false, folders: {}, calendar: [] };
  const received = config.mail.received_folders;
  for (const f of [...received, { name: 'Sent', url: config.mail.sent }]) {
    const rows = await timed(`Outlook ${f.name}`, () => readFolder(page, f.url));
    if (rows === null) { mail.signin_needed = true; return mail; }
    mail.folders[f.name] = rows;
  }
  // A received item from the last run that's missing may be deleted - or the list came back short. Read the received
  // folders once more before the run believes it; a row seen in either read counts as there.
  const seen = new Set(Object.values(mail.folders).flat().map(r => r.convid));
  const missing = (prev.mail_ids || []).filter(id => !seen.has(id));
  if (missing.length) {
    await sleep(5000);
    for (const f of received) {
      const again = await timed(`Outlook ${f.name} (2nd read)`, () => readFolder(page, f.url)) || [];
      const have = new Set(mail.folders[f.name].map(r => r.convid));
      mail.folders[f.name].push(...again.filter(r => !have.has(r.convid)));
    }
  }
  mail.calendar = await timed('Outlook calendar', async () => {
    if (!await open(page, 'https://outlook.office.com/calendar/view/day')) return [];
    await page.waitForFunction(() => [...document.querySelectorAll('[aria-label]')]
      .some(e => / to \d{1,2}:\d{2} [AP]M|all day/i.test(e.getAttribute('aria-label') || '')), null, { timeout: 8000 }).catch(() => {});
    if (!await signedIn(page)) { mail.signin_needed = true; return []; }   // as for the folders
    return page.evaluate(CALENDAR);
  });
  return mail;
}

async function teams(page) {
  if (!await timed('Teams open', () => open(page, 'https://teams.microsoft.com/v2/'))) return { signin_needed: true, conversations: [] };
  // Teams catches its local cache up in batches after it opens. Wait until the newest message stops changing for
  // 6 seconds (40 at most): a fixed wait is either slower than needed or, after a long gap, too short.
  const newest = () => page.evaluate(async () => {
    const d = (await indexedDB.databases()).find(x => /^Teams:replychain-manager:/.test(x.name));
    if (!d) return 0;
    const db = await new Promise((res, rej) => { const q = indexedDB.open(d.name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    if (!db.objectStoreNames.contains('replychains-2')) { db.close(); return 0; }
    const all = await new Promise(res => { const q = db.transaction('replychains-2', 'readonly').objectStore('replychains-2').getAll(); q.onsuccess = () => res(q.result); });
    db.close();
    return Math.max(0, ...all.map(r => r.latestDeliveryTime || 0));
  }).catch(() => 0);
  await timed('Teams cache', async () => {
    const start = Date.now();
    let last = 0, since = Date.now();
    while (Date.now() - start < 40000) {
      const n = await newest();
      if (n !== last) { last = n; since = Date.now(); } else if (n && Date.now() - since >= 6000) break;
      await sleep(1000);
    }
  });
  if (!await signedIn(page)) return { signin_needed: true, conversations: [] };   // Teams too can go to sign-in after it opens
  const extract = readFileSync(join(HERE, 'teams-extract.js'), 'utf8')
    .replace('__SINCE__', SINCE).replace('__ACTIVE_SINCE__', FIRST === 'yes' ? LOOKBACK : SINCE).replace('__LOOKBACK__', LOOKBACK);
  const data = await timed('Teams extract', () => page.evaluate(`(${extract})()`));
  return { signin_needed: false, conversations: data.conversations.filter(c => !BOTS.includes(c.name)) };
}

// Current state of every PR the inputs point at - carried-over items, links in chats and mail - so the run
// needn't query GitHub item by item. One GraphQL call.
async function prStates(prev, mail, teamsData, github) {
  const known = new Set([...(github.review_requests || []), ...(github.work || []).flatMap(w => [w, ...(w.prs || [])])].map(p => p.url));
  const text = JSON.stringify([prev.urls, Object.values(mail.folders || {}).flat().map(r => r.label),
    (teamsData.conversations || []).flatMap(c => c.messages.map(m => m.text))]);
  const urls = [...new Set(text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g) || [])].filter(u => !known.has(u)).slice(0, 40);
  if (!urls.length) return {};
  const parts = urls.map((u, i) => {
    const [, owner, repo, n] = u.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    return `p${i}: repository(owner: "${owner}", name: "${repo}") { pullRequest(number: ${n}) { title state isDraft reviewDecision mergedAt closedAt updatedAt author { login } latestReviews(first: 10) { nodes { author { login } state submittedAt } } } }`;
  });
  try {
    const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=query { ${parts.join('\n')} }`], { maxBuffer: 1 << 24 });
    const data = JSON.parse(stdout).data || {};
    return Object.fromEntries(urls.map((u, i) => [u, data[`p${i}`]?.pullRequest ?? null]));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

// Issues carried over from the last run (a mention, an ask filed as an issue): their state now, who they're assigned
// to, and what they say, so the run can re-judge whose they are even when nothing new came in about them. One call.
async function issueStates(prev, github) {
  const known = new Set([...(github.work || []).map(w => w.url), ...(github.mentions || []).map(m => m.url)]);
  const urls = [...new Set(JSON.stringify(prev.urls).match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/g) || [])]
    .filter(u => !known.has(u)).slice(0, 30);
  if (!urls.length) return {};
  const parts = urls.map((u, i) => {
    const [, owner, repo, n] = u.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/);
    return `i${i}: repository(owner: "${owner}", name: "${repo}") { issue(number: ${n}) { title state body assignees(first: 5) { nodes { login } } comments(last: 20) { nodes { url author { login } createdAt body } } } }`;
  });
  try {
    const { stdout } = await run('gh', ['api', 'graphql', '-f', `query=query { ${parts.join('\n')} }`], { maxBuffer: 1 << 24 });
    const data = JSON.parse(stdout).data || {};
    return Object.fromEntries(urls.map((u, i) => {
      const x = data[`i${i}`]?.issue;
      return [u, x ? { title: x.title, state: x.state, assignees: x.assignees.nodes.map(a => a.login), body: (x.body || '').slice(0, 20000),
        comments: x.comments.nodes.map(c => ({ by: c.author?.login, at: c.createdAt, url: c.url, text: (c.body || '').slice(0, 2000) })) } : null];
    }));
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

function fromPrev(file) {
  if (!file) return { mail_ids: [], urls: [] };
  try {
    const p = JSON.parse(readFileSync(file, 'utf8'));
    const items = ['queue', 'waiting', 'highlights'].flatMap(s => p[s] || []);
    return {
      // received mail only: Sent loops don't close by deletion (JUDGE.md, 3a)
      mail_ids: items.filter(x => x.source === 'mail' && !/sentitems/.test(x.url || '')).map(x => x.id).filter(Boolean),
      urls: items.flatMap(x => [x.url, ...(x.actions || []).map(a => a.url)]).filter(Boolean),
    };
  } catch { return { mail_ids: [], urls: [] }; }
}

const prev = fromPrev(PREV);
const fetching = timed('GitHub + Azure DevOps', () => run(join(HERE, 'fetch.sh'), [SINCE], { maxBuffer: 1 << 24 })
  .then(r => JSON.parse(r.stdout)).catch(e => ({ github: { ok: false, error: String(e.message || e).slice(0, 200) }, ado: { ok: false } })));

const out = { collected_at: new Date().toISOString(), since: SINCE, lookback: LOOKBACK, first_run: FIRST === 'yes' };
let context;
try {
  context = await timed('browser start', () => chromium.launchPersistentContext(PROFILE, { channel: 'chrome', headless: true }));
  const page = context.pages()[0] || await context.newPage();
  out.mail = await outlook(page, prev).catch(e => ({ error: String(e.message || e).slice(0, 200) }));
  out.teams = await teams(page).catch(e => ({ error: String(e.message || e).slice(0, 200) }));
} catch (e) {
  out.mail = out.mail || { error: String(e.message || e).slice(0, 200) };
  out.teams = out.teams || { error: String(e.message || e).slice(0, 200) };
} finally {
  await context?.close().catch(() => {});
}
const fetched = await fetching;
out.github = fetched.github;
out.ado = fetched.ado;
out.pr_states = await timed('PR states', () => prStates(prev, out.mail, out.teams, out.github || {}));
out.issue_states = await timed('issue states', () => issueStates(prev, out.github || {}));
timings.total = +((Date.now() - t0) / 1000).toFixed(1);
out.timings = timings;
writeFileSync(OUT, JSON.stringify(out));

// one short line for the run: what came in, and whether anything failed
const mailRows = Object.values(out.mail.folders || {}).reduce((n, r) => n + r.length, 0);
console.log(JSON.stringify({
  seconds: timings.total, mail_rows: mailRows, calendar: out.mail.calendar?.length ?? 0, teams_conversations: out.teams.conversations?.length ?? 0,
  pr_states: Object.keys(out.pr_states || {}).length, issue_states: Object.keys(out.issue_states || {}).length, github_ok: !!out.github?.ok, ado_ok: !!out.ado?.ok,
  outlook_signin_needed: !!out.mail.signin_needed, teams_signin_needed: !!out.teams.signin_needed,
  errors: [out.mail.error && `Outlook: ${out.mail.error}`, out.teams.error && `Teams: ${out.teams.error}`].filter(Boolean),
}));
