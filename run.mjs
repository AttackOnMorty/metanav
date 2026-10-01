#!/usr/bin/env node
// Refresh Meta-Nav: hours guard, lock, collect, judge, render, clean up.
// launchd fires it on the hour; `metanav` and the panel's SYNC NOW drop a .manual flag first, which skips the hours.
// Everything here is deterministic. The only judgement - what's yours, what others owe you, in what order - is one
// call to the agent in config.json ("claude" or "codex"), which reads files and writes one file, brief.json.
//   node run.mjs            a scheduled run (weekdays within config.hours, unless .manual is there)
//   node run.mjs --rescan   a full rescan: rebuild everything over the whole lookback
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(SKILL, 'config.json');
const config = JSON.parse(readFileSync(CONFIG, 'utf8'));
const OUT = (config.output_dir || '~/metanav').replace(/^~(?=$|\/)/, homedir());
const RESCAN = process.argv.includes('--rescan');
const now = new Date();
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
function pad(n) { return String(n).padStart(2, '0'); }

// A run the user asked for ignores the hours
const manual = join(OUT, '.manual');
if (existsSync(manual)) rmSync(manual);
else {
  const day = now.getDay(), hour = now.getHours();
  const { start = 9, end = 18 } = config.hours || {};
  if (day < 1 || day > 5 || hour < start || hour > end) process.exit(0);
}

mkdirSync(join(OUT, 'logs'), { recursive: true });

// One run at a time - a slow run shouldn't overlap the next tick. A lock older than 20 minutes is left over
// from a run that died (lid closed, power off): clear it, or every later run would skip silently.
const lock = join(OUT, '.running');
if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 20 * 60e3) rmSync(lock, { recursive: true });
try { mkdirSync(lock); } catch { process.exit(0); }
process.on('exit', () => rmSync(lock, { recursive: true, force: true }));

const render = (...args) => spawnSync('python3', [join(SKILL, 'render.py'), ...args], { encoding: 'utf8' });
render('--syncing');   // "Syncing…" on the open panel until this run rewrites it

// The window: from the last run (never further back than the lookback), or the whole lookback on a first run
const read = f => { try { return readFileSync(f, 'utf8').trim(); } catch { return ''; } };
const runs = existsSync(join(OUT, 'runs')) ? readdirSync(join(OUT, 'runs')).filter(f => f.endsWith('.json')).sort() : [];
const PREV = runs.length && !RESCAN ? join(OUT, 'runs', runs.at(-1)) : '';
const LOOKBACK = new Date(Date.now() - (config.lookback_days ?? 30) * 864e5).toISOString().slice(0, 19) + 'Z';
let SINCE = (!RESCAN && read(join(OUT, '.last-run'))) || LOOKBACK;
if (SINCE < LOOKBACK) SINCE = LOOKBACK;   // back from a long break: loops don't reach further than this
const FIRST = PREV ? 'no' : 'yes';
const TODAY_PROJECT = (config.schedule || {})[now.toLocaleDateString('en-US', { weekday: 'short' })] || 'none';

// Collect: Outlook and Teams in a headless Chrome, GitHub and Azure DevOps alongside, into one file. About 25 s.
const DIR = join(OUT, '.inputs');
mkdirSync(DIR, { recursive: true });
const INPUTS = join(DIR, 'inputs.json'), BRIEF = join(DIR, 'brief.json');
const collect = spawnSync('node', [join(SKILL, 'collect.mjs'), SINCE, LOOKBACK, FIRST, PREV, INPUTS], { encoding: 'utf8', timeout: 5 * 60e3 });
const collected = `${collect.stdout || ''}${collect.stderr || ''}`.trim();

// Judge. The agent reads the inputs, the previous result, the user's clicks and the config, follows JUDGE.md,
// and writes BRIEF - nothing else: no network, no shell of its own, so it runs with the least access either agent has.
const prompt = `You are Meta-Nav's judge, running unattended: nobody will answer a question, so decide, finish and write the file.
Read ${join(SKILL, 'JUDGE.md')} and follow it, with these facts for this run:
SINCE=${SINCE}
LOOKBACK=${LOOKBACK}
FIRST=${FIRST}
TODAY_PROJECT=${TODAY_PROJECT}
INPUTS=${INPUTS}
PREV=${PREV || 'none'}
STATE=${join(OUT, 'state.json')}
CONFIG=${CONFIG}
BRIEF=${BRIEF}
Write your result to BRIEF and change no other file. Then reply with the summary JUDGE.md asks for.`;

const agent = config.agent || 'claude';
const model = config.judge_model || '';
const t0 = Date.now();
let log;
if (agent === 'codex') {
  // workspace-write keeps its writes inside .inputs; the user's own Codex config (MCP servers, rules) and hooks aren't
  // loaded - hooks.json isn't covered by --ignore-user-config, and a hook waiting on a person would hang the run
  const last = join(DIR, 'last-message.txt');
  const r = spawnSync('codex', ['exec', '--ignore-user-config', '--disable', 'hooks', '--skip-git-repo-check', '--ephemeral',
    '--sandbox', 'workspace-write', '--cd', DIR, '-c', 'model_reasoning_effort="high"',
    ...(model && !/^(opus|sonnet|haiku|claude)/.test(model) ? ['--model', model] : []),
    '--output-last-message', last, prompt], { cwd: DIR, encoding: 'utf8', timeout: 20 * 60e3, maxBuffer: 64 << 20 });
  log = { agent, model: model || 'default', is_error: r.status !== 0, result: read(last) || (r.stderr || '').slice(-4000) };
} else {
  // Only Read and Write: no MCP servers (--strict-mcp-config with none given), no shell, no other tool
  const r = spawnSync('claude', ['-p', prompt, '--model', model || 'opus', '--strict-mcp-config',
    '--add-dir', SKILL, '--allowedTools', 'Read', 'Write', '--output-format', 'json'],
    { cwd: OUT, encoding: 'utf8', timeout: 20 * 60e3, maxBuffer: 64 << 20 });
  try { log = { agent, ...JSON.parse(r.stdout) }; } catch { log = { agent, is_error: true, result: `${r.stdout || ''}${r.stderr || ''}`.slice(-4000) }; }
}
log.duration_ms ??= Date.now() - t0;
log.collect = collected;

// Render what the judge wrote. A run that wrote nothing usable leaves the last good result up - the panel marks it
// stale once it's over 90 minutes old.
let brief = null;
try { brief = JSON.parse(readFileSync(BRIEF, 'utf8')); } catch (e) { log.is_error = true; log.brief_error = String(e.message || e); }
if (brief) {
  const r = render(BRIEF, INPUTS);
  if (r.status !== 0) { log.is_error = true; log.render_error = `${r.stdout}${r.stderr}`.trim().slice(-2000); }
}
if (read(join(OUT, 'index.html')).includes('"syncing": true')) render('--idle');

writeFileSync(join(OUT, 'logs', `${stamp}${RESCAN ? '-rescan' : ''}.json`), JSON.stringify(log, null, 1));

// The inputs hold private chats and mail: deleted every time, even after a failed run
rmSync(DIR, { recursive: true, force: true });
for (const f of readdirSync(join(OUT, 'logs'))) {
  const p = join(OUT, 'logs', f);
  if (f.endsWith('.json') && Date.now() - statSync(p).mtimeMs > 7 * 864e5) rmSync(p);
}
