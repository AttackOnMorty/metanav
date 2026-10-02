// Recent Teams chats, from Teams' own local cache (IndexedDB) - no network call, no token, no chat opened, so
// nothing is marked read. readCache() runs in the Teams page and only reads; conversations() decides what the run sees.

// ---- in the page: the cache's conversations, and the reply chains active since `lookback` (ms), with just the fields
// conversations() reads
export async function readCache(lookback) {
  const dbs = await indexedDB.databases();
  const open = re => new Promise((resolve, reject) => {
    const d = dbs.find(x => re.test(x.name));
    if (!d) return reject(new Error('Teams cache not found: ' + re));
    const q = indexedDB.open(d.name);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
  const all = (db, store) => new Promise(resolve => {
    const q = db.transaction(store, 'readonly').objectStore(store).getAll();
    q.onsuccess = () => resolve(q.result);
  });
  const convDb = await open(/^Teams:conversation-manager:/);
  const rcDb = await open(/^Teams:replychain-manager:/);
  const [convs, chains] = await Promise.all([all(convDb, 'conversations'), all(rcDb, 'replychains-2')]);
  convDb.close(); rcDb.close();
  return {
    conversations: convs.map(c => ({ id: c.id, threadType: c.threadProperties?.threadType, topic: c.threadProperties?.topic, horizon: c.properties?.consumptionhorizon })),
    chains: chains.filter(rc => rc.latestDeliveryTime >= lookback).map(rc => ({
      conversationId: rc.conversationId, latestDeliveryTime: rc.latestDeliveryTime,
      messages: Object.values(rc.messageMap || {}).map(m => ({ id: m.id, originalArrivalTime: m.originalArrivalTime, messageType: m.messageType,
        isSentByCurrentUser: m.isSentByCurrentUser, imDisplayName: m.imDisplayName, content: m.content, deleted: !!m.deletionInfo })),
    })),
  };
}

// How far the cache has caught up: how many reply chains, and the newest message's time ('' before it exists)
export async function cacheState() {
  const d = (await indexedDB.databases()).find(x => /^Teams:replychain-manager:/.test(x.name));
  if (!d) return '';
  const db = await new Promise((res, rej) => { const q = indexedDB.open(d.name); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  if (!db.objectStoreNames.contains('replychains-2')) { db.close(); return ''; }
  const all = await new Promise(res => { const q = db.transaction('replychains-2', 'readonly').objectStore('replychains-2').getAll(); q.onsuccess = () => res(q.result); });
  db.close();
  return `${all.length}:${Math.max(0, ...all.map(r => r.latestDeliveryTime || 0))}`;
}

// ---- in Node

const MAX_PER_CONV = 40;
const kindOf = (id, c) => {
  if (id.endsWith('@unq.gbl.spaces')) return 'dm';
  if (c.threadType === 'meeting' || id.includes('meeting_')) return 'meeting';
  if (c.threadType === 'chat') return 'group';
  return 'channel';   // space / topic threads
};
const text = html => String(html || '')
  .replace(/<blockquote[\s\S]*?<\/blockquote>/g, ' [quote] ')
  .replace(/<img[^>]*>/g, ' [image] ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\s+/g, ' ').trim();
// The link that opens a message in the Teams app
const linkTo = (id, m) => `msteams:/l/message/${encodeURIComponent(id)}/${m.id}?context=${encodeURIComponent('{"contextType":"chat"}')}`;

// The direct, group and meeting chats with something new since `activeSince` (channels aren't read: asks and news reach
// the user in chats and mail), newest first. Where the user took part, every message back to `lookback` comes along for
// context; elsewhere only what's new since `since`. Chats named in `skip` (bots, reminders) and notes to self are left
// out. Times are ISO strings.
export function conversations(raw, { since, activeSince, lookback, skip = [] }) {
  const SINCE = Date.parse(since), ACTIVE = Date.parse(activeSince), LOOKBACK = Date.parse(lookback);
  const byId = Object.fromEntries(raw.conversations.map(c => [c.id, c]));
  const recent = raw.chains.filter(rc => rc.latestDeliveryTime >= LOOKBACK && !rc.conversationId.startsWith('48:'));   // 48:* = system feeds
  const usable = rc => rc.messages.filter(m => m.originalArrivalTime >= LOOKBACK && !m.deleted && /^(Text|RichText)/.test(m.messageType || '')
    && (m.isSentByCurrentUser || m.imDisplayName));   // no sender = meeting recording / system event
  // "Took part" is per conversation (every chat message is its own reply chain)
  const chatsWithMe = new Set(recent.filter(rc => usable(rc).some(m => m.isSentByCurrentUser)).map(rc => rc.conversationId));

  const out = {};
  for (const rc of recent) {
    const id = rc.conversationId, conv = byId[id] || {}, kind = kindOf(id, conv);
    if (kind === 'channel') continue;
    const msgs = usable(rc);
    const keep = chatsWithMe.has(id) ? msgs : msgs.filter(m => m.originalArrivalTime >= SINCE);
    if (!keep.length) continue;
    const horizon = Number(String(conv.horizon || '0').split(';')[0]) || 0;
    const o = out[id] ??= { id, kind, name: conv.topic || null, others: new Set(), messages: [] };
    for (const m of keep) {
      const body = text(m.content);
      if (!body) continue;
      if (!m.isSentByCurrentUser && m.imDisplayName) o.others.add(m.imDisplayName);
      o.messages.push({ id: m.id, at: new Date(m.originalArrivalTime).toISOString(), from: m.isSentByCurrentUser ? 'ME' : m.imDisplayName,
        unread: !m.isSentByCurrentUser && m.originalArrivalTime > horizon, text: body.slice(0, 300), link: linkTo(id, m) });
    }
  }

  return Object.values(out)
    .filter(c => c.messages.length && c.others.size)          // drop notes-to-self
    // Nothing new here since the last run: its open loops are carried over from the previous run instead.
    .filter(c => c.messages.some(m => Date.parse(m.at) >= ACTIVE))
    .map(c => {
      c.messages.sort((a, b) => a.at.localeCompare(b.at));
      return { id: c.id, kind: c.kind, name: c.name || [...c.others].join(', '), unread: c.messages.filter(m => m.unread).length, messages: c.messages.slice(-MAX_PER_CONV) };
    })
    .filter(c => !skip.includes(c.name))
    .sort((a, b) => b.messages.at(-1).at.localeCompare(a.messages.at(-1).at));
}
