// Meta-Nav's background service, started at login by launchd (macOS) or Task Scheduler (Windows):
// - the scheduled runs: it starts run.mjs every config.schedule.every_minutes (run.mjs itself keeps to weekdays within
//   its hours);
// - the click store: the panel's "done", "resolved" and "Got it" clicks, and the user's tactics, kept in one file that
//   every browser and every run share. A page opened from disk can read files beside it but can't write any, so this
//   service writes for it.
// It listens on 127.0.0.1 only.
//   POST /state   {"key": "tower:dismissed" | "tower:read" | "metanav:tactics", "value": {...}}   -> the whole state, as JSON
//   POST /signin  {"source": "Azure DevOps" | "Outlook" | "Teams"}          -> {"status": "started" | "busy"}
//                 The banner's SIGN IN button: a window to sign in, then a refresh.
//   POST /refresh {} | {"queue": true}                                       -> {"status": "started" | "busy" | "queued"}
//                 The panel's SYNC NOW button: a run now, whatever the hour (busy if one is running, or a sign-in window is open).
//                 With "queue" (saving tactics), a busy service starts the run as soon as it can instead.
// Writes <output dir>/state.json (read by each run, JUDGE.md step 5) and state.js (the same, for the page's <script> tag).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { OUT, PROFILE, SCHEDULE, SKILL, chromePath, tool } from './common.mjs';
import { busy, slotOf } from './gate.mjs';

const PORT = 47615;
const KEYS = ['tower:dismissed', 'tower:read', 'metanav:tactics'];
const STATE = join(OUT, 'state.json');
const signing = new Set();   // what's being signed in to right now, so a second click doesn't open a second window
const sleep = ms => new Promise(r => setTimeout(r, ms));

function load() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return { rev: 0 }; }
}
// write-then-rename, so a run or a page never reads half a file
function write(file, text) {
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}
function save(state) {
  write(STATE, JSON.stringify(state, null, 1));
  write(join(OUT, 'state.js'), `window.towerState = ${JSON.stringify(state).replace(/<\//g, '<\\/')};\n`);
}

// A run. `manual`: one the user asked for (SYNC NOW, `metanav`, a sign-in that worked) - run.mjs skips the hours for it.
function start(manual) {
  spawn(process.execPath, [join(SKILL, 'run.mjs'), ...(manual ? ['--manual'] : [])], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
const refresh = () => start(true);
// one run at a time (run.mjs locks too), and not while a sign-in window holds the browser profile
const occupied = () => busy(OUT) || signing.has('microsoft');
let queued = false;   // a run asked for while one was going: it starts once that one is done

// A timer looks twice a minute, so after the computer wakes up, the slot it slept through runs straight away.
// Not when the service starts: logging in isn't a slot turning.
let lastSlot = slotOf(new Date(), SCHEDULE);
setInterval(() => {
  const s = slotOf(new Date(), SCHEDULE), turned = s !== lastSlot;
  lastSlot = s;
  if (occupied() || !(turned || queued)) return;
  start(queued);
  queued = false;
}, 30e3);

// Outlook's mail page is titled "Mail - <name> - Outlook", and Teams "<view> | Microsoft Teams", only once you're past
// the sign-in (Teams' own loading page is just "Microsoft Teams")
async function signedIn(port) {
  try {
    const titles = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).filter(p => p.type === 'page').map(p => p.title || '');
    return titles.some(t => t.startsWith('Mail - ')) && titles.some(t => t.endsWith('| Microsoft Teams'));
  } catch { return false; }
}

// A visible window on the runs' own profile, at Outlook and Teams: a new profile may have to pick the account for
// Teams once, which a headless run can't. Once both have loaded, give the cookies a moment, close the window - the
// next run needs the profile - and refresh. A plain Chrome, not an automated one: sign-in pages can refuse those.
async function signInMicrosoft() {
  const chrome = chromePath();
  if (!chrome) return false;
  mkdirSync(PROFILE, { recursive: true });
  rmSync(join(PROFILE, 'DevToolsActivePort'), { force: true });
  const p = spawn(chrome, [`--user-data-dir=${PROFILE}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    'https://outlook.office.com/mail/', 'https://teams.microsoft.com/v2/'], { stdio: 'ignore' });
  let open = true, ok = false;
  p.on('exit', () => { open = false; });
  for (const deadline = Date.now() + 600e3; open && Date.now() < deadline;) {
    await sleep(2000);
    const portFile = join(PROFILE, 'DevToolsActivePort');
    if (existsSync(portFile) && await signedIn(readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim())) { ok = true; await sleep(4000); break; }
  }
  if (open) { p.kill(); await new Promise(r => { p.once('exit', r); setTimeout(r, 15000); }); }
  return ok;
}

// az login opens the browser itself. BROWSER=open on macOS: its default way is AppleScript, which macOS stops when it
// comes from a background job - `open` always works.
function signInAzure() {
  const env = { ...process.env, ...(process.platform === 'darwin' && { BROWSER: 'open' }) };
  const tenant = (tool('az', ['account', 'show', '--query', 'tenantId', '-o', 'tsv'], { env }).stdout || '').trim();
  return tool('az', ['login', '--output', 'none', ...(tenant ? ['--tenant', tenant] : [])], { env, timeout: 600e3 }).status === 0;
}

function signIn(source) {
  const what = source === 'Azure DevOps' ? 'azure' : 'microsoft';
  // a run holds the browser profile while it reads Outlook and Teams
  if (signing.has(what) || (what === 'microsoft' && busy(OUT))) return 'busy';
  signing.add(what);
  (async () => {
    try { if (await (what === 'azure' ? signInAzure() : signInMicrosoft())) refresh(); }
    finally { signing.delete(what); }
  })();
  return 'started';
}

function reply(res, status, obj) {
  const data = obj === undefined ? '' : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': 'null', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

const server = createServer((req, res) => {
  // Only the panel itself may call in: a page on disk sends Origin "null"; a website open in the same browser sends its
  // own origin. The Host check keeps out DNS-rebinding tricks.
  if (req.method !== 'POST' || !['/state', '/signin', '/refresh'].includes(req.url) || (req.headers.origin ?? 'null') !== 'null'
    || ![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) return reply(res, 403);
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > 1 << 22) req.destroy(); });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw || '{}');
      if (req.url === '/signin' && !['Azure DevOps', 'Outlook', 'Teams'].includes(body.source)) throw 0;
      if (req.url === '/state' && (!KEYS.includes(body.key) || typeof body.value !== 'object' || !body.value || Array.isArray(body.value))) throw 0;
    } catch { return reply(res, 400); }
    if (req.url === '/signin') return reply(res, 200, { status: signIn(body.source) });
    if (req.url === '/refresh') {
      if (!occupied()) { refresh(); return reply(res, 200, { status: 'started' }); }
      if (body.queue) queued = true;
      return reply(res, 200, { status: queued ? 'queued' : 'busy' });
    }
    const state = load();
    state[body.key] = body.value;
    state.rev = (state.rev || 0) + 1;   // lets an open page tell that another browser changed something
    save(state);
    reply(res, 200, state);
  });
});

mkdirSync(OUT, { recursive: true });
save(load());   // state.js always exists once the service is up, so the page knows to use it
server.listen(PORT, '127.0.0.1');
