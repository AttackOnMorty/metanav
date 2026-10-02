#!/usr/bin/env node
// Meta-Nav's collector: reads Outlook (mail folders + today's calendar), Teams, and GitHub / Azure DevOps (github.mjs, ado.mjs,
// alongside the browser) in one go, with no model in the loop, and writes one JSON file for the run to judge (JUDGE.md, step 1).
//
// Usage: node collect.mjs <SINCE> <LOOKBACK> <first run: yes|no> <PREV run json, or ""> <out.json>
//
// Read-only: it reads list rows and the Teams cache, never opens a message, so nothing is marked read.
// The browser profile is the runs' own (named after the output dir); state.mjs's SIGN IN signs in on the same one.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
import { PROFILE, SENT, config } from '../lib/common.mjs';
import { adoStates, fromAdo } from './ado.mjs';
import { fromGithub, githubStates } from './github.mjs';
import { calendarEvents, drawnRows, isMeeting, meetingTime, pageLabels, rowTexts, rowTime, scrollList } from './outlook.mjs';
import { conversations, readCache } from './teams.mjs';

const [SINCE, LOOKBACK, FIRST, PREV, OUT] = process.argv.slice(2);

const t0 = Date.now();
const timings = {};
const timed = async (name, fn) => { const s = Date.now(); try { return await fn(); } finally { timings[name] = +((Date.now() - s) / 1000).toFixed(1); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// A list draws about one screen of rows, newest first: read on, scrolling, until past SINCE (an hourly run doesn't scroll)
async function readRows(page) {
  const rows = new Map(), since = Date.parse(SINCE);
  for (let i = 0; i < 60; i++) {
    for (const r of await page.evaluate(drawnRows)) if (!rows.has(r.convid)) rows.set(r.convid, r);
    const last = [...rows.values()].pop();
    if (!last || rowTime(last.time) < since) break;
    if (!await page.evaluate(scrollList, false)) break;
    await sleep(900);
  }
  return [...rows.values()];
}

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

// Each invite's own time, off the card Outlook draws under its row a few seconds after the list (isMeeting)
async function meetingTimes(page, ids) {
  await page.evaluate(scrollList, true);   // invites are recent: back to the top, where their rows are drawn
  const found = {};
  for (let i = 0; i < 12 && Object.keys(found).length < ids.length; i++) {
    for (const [id, text] of Object.entries(await page.evaluate(rowTexts, ids.filter(id => !found[id])))) {
      const m = meetingTime(text);
      if (m) found[id] = m;
    }
    if (Object.keys(found).length < ids.length) await sleep(1000);
  }
  return found;
}

async function readFolder(page, url) {
  if (!await open(page, url)) return null;
  await page.waitForSelector('[role=listbox] [role=option]', { timeout: 15000 }).catch(() => {});   // an empty folder has none
  // Outlook draws its own page first and only then goes to the sign-in page when the session has passed the
  // organisation's sign-in age - so look again once the list has had its chance, or that reads as an empty folder
  if (!await signedIn(page)) return null;
  await sleep(800);
  const rows = await readRows(page);
  const invites = rows.filter(isMeeting).map(r => r.convid);
  if (invites.length) {
    const times = await meetingTimes(page, invites);
    rows.forEach(r => { if (times[r.convid]) r.meeting = times[r.convid]; });
  }
  return rows;
}

async function outlook(page, prev) {
  const received = config.mail.received_folders;
  // each folder's link, for the run's mail links (only the Inbox opens a single mail)
  const mail = { signin_needed: false, folders: {}, urls: Object.fromEntries([...received.map(f => [f.name, f.url]), ['Sent', SENT]]), calendar: [] };
  for (const f of [...received, { name: 'Sent', url: SENT }]) {
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
    return calendarEvents(await page.evaluate(pageLabels));
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
  const raw = await timed('Teams extract', () => page.evaluate(readCache, Date.parse(LOOKBACK)));
  // a conversation silent since the last run has nothing to re-judge (on a first run, the whole lookback counts)
  return { signin_needed: false, conversations: conversations(raw, { since: SINCE, activeSince: FIRST === 'yes' ? LOOKBACK : SINCE, lookback: LOOKBACK, skip: config.teams.skip_chats }) };
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
// the code hosts alongside the browser; one that fails says how to fix it and leaves the other standing
const failed = (e, fix) => ({ ok: false, error: `${String(e.message || e).slice(0, 200)} - run \`${fix}\`` });
const fetching = timed('GitHub + Azure DevOps', async () => {
  const [github, ado] = await Promise.all([fromGithub(SINCE).catch(e => failed(e, 'gh auth status')), fromAdo(SINCE, LOOKBACK).catch(e => failed(e, 'az login'))]);
  return { github, ado };
});

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
// The current state of items the previous run points at (and, for GitHub PRs, links in mail and chats) that this
// run's lists don't carry, from each code host
const linked = [Object.values(out.mail.folders || {}).flat().map(r => r.label), (out.teams.conversations || []).flatMap(c => c.messages.map(m => m.text))];
Object.assign(out, await timed('GitHub states', () => githubStates(prev.urls, linked, out.github || {})));
if (out.ado?.ok && !out.ado.skipped) out.ado_states = await timed('ADO states', () => adoStates(prev.urls, out.ado));
timings.total = +((Date.now() - t0) / 1000).toFixed(1);
out.timings = timings;
writeFileSync(OUT, JSON.stringify(out));

// one short line for the run: what came in, and whether anything failed
const mailRows = Object.values(out.mail.folders || {}).reduce((n, r) => n + r.length, 0);
console.log(JSON.stringify({
  seconds: timings.total, mail_rows: mailRows, calendar: out.mail.calendar?.length ?? 0, teams_conversations: out.teams.conversations?.length ?? 0,
  pr_states: Object.keys(out.pr_states || {}).length, issue_states: Object.keys(out.issue_states || {}).length, github_ok: !!out.github?.ok, ado_ok: !!out.ado?.ok,
  ado_work: out.ado?.work?.length ?? 0, ado_reviews: out.ado?.review_requests?.length ?? 0, ado_mentions: out.ado?.mentions?.length ?? 0,
  outlook_signin_needed: !!out.mail.signin_needed, teams_signin_needed: !!out.teams.signin_needed,
  errors: [out.mail.error && `Outlook: ${out.mail.error}`, out.teams.error && `Teams: ${out.teams.error}`].filter(Boolean),
}));
