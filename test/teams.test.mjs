import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversations } from '../scripts/collect/teams.mjs';

// What readCache() takes out of Teams' cache, in its shape
const t = (d, h = 9) => Date.UTC(2026, 8, d, h);   // September 2026
const window = { since: new Date(t(30)).toISOString(), activeSince: new Date(t(30)).toISOString(), lookback: new Date(t(1)).toISOString(), skip: [] };
const msg = (id, d, from, over = {}) => ({ id, originalArrivalTime: t(d), messageType: 'RichText/Html', content: `<p>${id}</p>`,
  ...(from === 'ME' ? { isSentByCurrentUser: true } : { imDisplayName: from }), ...over });
const chat = (id, messages, over = {}) => ({ conversationId: id, latestDeliveryTime: Math.max(...messages.map(m => m.originalArrivalTime)), messages, ...over });
const cache = (chains, convs = []) => ({ conversations: convs, chains });
const DM = '8:orgid:a_8:orgid:b@unq.gbl.spaces';
const ids = list => list.map(c => [c.name, c.messages.map(m => m.id)]);

test('where the user took part, the whole lookback comes along; elsewhere only what is new', () => {
  const list = conversations(cache([
    chat(DM, [msg('ask', 10, 'ME'), msg('reply', 30, 'Sam')]),
    chat('19:group@thread.v2', [msg('old', 10, 'Ann'), msg('new', 30, 'Ann')]),
  ], [{ id: '19:group@thread.v2', threadType: 'chat', topic: 'Project chat' }]), window);
  assert.deepEqual(ids(list), [['Sam', ['ask', 'reply']], ['Project chat', ['new']]]);
});

test('channels, system feeds, notes to self and listed bot chats are left out', () => {
  const list = conversations(cache([
    chat('19:channel@thread.tacv2', [msg('c', 30, 'Ann')]),
    chat('48:notifications', [msg('n', 30, 'Ann')]),
    chat('19:self@thread.v2', [msg('note', 30, 'ME')]),
    chat('19:bot@thread.v2', [msg('b', 30, 'Reminder')]),
    chat(DM, [msg('hi', 30, 'Sam')]),
  ], [{ id: '19:self@thread.v2', threadType: 'chat' }, { id: '19:bot@thread.v2', threadType: 'chat', topic: 'Workflows' }]), { ...window, skip: ['Workflows'] });
  assert.deepEqual(ids(list), [['Sam', ['hi']]]);
});

test('deleted messages, system events and messages without a sender are skipped', () => {
  const list = conversations(cache([chat(DM, [msg('kept', 30, 'Sam'), msg('gone', 30, 'Sam', { deleted: true }),
    msg('event', 30, 'Sam', { messageType: 'ThreadActivity/AddMember' }), { id: 'rec', originalArrivalTime: t(30), messageType: 'RichText/Html', content: 'x' }])]), window);
  assert.deepEqual(ids(list), [['Sam', ['kept']]]);
});

test('a conversation with nothing new since the last run is left to the previous run', () => {
  assert.deepEqual(conversations(cache([chat(DM, [msg('ask', 10, 'ME'), msg('reply', 20, 'Sam')])]), window), []);
});

test('unread: others\' messages after how far the user has read', () => {
  const [c] = conversations(cache([chat(DM, [msg('a', 30, 'Sam', { originalArrivalTime: t(30, 10) }), msg('b', 30, 'Sam', { originalArrivalTime: t(30, 12) })])],
    [{ id: DM, horizon: `${t(30, 11)};x;y` }]), window);
  assert.deepEqual([c.unread, c.messages.map(m => m.unread)], [1, [false, true]]);
});

test('a message reads as plain text, quotes and images marked, with a link that opens it in the Teams app', () => {
  const [c] = conversations(cache([chat(DM, [msg('m1', 30, 'Sam', { content: '<blockquote>earlier</blockquote><p>Sure &amp; done</p><img src="x">' })])]), window);
  assert.deepEqual([c.kind, c.messages[0].text, c.messages[0].link.startsWith(`msteams:/l/message/${encodeURIComponent(DM)}/m1?`)], ['dm', '[quote] Sure & done [image]', true]);
});

test('newest conversation first', () => {
  const list = conversations(cache([chat(DM, [msg('older', 30, 'Sam', { originalArrivalTime: t(30, 10) })]),
    chat('19:meeting_abc@thread.v2', [msg('newer', 30, 'Ann', { originalArrivalTime: t(30, 11) })])]), window);
  assert.deepEqual(list.map(c => c.kind), ['meeting', 'dm']);
});
