// What Outlook on the web shows, read into what the run needs. collect.mjs reads the page raw (the functions marked
// "in the page", which run inside the browser and so can use nothing from here); everything that interprets what it
// read is plain Node, tested on what Outlook's pages say. Outlook must be in English, with day/month/year dates and a
// 12-hour clock (README).

// A row's time, as its title shows it: "Thu 1/10/2026 3:05 PM" (D/M/Y) -> ms, or NaN
export function rowTime(t) {
  const m = t && t.match(/(\d+)\/(\d+)\/(\d{4}) (\d+):(\d+) ([AP]M)/);
  return m ? new Date(+m[3], m[2] - 1, +m[1], +m[4] % 12 + (m[6] === 'PM' ? 12 : 0), +m[5]).getTime() : NaN;
}

// The day view's event labels: "Title, 9:30 AM to 9:45 AM, Friday, …" or "…, all day event, …" - not the time slots'
// own labels ("9:30 AM", "10:00 AM to 10:30 AM") or a slot's "3 events, …" summary
export const calendarEvents = labels => [...new Set(labels.filter(l => /(\d{1,2}:\d{2} [AP]M to \d{1,2}:\d{2} [AP]M|all day)/i.test(l)
  && !/^\d{1,2}:\d{2}/.test(l) && !/\d+ events?,/.test(l)))];

// A meeting request's row; its own time ("Thu 8/10/2026 5:30 PM - 8:00 PM") is on a card under the row, which Outlook
// draws several seconds after the list - the row's `time` is only when the invite arrived
export const isMeeting = r => /^(?:\S+ ){0,3}Meeting /.test(r.label || '');
export const meetingTime = text => String(text || '').match(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}\/\d{1,2}\/\d{4}(?: \d{1,2}:\d{2} [AP]M(?: - \d{1,2}:\d{2} [AP]M)?| \(all day\))?/)?.[0] ?? null;

// ---- in the page

// The rows the mail list has drawn now (it draws about one screen of them, newest first)
export const drawnRows = () => [...document.querySelectorAll('[role=listbox] [role=option]')].flatMap(o => {
  const convid = o.getAttribute('data-convid');
  const label = o.getAttribute('aria-label') || '';
  return convid ? [{ convid, label: label.slice(0, 400), unread: /^Unread/.test(label) || !!o.querySelector('button[aria-label="Mark as read"]'),
    time: o.querySelector('[title*="/20"]')?.getAttribute('title') }] : [];
});
// Scroll the list on by most of a screen (or back to the top); false when it can't go further
export const scrollList = toTop => {
  const lb = document.querySelector('[role=listbox]');
  const sc = lb && (lb.querySelector('.customScrollBar') || lb);
  if (!sc) return false;
  const top = sc.scrollTop;
  sc.scrollTop = toTop ? 0 : top + sc.clientHeight * 0.8;
  return sc.scrollTop !== top;
};
// What's written on these rows now, for the invites' cards
export const rowTexts = ids => Object.fromEntries(ids.map(id => [id, document.querySelector(`[role=option][data-convid="${CSS.escape(id)}"]`)?.innerText || '']));
// Every label on the page, for the calendar's events
export const pageLabels = () => [...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label'));
