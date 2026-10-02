// The panel model: from the brief, the user's clicks and the time, what each part of the panel shows.
// No DOM: render.mjs inlines this file into the page (a plain <script>, where it defines `Panel`), and Node loads it
// for the tests.
//   Panel.model(brief, { done, read }, now)  -> everything the page draws
//   Panel.record(item, kind, now)            -> the click to store for it; kind: 'done' | 'drop' | 'read'
//   Panel.keyOf(item)                        -> an item's identity across runs and clicks
// `done` is the click store's tower:dismissed (done and Drop clicks), `read` its tower:read (Got it); both map an item's
// key to its click record, { at, when, title, url, effort?, dismissed? } - `at` the item's activity time when clicked,
// so anything newer on it brings it back. Older stores hold just `at`.
const Panel = (() => {
  // The wording is rewritten every run; an explicit id (mail conversation) or the link is what stays put
  const keyOf = x => x.id || x.url || x.title || x.what;
  const actAt = x => x.last_activity || x.at || '';
  const entry = v => typeof v === 'string' ? { at: v, when: '', title: '' } : v;
  // a Teams item's conversation, from its id or link
  const convOf = k => { k = String(k || ''); const m = k.match(/^msteams:\/l\/message\/([^/]+)/) || k.match(/^(19:[^/#]+)/); return m ? decodeURIComponent(m[1]) : k; };
  const names = w => Array.isArray(w) ? w : String(w || '').split(/[、,，&]\s*|\s+and\s+/).map(s => s.trim()).filter(Boolean);

  const hhmm = d => d.toTimeString().slice(0, 5);
  const midnight = d => new Date(d.toDateString());
  // A bare time always means today: "09:23"; otherwise its day goes with it — "Yesterday 20:22", "Mon 20:22"
  const dayTime = (iso, now) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const days = Math.round((midnight(now) - midnight(d)) / 864e5);
    return days <= 0 ? hhmm(d) : days === 1 ? `Yesterday ${hhmm(d)}` : `${d.toLocaleDateString('en-AU', { weekday: 'short' })} ${hhmm(d)}`;
  };
  // calendar days since the ask
  const waitDays = (w, now) => w.since ? Math.max(0, Math.floor((midnight(now) - midnight(new Date(w.since))) / 864e5)) : 0;

  function record(x, kind, now) {
    const title = x.title || (x.who ? `${names(x.who).join(', ')}: ${x.what}` : x.what);
    return { at: actAt(x), when: now.toISOString(), title, url: x.url || '',
      ...(kind === 'done' && x.effort && { effort: x.effort }), ...(kind === 'drop' && { dismissed: true }) };
  }

  function model(B, clicks, now) {
    const D = clicks.done || {}, R = clicks.read || {};
    // clicked, and nothing newer on it since: hidden; something newer: back
    const clicked = (store, x) => keyOf(x) in store;
    const newer = (store, x) => actAt(x) > entry(store[keyOf(x)]).at;
    const resurfaced = x => clicked(D, x) && newer(D, x);
    const shown = x => !(clicked(D, x) && !newer(D, x)) && !(clicked(R, x) && !newer(R, x));
    // One change per item, whichever section shows it: MOVED (over from the other list), NEW (since the last run),
    // UPDATE (something happened on it since the last run, or since the user's click)
    const change = x => x.moved ? 'MOVED' : x.new ? 'NEW' : (x.updated || resurfaced(x) || clicked(R, x)) ? 'UPDATE' : '';
    const vis = xs => (xs || []).filter(shown).map(x => ({ ...x, change: change(x) }));
    const all = [...(B.queue || []), ...(B.waiting || []), ...(B.highlights || [])];

    const ranked = vis(B.queue);        // ranked by the run; how long the list is, is the run's call, not the page's
    const [top, ...rest] = ranked;
    const waiting = vis(B.waiting), highlights = vis(B.highlights);

    // done today = the run's closures + the user's own "done" clicks since local midnight, newest first
    // (yesterday's work is the daily scrum's job)
    const dayStart = midnight(now).toISOString();
    const manual = Object.entries(D).map(([key, v]) => ({ key, ...entry(v) }))
      .filter(m => m.when && m.when >= dayStart && !all.some(x => keyOf(x) === m.key && resurfaced(x)));
    const liveKeys = new Set(all.map(keyOf));
    // a click stays the user's row (their title, UNDO); when the run confirms it (a done row with the same id),
    // what actually happened shows under it, like a receipt, and the run's own row isn't shown twice
    const confirmed = new Map((B.done || []).filter(d => d.id).map(d => [d.id, d]));
    const manualShown = manual.filter(m => liveKeys.has(m.key)
      || !manual.some(o => o !== m && liveKeys.has(o.key) && convOf(o.key) === convOf(m.key)));
    const done = [
      ...(B.done || []).filter(d => !d.at || d.at >= dayStart).filter(d => !(d.id && manualShown.some(m => m.key === d.id)))
        .map(d => ({ what: d.what, url: d.url, label: (d.at && dayTime(d.at, now)) || d.when, at: d.at || '', new: !!d.new, effort: d.effort })),
      // a dismissed one stays too, stamped DROPPED: it left the list by the user's decision, not by being done
      ...manualShown.map(m => m.dismissed ? { what: m.title, url: m.url, label: dayTime(m.when, now), at: m.when, key: m.key, dropped: true }
        : { what: m.title, url: m.url, label: dayTime(m.when, now), at: m.when, key: m.key, note: confirmed.get(m.key)?.what,
          effort: m.effort || confirmed.get(m.key)?.effort }),
    ].sort((a, b) => b.at.localeCompare(a.at));

    // what others owe, grouped by person; whoever is worth chasing now goes first, then the longest wait
    const people = new Map();
    waiting.forEach(w => names(w.who).forEach(n => (people.get(n) || people.set(n, { name: n, items: [] }).get(n)).items.push(w)));
    const ledger = [...people.values()].map(p => ({ ...p, due: p.items.some(w => w.nudge_now), days: Math.max(0, ...p.items.map(w => waitDays(w, now))) }))
      .sort((x, y) => (y.due - x.due) || (y.days - x.days));

    // sync state
    const sources = B.sources || [], failed = sources.filter(s => !s.ok);
    const interval = B.interval_min || 60, ago = Math.round((now - Date.parse(B.generated_at)) / 60000);
    // stale: the next scheduled run is overdue by half an interval and hasn't shown up
    const nextAt = new Date(B.next_run || Date.parse(B.generated_at) + interval * 60000);
    const at = hhmm(new Date(B.generated_at)), next = nextAt.toDateString() === now.toDateString() ? hhmm(nextAt)
      : `${nextAt.toLocaleDateString('en-AU', { weekday: 'short' })} ${hhmm(nextAt)}`;
    const state = B.syncing ? 'syncing' : failed.length ? 'failed' : now - nextAt > interval * 30000 ? 'stale' : 'ok';
    const sync = {
      state, at, next, ago,
      text: { syncing: `Syncing… (last ${at})`, failed: `${failed.map(s => s.name).join(', ')} not synced`, stale: `Synced ${at} · stale`, ok: `Synced ${at}` }[state],
      tip: sources.map(s => `${s.name} ${s.ok ? '✓' : '✗ ' + (s.note || '')}`).join('\n') + `\nNext sync ${next}`,
    };

    return { now, ranked, top, rest, waiting, ledger, highlights, done, sources, failed, sync };
  }

  return { keyOf, record, model };
})();
if (typeof module === 'object') module.exports = Panel;
