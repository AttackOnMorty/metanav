async () => {
  // Read recent Teams messages from Teams' own local cache (IndexedDB).
  // Read-only: no network call, no token, no chat opened - nothing is marked read.
  const SINCE = Date.parse('__SINCE__');          // replaced with the window start (last run)
  const ACTIVE = Date.parse('__ACTIVE_SINCE__');  // skip conversations silent since then: same as SINCE, or LOOKBACK on a first run
  const LOOKBACK = Date.parse('__LOOKBACK__');    // config.lookback_days back: how far open loops reach
  const MAX_PER_CONV = 40;

  const dbs = await indexedDB.databases();
  const open = (re) => new Promise((resolve, reject) => {
    const d = dbs.find(x => re.test(x.name));
    if (!d) return reject(new Error('Teams cache not found: ' + re));
    const q = indexedDB.open(d.name);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
  const all = (db, store) => new Promise((resolve) => {
    const q = db.transaction(store, 'readonly').objectStore(store).getAll();
    q.onsuccess = () => resolve(q.result);
  });

  const convDb = await open(/^Teams:conversation-manager:/);
  const rcDb = await open(/^Teams:replychain-manager:/);
  const [convs, chains] = await Promise.all([all(convDb, 'conversations'), all(rcDb, 'replychains-2')]);
  convDb.close(); rcDb.close();

  const byId = Object.fromEntries(convs.map(c => [c.id, c]));
  const kindOf = (id, c) => {
    const t = c.threadProperties?.threadType;
    if (id.endsWith('@unq.gbl.spaces')) return 'dm';
    if (t === 'meeting' || id.includes('meeting_')) return 'meeting';
    if (t === 'chat') return 'group';
    return 'channel';   // space / topic threads
  };
  const text = (html) => String(html || '')
    .replace(/<blockquote[\s\S]*?<\/blockquote>/g, ' [quote] ')
    .replace(/<img[^>]*>/g, ' [image] ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ').trim();

  const recent = chains.filter(rc => rc.latestDeliveryTime >= LOOKBACK && !rc.conversationId.startsWith('48:'));   // 48:* = system feeds
  const usable = (rc) => Object.values(rc.messageMap || {})
    .filter(m => m.originalArrivalTime >= LOOKBACK && !m.deletionInfo && /^(Text|RichText)/.test(m.messageType || '')
      && (m.isSentByCurrentUser || m.imDisplayName));   // no sender = meeting recording / system event

  // Open loops only live where the user took part: keep the whole lookback there, only new messages elsewhere.
  // "Took part" is per conversation (every chat message is its own reply chain).
  const chatsWithMe = new Set(recent.filter(rc => usable(rc).some(m => m.isSentByCurrentUser)).map(rc => rc.conversationId));

  // The link that opens a message in the Teams app
  const linkTo = (id, m) => `msteams:/l/message/${encodeURIComponent(id)}/${m.id}?context=${encodeURIComponent('{"contextType":"chat"}')}`;

  const out = {};
  for (const rc of recent) {
    const id = rc.conversationId;
    const conv = byId[id] || {};
    const kind = kindOf(id, conv);
    if (kind === 'channel') continue;   // channels aren't read: asks and news reach the user in chats and mail
    const msgs = usable(rc);
    const mine = chatsWithMe.has(id);
    const keep = mine ? msgs : msgs.filter(m => m.originalArrivalTime >= SINCE);
    if (!keep.length) continue;

    const horizon = Number(String(conv.properties?.consumptionhorizon || '0').split(';')[0]) || 0;
    const o = out[id] ??= { id, kind, name: conv.threadProperties?.topic || null, others: new Set(), messages: [] };
    for (const m of keep) {
      const body = text(m.content);
      if (!body) continue;
      if (!m.isSentByCurrentUser && m.imDisplayName) o.others.add(m.imDisplayName);
      o.messages.push({
        id: m.id,
        at: new Date(m.originalArrivalTime).toISOString(),
        from: m.isSentByCurrentUser ? 'ME' : m.imDisplayName,
        unread: !m.isSentByCurrentUser && m.originalArrivalTime > horizon,
        text: body.slice(0, 300),
        link: linkTo(id, m),
      });
    }
  }

  const conversations = Object.values(out)
    .filter(c => c.messages.length && c.others.size)          // drop notes-to-self
    // Nothing new here since the last run: its open loops are carried over from the previous run instead.
    .filter(c => c.messages.some(m => Date.parse(m.at) >= ACTIVE))
    .map(c => {
      c.messages.sort((a, b) => a.at.localeCompare(b.at));
      return {
        id: c.id,
        kind: c.kind,
        name: c.name || [...c.others].join(', '),
        unread: c.messages.filter(m => m.unread).length,
        messages: c.messages.slice(-MAX_PER_CONV),
      };
    })
    .sort((a, b) => b.messages.at(-1).at.localeCompare(a.messages.at(-1).at));

  return { since: new Date(SINCE).toISOString(), conversations };
}
