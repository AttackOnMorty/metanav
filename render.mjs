// Render brief.json into the panel and keep the run history.
//   node render.mjs <brief.json> [inputs.json]   the run's result (work and review_requests come from the inputs)
//   node render.mjs --syncing | --idle           repaint the last result with or without "Syncing" (run.mjs does both)
// Writes, in the output dir:
//   index.html          the panel (fixed path; the open page reloads itself when stamp.js changes)
//   stamp.js            what the panel is showing, in one line - polled by the open page
//   runs/<stamp>.json   this run, with `new` flags - the next run's baseline (kept 14 days)
//   .last-run           this run's time, the start of the next window
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUT, SKILL, WIN, config, tool } from './common.mjs';

// Sections whose items get a "+NEW" flag when they weren't in the previous run ("done": closed since the last run)
const TRACKED = ['queue', 'waiting', 'highlights', 'done'];
const RUNS = join(OUT, 'runs');

// Outlook folder paths -> names, so the panel can say which folder a mail link opens (only Inbox mail opens itself)
const mail = config.mail || {};
const path = u => { try { return new URL(u).pathname.replace(/\/$/, ''); } catch { return ''; } };
const MAIL_FOLDERS = Object.fromEntries([...(mail.received_folders || []).map(f => [f.name, f.url]), ['Sent', mail.sent], ['Deleted', mail.deleted]]
  .filter(([, u]) => u).map(([n, u]) => [path(u), n]));

const runFiles = () => { mkdirSync(RUNS, { recursive: true }); return readdirSync(RUNS).filter(f => f.endsWith('.json')).sort(); };
const pad = n => String(n).padStart(2, '0');

function writePanel(data) {
  data = { ...data, mail_folders: MAIL_FOLDERS };
  const template = readFileSync(join(SKILL, 'template.html'), 'utf8');
  // The open page polls stamp.js once a minute and reloads only when it changes: new data, the syncing flag, or a
  // new template. Written after index.html, so a reload always gets the new page.
  const stamp = createHash('sha1').update(template + JSON.stringify(data)).digest('hex').slice(0, 12);
  // "</" inside the JSON would close the <script> tag early
  const payload = JSON.stringify({ ...data, stamp }).replace(/<\//g, '<\\/');
  writeFileSync(join(OUT, 'index.html'), template.replace('__BRIEF_DATA__', () => payload));
  writeFileSync(join(OUT, 'stamp.js'), `window.towerStamp = '${stamp}';\n`);
}

// Repaint the last result with or without the "syncing" flag. No history, no notification.
export function repaint(syncing) {
  const last = runFiles().at(-1);
  if (last) writePanel({ ...JSON.parse(readFileSync(join(RUNS, last), 'utf8')), syncing });
}

// The panel is pull; push only what can't wait - a new high-urgency item
function notify(title) {
  if (process.platform === 'darwin') {
    tool('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv) sound name "Glass"', '-e', 'end run', 'Meta-Nav', title]);
  } else if (WIN) {
    const ps = `$t = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text'); $x.Item(0).AppendChild($t.CreateTextNode('Meta-Nav')) > $null; $x.Item(1).AppendChild($t.CreateTextNode([Console]::In.ReadToEnd())) > $null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
    // -EncodedCommand: the script as base64 UTF-16, so nothing in it needs quoting through the shell; the title comes on stdin
    tool('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { input: title });
  }
}

export function renderBrief(briefFile, inputsFile) {
  const brief = JSON.parse(readFileSync(briefFile, 'utf8'));
  // The run doesn't copy GitHub's "my work" and review requests into the brief; they come straight from the collector.
  if (inputsFile) {
    const inputs = JSON.parse(readFileSync(inputsFile, 'utf8'));
    const gh = inputs.github || {};
    brief.work ??= gh.work || [];
    brief.review_requests ??= gh.review_requests || [];
    // The panel's "Synced" time, .last-run (the next window's start) and the "updated" flags all hang on this.
    // A model guesses the time; the collector knows when it read everything.
    if (inputs.collected_at) brief.generated_at = inputs.collected_at.slice(0, 19) + 'Z';
  }
  // The wording is rewritten every run; an explicit id (mail conversation) or the link is what stays put
  const key = i => i.id || i.url || i.title || i.what;
  const previous = runFiles();
  brief.first_run = !previous.length;   // nothing to diff against: the page skips "since last run"
  if (previous.length) {
    const prev = JSON.parse(readFileSync(join(RUNS, previous.at(-1)), 'utf8'));
    for (const section of TRACKED) {
      const seen = new Set((prev[section] || []).map(key));
      for (const item of brief[section] || []) {
        item.new = !seen.has(key(item));
        // Already on the panel, but something happened on it since (a nudge, a reply that didn't close it).
        // Without this, an item that moved looks exactly like one that didn't.
        item.updated = !item.new && (item.last_activity || '') > (prev.generated_at || '');
      }
    }
  }
  const urgent = (brief.queue || []).filter(q => q.new && q.urgency === 'high');
  if (urgent.length) notify(urgent.length === 1 ? urgent[0].title : `${urgent.length} new urgent items`);

  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  writeFileSync(join(RUNS, `${stamp}.json`), JSON.stringify(brief, null, 1));
  // Only the latest run is ever read back; two weeks is plenty for looking into a bad call
  const cutoff = new Date(Date.now() - 14 * 864e5), c = `${cutoff.getFullYear()}${pad(cutoff.getMonth() + 1)}${pad(cutoff.getDate())}`;
  for (const f of runFiles()) if (f.slice(0, 8) < c) rmSync(join(RUNS, f));

  writePanel(brief);
  writeFileSync(join(OUT, '.last-run'), brief.generated_at);
  return join(OUT, 'index.html');
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || '')) {
  const [a, b] = process.argv.slice(2);
  if (a === '--syncing' || a === '--idle') repaint(a === '--syncing');
  else console.log(renderBrief(a, b));
}
