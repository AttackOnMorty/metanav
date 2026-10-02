// What the judge wrote, made into the brief the panel shows: checked once against the contract (JUDGE.md step 6),
// with what the collector knows for certain put in by code, not left to the judge.
//   intake(brief, inputs, prev) -> the brief to show and keep in runs/
// `inputs` is the collector's inputs.json; `prev` the previous run's brief, or null on a first run.
import Panel from './panel.cjs';

const LISTS = ['queue', 'waiting', 'highlights', 'done', 'calendar'];
// Sections whose items are flagged against the previous run ("done": closed since then)
const TRACKED = ['queue', 'waiting', 'highlights', 'done'];
const names = w => Array.isArray(w) ? w : String(w || '').split(/[、,，&]\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);

// One entry per source, from what the collector reported. `signin` names the panel's SIGN IN button that fixes it:
// "microsoft" (Outlook and Teams share one sign-in) or "azure" (az login).
function sourcesOf(inputs) {
  const microsoftSignin = !!(inputs.mail?.signin_needed || inputs.teams?.signin_needed);
  const browser = (name, x) => !x ? { name, ok: false, note: 'not read' }
    : microsoftSignin && !x.error ? { name, ok: false, note: 'sign-in needed', signin: 'microsoft' }
    : x.error ? { name, ok: false, note: x.error } : { name, ok: true };
  const list = [browser('Outlook', inputs.mail), browser('Teams', inputs.teams)];
  const gh = inputs.github;
  list.push(gh?.ok ? { name: 'GitHub', ok: true } : { name: 'GitHub', ok: false, note: gh?.error || 'not read' });
  // Azure DevOps only when config.azure_devops.orgs lists any
  const ado = inputs.ado;
  if (ado && !ado.skipped) {
    list.push(!ado.ok ? { name: 'Azure DevOps', ok: false, note: ado.error || 'not read', signin: 'azure' }
      : ado.errors?.length ? { name: 'Azure DevOps', ok: false, note: ado.errors.join('; ') } : { name: 'Azure DevOps', ok: true });
  }
  return list;
}

// new: not on the panel last run. moved: the same matter changed sides - it was on the other list last run (passed back
// to the user, or now waiting on someone); the page says MOVED, so it doesn't look like it came from nowhere.
// updated: already there, but something happened on it since (a nudge, a reply that didn't close it).
function compare(brief, prev) {
  const { keyOf } = Panel, other = { queue: 'waiting', waiting: 'queue' };
  for (const section of TRACKED) {
    const seen = new Set((prev[section] || []).map(keyOf));
    const there = new Set((prev[other[section]] || []).map(keyOf));
    for (const item of brief[section]) {
      item.moved = !seen.has(keyOf(item)) && there.has(keyOf(item));
      item.new = !seen.has(keyOf(item)) && !item.moved;
      item.updated = !item.new && (item.last_activity || item.at || '') > (prev.generated_at || '');
    }
  }
}

export function intake(judged, inputs, prev) {
  const brief = { ...judged };
  for (const k of LISTS) brief[k] = Array.isArray(brief[k]) ? brief[k] : [];
  for (const w of brief.waiting) Object.assign(w, { who: names(w.who), not_waiting: names(w.not_waiting) });
  for (const q of brief.queue) q.who = names(q.who);
  brief.sources = sourcesOf(inputs);
  // The panel's "Synced" time, .last-run (the next window's start) and the "updated" flags all hang on this.
  // A model guesses the time; the collector knows when it read everything.
  if (inputs.collected_at) brief.generated_at = inputs.collected_at.slice(0, 19) + 'Z';
  if (prev) compare(brief, prev);
  return brief;
}
