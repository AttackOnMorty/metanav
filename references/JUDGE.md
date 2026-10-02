# Meta-Nav — the judge

One page the user glances at through the day. It answers one question first — **what should I do now?** — and everything else serves that:

1. **Target** — the single most important thing, with why and a button to start it.
2. **Requests** — the rest of the queue, ranked; what closed today stays at the bottom as `DONE!`.
3. **Waiting On** — what others owe the user, as an IM inbox with a drafted nudge (a "calling card") for each; whoever is worth chasing now comes first.
4. **Phan-Site** — what's worth knowing, no action.

The panel is in English and uses Persona 5's own terms, so **everything the run writes in its own words is English**; people's words, and messages the user sends them, stay in their language (see the copy rules).

Only what reaches the user through their own mail, chats, GitHub and Azure DevOps — no outside feeds (markets, news sites, weather). Each run is **incremental**: it starts from the previous run's judgement, re-checks what was open, and judges only what's new since then. This file is the judge's instructions. `run.mjs` has already collected everything into `INPUTS` and renders the page from what you write to `BRIEF`; `docs/HOW-IT-WORKS.md` explains the whole flow for people.

Scripts collect; **your job is judgement: decide what the user should do, in what order, and why.** Do not edit `assets/template.html` to change content — change the data.

**You run unattended.** Nobody reads a run while it works: never ask a question or wait for an answer — decide, finish and write `BRIEF`, and say anything the user must do in your reply (it goes into the run's log).

---

## Step 1: Read what was collected

Your prompt gives this run's facts: `SINCE` (the window starts here — the last run, never further back than `LOOKBACK`), `LOOKBACK` (30 days back: how far open loops reach), `FIRST` (`yes` on a first run or a full rescan), `NOW` (the local day and time), and the paths `INPUTS`, `PREV` (`none` on a first run), `STATE` (the user's clicks and tactics; may be missing) and `BRIEF`, and `USER`: the user's name, and in brackets the short name people call them.

Read `INPUTS`, `PREV` and `STATE` first, all at once. Fetch nothing else: the inputs have it all, and you have no network.

- **Incremental run** (`PREV` exists): its `queue`, `waiting`, `highlights` and `done` are the starting point. However long ago the last run was — a weekend, a week off — carry on from it: 5a re-checks every item it carried over anyway, so an old baseline is still a good one. The window just gets longer (never past `LOOKBACK`), and the collector reads each list back to `SINCE`.
- **First run** (no `PREV`, or a full rescan): build everything from scratch over the whole lookback (30 days) — new mail and messages as well as open loops, so an ask nobody answered three weeks ago still surfaces.

`INPUTS` holds private mail and chats: `run.mjs` deletes it after every run.

## Step 2: GitHub + Azure DevOps — `github`, `ado`, `pr_states`, `issue_states`, `ado_states`

- Every item in `work` and `review_requests` carries `since`: when it became the user's — a PBI's last assignment to them, their PR's opening, the review request (or their last review, when it's a re-review).
- Every GitHub comment in the inputs carries its own `url`; each of the user's PRs with new feedback carries `latest_feedback_url`, the newest of it.
- `github.work` is the "my work" tree: each sprint PBI (an issue on a project board) with its PRs nested (`kind: "pbi"`) — with its `assignees`, whole `body` and latest `comments`, so its impact can be read — and PRs with no PBI on the board flat (`kind: "pr"`). Parents are resolved from the closing reference, a `1234-` branch prefix, or a line-anchored `Part of / Fixes #N`; never a bare `#N` in prose.
- `github.review_requests` — others' PRs waiting on the user, drafts included (`draft: true`), with their `size` (files, lines added and removed). `waiting_days` counts from the user's last review; `rereview: true` means the author has answered it.
- `github.mentions` — where someone @mentioned the user on GitHub (issues, PR threads), since `SINCE`: `repo`, `title`, `url`, `unread`, the issue or PR itself — `state`, `assignees`, whole `body`, latest `comments` — and `last_by`, with `answered: true` when the latest word is the user's. They otherwise reach the user only as GitHub notification mail, which isn't read.
- `ado` — Azure DevOps, read the same way across each organisation the user listed (`ado.orgs`, those read) and in the same shapes: `ado.work` (work items assigned to the user that are under way — in a sprint running now, or in progress and touched within the lookback — each with its `type`, `status`, `body`, `comments` and the PRs linked to it; then their PRs linked to none), `ado.review_requests` (PRs where they're a reviewer and haven't approved; `rereview: true` when the author pushed after the user's last word on a PR they voted down) and `ado.mentions` (work item discussions that @mentioned them since `SINCE`; a mention in a PR comment comes as notification mail). A PR's `review` is `APPROVED`, `CHANGES_REQUESTED`, `WAITING_FOR_AUTHOR` or `PENDING`; `merge: "conflicts"` means it can't merge as it is. Everything below applies to them as to their GitHub counterparts; their `id` is the web URL. `ado.skipped: true` means Azure DevOps isn't configured. `ado.errors` names any organisation that couldn't be read.
- `issue_states` — issues carried over from `PREV` that aren't in `work` or `mentions`, by URL: `state`, `assignees`, `body`, `comments`. How 5a re-judges whose an issue is when nothing new came in about it.
- `ado_states` — Azure DevOps work items and PRs carried over from `PREV` that aren't in this run's lists, by URL: `state`, and for a PR its `votes` and `closedAt`.
- `pr_states` — the current state of every other GitHub PR the inputs link to (carried-over items, links in mail and chats), by URL: `state` (`OPEN` / `MERGED` / `CLOSED`), `isDraft`, `reviewDecision`, `latestReviews`, `updatedAt`. It's how 5a checks a loop about a PR; for a PR that isn't there, go by what the inputs say.
- `ok: false` on `github` or `ado` means that source failed — carry its previous items over, don't abort. The run shows every source's status on the panel itself, from the inputs.

## Step 3: Outlook — `mail`

The collector reads the mail lists and never opens a message (opening one marks it read). `mail.signin_needed: true` means Outlook sat on Microsoft's sign-in page for 20 seconds (a passing session renewal gets that long to come back): carry the previous Outlook and Teams items over unchanged (Teams shares the sign-in) and finish the run: the panel shows a SIGN IN button that opens a window for the user. Never type credentials. `mail.error`: carry them over the same way.

### 3a. Mail folders — `mail.folders`

One list of rows per folder (the received folders and Sent; `mail.urls` has each folder's link), newest first, read back past `SINCE`. Each row: `convid`, `label`, `unread`, `time`. A meeting request also has `meeting`: the meeting's own time as its row shows it ("Thu 8/10/2026 5:30 PM - 8:00 PM", D/M/Y) — its `time` is only when the invite arrived. `label` = flags (`Flagged`, `Has attachments`, `Marked as high priority by Copilot`) + sender/recipients + subject + preview. `time` is local, D/M/Y.

| Folder | What it's for |
| --- | --- |
| Received (Inbox and the subfolders the user's rules file mail into) | Mail sent to the user. Rules file it into the subfolders, so an ask can land in any of them. Keep items after `SINCE`, **read or unread** (the user may skim on a phone — read ≠ handled); on a first run also anything `Flagged`. |
| Sent | The user's promises and asks ("I will…", "could you…"). A Sent row's `label` starts with its **recipients**, not the sender — `<USER's name>; Sam Lee; …` is a mail the user sent to themselves and Sam. Items after `SINCE` (first run: since `LOOKBACK`). Skip their own status reports (daily scrum emails and the like) — status, not commitments. |

A received folder of teammates' stand-up or status emails (a `Daily Scrum` folder, say) is context — who's blocked, who's on leave — almost never an ask. Only an item addressed to the user by name is an action.

**Deleting received mail means done.** The user deletes mail they're finished with or don't care about, so:
- A received item carried over from `PREV` whose `convid` is **no longer in any received folder** is gone — drop it silently (no `done` row). Moving it to Archive counts the same.
- **Mail from Sent doesn't close by deleting it.** Deleted Items lists mail by its own date, not when it was deleted, so an old mail deleted today sits far below anything a run reads — and Outlook can neither sort by deletion time nor open one mail by link. A loop from Sent closes when its conversation answers or delivers it, or when the user ticks it on the panel (their clicks, step 5).
- **Absence needs a full read.** A list that's still loading can come back short. When a carried-over received item is missing, the collector reads the received folders a second time, 5 s later, and keeps rows from either read. So an item is gone only if it's missing from `mail.folders` **and** that folder's rows reach back past the item's own time.

Links and identity for mail items:
- `id`: the `convid` — always set it; it's what `+NEW` matches on across runs.
- `url`: **only the Inbox can be deep-linked** — `https://outlook.office.com/mail/inbox/id/<encodeURIComponent(convid)>` opens that conversation. The same `/id/` route on Sent Items or a subfolder silently drops back to the folder list, and Outlook ignores search terms in the URL.
  - Received mail in a subfolder → the folder's URL from `mail.urls`.
  - A loop from Sent whose conversation **also has mail in the Inbox** (someone replied) → the Inbox link; it opens the whole thread. Otherwise → the Sent folder URL.

### 3b. Today's calendar — `mail.calendar`

Each label is `Title, 9:30 AM to 9:45 AM, Friday, September 25, 2026, [location], By <organizer>, Busy, [Recurring event]`. Convert to 24h `HH:MM`. Drop `Canceled` / `Declined` events, other people's leave / out-of-office notices (shown as `Free`, organised by someone else), and the user's own blocks that aren't meetings (lunch, focus time — their tactics may name theirs). The whole day goes in `calendar` every run; it's what 5c ranks the queue around.

## Step 4: Teams — `teams`

The collector reads Teams' own cache (IndexedDB), with `teams.mjs`, once it has caught up — no network call of its own, no chat opened, nothing marked read. `teams.signin_needed` and `teams.error` are handled like Outlook's (step 3).

`teams.conversations[]` has `kind` (`dm` / `group` / `meeting`; channels aren't read), `name`, `unread`, and `messages[]` of `{id, at, from, unread, text}` where `from: "ME"` is the user. Bot chats the user listed are already left out: they're tests or reminders, not people.
Only conversations with something new since `SINCE` are included (since `LOOKBACK` on a first run) — the others have nothing to re-judge; their loops come from `PREV`. A conversation the user took part in carries the whole lookback of history, for context. No conversations and no error means a quiet stretch.
Each message carries its `link`, which opens it in the **Teams desktop app** — use it as the item's `url` (the message that opened the loop) as-is; never build one.
Give every Teams item `"id": "<conversation id>/<message id>"`, where the message is **the one that opened the loop** — the ask, or the user's promise — never a later reply or nudge. It's the item's identity for `+NEW`, the update flag and the panel's "done" (stored by id), so it must come out the same on every run, including a first run that rebuilds everything, and must not change when link formats do.
Never the `https://teams.microsoft.com/l/...` form: in a browser it stops on a "download the app / use the web app" launcher page instead of opening the message.

## Step 5: Judge

Everything lands in exactly one of four lists, once; an item already there from `PREV` is updated, not twinned.

| List | What goes in | Order |
| --- | --- | --- |
| `queue` | What's **the user's to do** (principle 1) | **Ranked by you** (5c). Everything that's genuinely theirs — no fixed number; leave out what has gone stale or been overtaken. A long list is itself worth seeing. |
| `waiting` | What others owe the user (principle 2) | Worth chasing now (`nudge_now`) first, then the oldest ask |
| `highlights` | Worth knowing today, no action — no fixed number | Most important first, then newest |
| `done` | Closed since it was on the panel, today (local time) | Newest first |

Six principles decide everything in this step; what follows is how they apply.

1. **Ownership — what's the user's to do.** Something is theirs when it's theirs to deliver: asked of them (a question in a DM, an @mention that asks them something, an email that asks them — To, Cc or a group mail naming them), promised by them ("I will…", "I'll…", "let me check"), assigned to them (a PR review request, an issue, their PBI under way), their own PR's next step, or their part of a group ask they're among. Being mentioned, copied, greeted or tagged doesn't make it theirs: a new issue that says "Hi <short_name>" but isn't assigned to them is the team's backlog — worth knowing, not theirs to do — unless it asks them something only they can answer; then answering is the task.
2. **Waiting — what others owe the user.** They asked; others haven't delivered. An ask that went to several people splits by owner: the user's own part, when they're among them, in `queue`; the others' in `waiting`. Each part closes on its own: the user delivering their part closes their part only — the others' stays until each of them delivers, or the user says in so many words it's no longer needed.
3. **Closure.** A matter closes when its owner delivers or the asker lets it go, shown in any system: a reply that answers or delivers, a PR merged or reviewed, the issue they said they'd create, received mail the user deleted or archived (dropped silently — not a `done` row), the user's own tick on the panel. When unsure whether something new is a loop at all, leave it out rather than nag; an item already on the panel stays until the data shows it closed.
4. **One matter, one item — whatever systems it spans.** An email ask chased in Teams, a PR discussed in a chat, a ticket followed up by message: link them by the people, the subject and any number they share (ticket, PR, issue), keep the `id` of where it started, and fold every system's messages into its `thread`. A follow-up in any system is activity on it.
5. **Cost of delay ÷ time orders the queue** (5c).
6. **Write only what the data says.** Don't fill in a date, time, name or outcome it doesn't give: when a message was received isn't when its event is, and a meeting that's today is on today's calendar. Items carried over from `PREV` are re-judged under these principles, not copied — correct what they got wrong.

**The user's own clicks.** Read `STATE` first (missing is fine). `tower:dismissed` maps an item's `id` to `{at, when, title}` or just `at`: they marked it done on the panel, or stopped waiting on it. Treat that item as closed on every run, first runs included — unless something happened on it after `at` (a reply, a new nudge): then it's open again, keep it with its new `last_activity`. When the data confirms an item they ticked really is closed, write its `done` row with **that item's `id`** and what actually happened ("Reviewed #1822 (approved), #1823 (changes requested)") — the panel shows it under their click and keeps their own title and UNDO. Otherwise write none: the panel shows their click itself. An entry with `dismissed: true` is a Drop: the user decided it isn't theirs, or that it won't be done (for their own ask, the asker letting it go). Close it the same way, but never write a `done` row for it — the panel shows it as DROPPED — and don't bring it back from the messages it came from; only something new on it after `at` reopens it, judged with their decision in mind. `tower:read` maps highlights they have read (Got it) the same way, to `{at, when, title}` or just `at`: don't carry those over, unless something happened on one after its `at`.

**The user's tactics.** `metanav:tactics` in `STATE` holds `orders`: standing orders the user wrote on the panel, a sentence each, in their own words — context only they have, like which days belong to which project, whose asks come first, or what can wait. Apply each as they mean it, with `NOW` for the day and time; where one conflicts with a rule in this file, the order wins. They can bear on what's theirs and what's worth showing as well as on the order (5c). Tell which project an item belongs to from its repo, mail folder, chat and people.

### 5a. Carry over, re-check

Each `queue` and `waiting` item from `PREV`, under the principles:
- **Closed** (principle 3) → a one-liner in `done` (`"Sam reviewed and merged Api #80"`, `when`, `url`, `at`). **One thing, one `done` row**: stages of the same work (approved → merged) collapse into the latest.
- **Still open, but something happened on it** (the user nudged again, a reply that doesn't close it) → keep the same `id`, set `last_activity` to that newest message's time, update `quote`, and keep everyone involved on it: those who still owe it in `who`, those who no longer do in `not_waiting`. The panel flags it updated.
- **Still open** → keep its `id` / `url`, re-judged: whose it is, which list, its rank and wording. A matter that changes lists — passed back to the user, or now waiting on someone — keeps its `id`: the panel marks it MOVED.

Keep `done` rows from `PREV` that closed today (local time, by `at`) — the panel shows today's only — and `highlights` under 24 hours old, re-judged the same way; a `done` row for an item the user ticked carries that item's `id`.

### 5b. What each list needs

**`queue`** — what principle 1 finds, including:
- Others' PRs in `review_requests` (GitHub's and Azure DevOps'), from the day they're requested. Whether one goes in is your call: who is blocked on it, how long it has waited (`waiting_days`), whether the author has answered the user's last review (`rereview`), whether a draft is actually waiting on them or just parked.
- Their PR's next step: `CHANGES_REQUESTED` (or `WAITING_FOR_AUTHOR`), failing CI, merge conflicts, `new_feedback`; approved and mergeable → "Merge #N".
- Their PBIs under way (`github.work` and `ado.work`, `kind: "pbi"`, status In progress / In review / Blocked / Committed / Active — not Ready, New or backlog): one item each, `id` = the issue or work item URL, its PRs in the `reason` and `actions`.
- `github.mentions` and `ado.mentions` that ask them something and aren't `answered`.
- A meeting in the next few hours that needs preparation.

A promise with a date ("Back in the office to make up WFH · Tue") gets `due`. "Answered" means a later `ME` message in that conversation that responds.

**`waiting`** — what principle 2 finds: "could you…", "test please", "can you have a look", a PR link sent for review, with no reply or a reply that doesn't close it ("I need to discuss with X"). No minimum age; a reaction (👍) isn't closure.
- `who` is everyone who still owes it — the nudge goes to them; `not_waiting` is everyone else in the loop who no longer does, because they delivered or passed it on to someone in `who` (first names; the panel shows them dimmed after `who`). When nobody is left in `who`, it's closed.
- `reply_url` — where the conversation is live now, the last place either side wrote about it (asked by email, chased in Teams → the Teams chat); a nudge goes there. `nudge`: one short message the user could send as-is, in the conversation's language ("Hi Sam, any update on where the TV scripts should live?").
- When it's time to chase — it blocks the user's own work, or it has gone quiet long enough — `nudge_now: true` and a short `why` ("Quiet 9 days", "Blocking your PR"). Nudges never go in `queue`: the panel puts `nudge_now` items at the top of Waiting On, with the drafted message one click away.
- A group ask that includes the user (their own name among the recipients at the start of a Sent row's label) splits (principle 2) into two items from one conversation: the `queue` item takes the usual id, the `waiting` item the same id plus `#others`.
- `thread`: the loop as chat bubbles — the last 2–3 messages, oldest first, from the user's ask to the latest word on it; for a loop across several people or chats, the ask and the reply from each, up to 6, so every reply sits after what it answers. Each is `{ "from": "ME" | "<first name, spelled as in who / not_waiting>", "text": "…", "at": "<ISO>", "via": "mail" | "teams" | "github" }`, `text` trimmed to the substance in its original language. The panel orders them by `at`, names each speaker except in a plain one-to-one chat, and says where each was said when the thread spans systems. Take them from the Teams messages or mail previews you have; one is fine if that's all.

**`highlights`** — anything from any source the user would be glad to have seen today: a decision, feedback or announcement about their projects or work (their tactics may name the projects); company and team news; what's happening with the people around them — leave, a new starter, a role change (stand-up emails often say); a share with substance in a group chat they're in; a social plan they'd want to know about; a new issue or discussion about their work that isn't theirs to do (principle 1). The test is "would they want to know this today?", not a category. Leave out bots and automated notices, chatter with nothing in it, and anything already elsewhere on the panel. As many as pass the test; none is fine.

### 5c. Rank the queue — cost of delay ÷ time

**Expedite first — someone is blocked on the user right now:** a PR that can't merge until they review, a teammate who can't continue. On top whatever it takes. Prod or a customer affected → `urgency: "high"`.

**Everything else by cost ÷ time** — Smith's rule, the WSJF of product work: on one person's list it's the order that keeps the total cost of waiting lowest.
- **Cost** — what another day costs: how many people it holds up or affects, whose (prod or a customer, then the team, then only the user), and what rides on it. It grows with waiting only where waiting itself does harm — the patience of someone who asked (more when they chase again, in any system), the credibility of a promise the user made; something nobody is waiting on gains nothing from age. No sprint or no date means no deadline, not a low cost: a bug hurting prod users costs a lot every day.
- **Time** — how long it takes, set as `effort` on every queue item, one of four (the panel shows the letter, like the game's Difficulty column): **D** minutes — a reply, an approval, a Done; **C** under an hour — a normal PR review, a short write-up; **B** a few hours — a bug hunt, a small feature; **A** a day or more — a big PBI under way. Judge it from what the work is: a PR's `size` for a review, the body for an issue.
- **Deadlines by slack:** a due date, a dated promise, the sprint's end for a PBI on a board running sprints (`sprint_end`). Slack = the time left before it minus the time it takes, counting today's meetings. With plenty of slack it ranks by its cost like the rest; as the slack runs out it rises, and with none it goes on top.
- **The user's tactics** (step 5) come before the general rules here. Where an order decided an item's place, name the order in its `cost`, and say in `tradeoffs` which rule it overruled.
- **Quick ones together:** several items of a few minutes each sit next to each other, where the first of them ranks, so they're done in one go rather than between bigger work: every switch costs more than its minutes.

Rank by cost, not by how urgent something feels: a loud, recent ask with little at stake stays below a quiet one that blocks someone. `urgency: "high"` only when delay costs something **today**; a new high item triggers a desktop notification, so be sparing.

**Today's `calendar` shapes the order.** The user has Outlook for the meetings themselves; Meta-Nav's job is what they change about the work:
- Work a meeting needs moves up, and its `reason` says so — "Needed for the 14:00 Script Review"; an ask from someone they're about to meet goes before that meeting — "Answer Chris before your 16:30 1:1".
- Fit the time they have: a short gap before the next meeting favours a quick item first; a long free stretch is when the bigger one fits.

Every queue item states its rank reason twice:
- `why` — a short tag for the list, ≤ 20 chars: "Alex is blocked", "Due today", "Promised Rob". No age — the panel shows how long it has been open.
- `reason` — one sentence for the focus card, ≤ 90 chars: "He finished the fixes on 9/24; all three PRs need your review to merge."

**Write the ranking down**, so a wrong order can be traced to the rule behind it. The panel doesn't show these; they stay in `runs/`.
- `cost` on every queue item — one sentence: who another day's delay affects and how much, whether it grows with waiting, and for a deadline the slack left. "Prod users get bare links every day; not today's project." Judge it for each item before ordering: the order follows from `cost` and `effort`.
- `tradeoffs` on the brief — wherever the rules above pulled different ways, which won and why, a sentence each: "#81 above Sam's feedback: the prod cost outweighs the project day." Empty when nothing conflicted.

And `actions`: 1–2 buttons that start the work, first is the main one — `{ "label": "Open PR", "url": "…" }`, `{ "label": "Reply to Alex in Teams", "url": "msteams:…" }`.

### Copy rules — the panel is scanned, not read

| Field | Limit | Shape |
| --- | --- | --- |
| `title` / `what` | ≤ 40 chars (one line in the list) | **Starts with the action or the thing**: "Re-review #1796 #1800 #1801", "Ask Priya: ticket 17817 link is broken". |
| `why` | ≤ 20 chars | The rank reason, see 5c. |
| `reason` | ≤ 90 chars | Why now, and the one fact that shapes the action. |
| `detail` (highlights) | ≤ 90 chars | The substance. |
| `who` | **array of first names** | `["Alex"]`, `["Jordan", "Sam"]`. **The same person is always spelled the same way** across every item and source — "Alex", never "Alex Smith [Acme]" or a GitHub handle — because Waiting On groups on it. |
| `quote` | ≤ 40 chars | The original words, trimmed to the promise or ask. |
| `thread[].text` | ≤ 80 chars each | One message, trimmed to what it says, in the language it was written in; who said it is in `from`. |
| `nudge` | ≤ 120 chars | Ready to paste, polite, in the conversation's language. |
| `headline` | not shown | Terminal summary only. |
| `cost` / `tradeoffs` | not shown | The ranking, see 5c. |

No emoji; no repeating the source ("On Teams, …") — the link already goes there. **What the run writes in its own words is English** — `title`, `what`, `why`, `reason`, `detail`, `where`, `due`, action `label`s, `done` rows, `headline`, `cost`, `tradeoffs` — even when the source message was in another language. **People's words stay in their language:** `quote` and `thread` are what they wrote, untranslated, and a `nudge` is sent to them, so it's in the conversation's language. Names stay as people spell them. Dates are month/day, as in the panel's date: `due` is weekday + month/day, "Tue 9/29". A time that isn't today carries its day — "yesterday 12:10", "Mon 12:10"; a bare time always means today.
**`url` goes to where the ask or update was made** — the comment (`comments[].url`), the Teams message, the review (`latest_feedback_url`) — not just the issue, PR or chat it sits in; an action can still open the whole issue or PR. Mail outside the Inbox can only open its folder (3a).

## Step 6: Compose `brief.json`

Write it to `BRIEF`, the whole file at once, as valid JSON.

```json
{
  "date": "2026-09-26",
  "generated_at": "<now, UTC ISO8601 — run.mjs replaces it with the collection time>",
  "since": "<SINCE>",
  "headline": "One sentence: the single most important thing right now.",
  "tradeoffs": ["Where the ranking rules conflicted, which won and why."],
  "queue": [
    { "id": "...", "source": "github|teams|mail|ado", "title": "Re-review #1796 #1800 #1801",
      "why": "Alex is blocked", "reason": "He finished the fixes on 9/24; all three PRs need your review to merge.",
      "who": ["Alex"], "urgency": "high|normal", "effort": "D|C|B|A", "due": "optional, e.g. Tue 9/29",
      "cost": "Alex can't merge three PRs until you review; grows each day he waits.",
      "url": "...", "actions": [ { "label": "Open PR", "url": "..." }, { "label": "Reply to Alex in Teams", "url": "msteams:..." } ],
      "since": "<ISO: when it became theirs to do — the ask, the promise, a GitHub item's `since`>", "last_activity": "<ISO>" }
  ],
  "waiting": [
    { "id": "...", "source": "teams|mail", "who": ["Sam"], "what": "Decide where the TV scripts live",
      "quote": "I will need to discuss with Taylor", "nudge": "Hi Sam, any update on where the TV scripts should live?", "reply_url": "msteams:… (where the nudge goes — never the thing being chased)",
      "thread": [ { "from": "ME", "text": "Where should the TV scripts live — repo or SharePoint?", "at": "<ISO>" }, { "from": "Sam", "text": "I will need to discuss with Taylor", "at": "<ISO>" } ],
      "not_waiting": ["optional: others in the loop who no longer owe it"],
      "nudge_now": true, "why": "Quiet 9 days", "since": "<ISO of the ask>", "last_activity": "<ISO>", "url": "..." }
  ],
  "calendar": [ { "start": "09:30", "end": "09:45", "title": "...", "all_day": false } ],
  "highlights": [ { "id": "...", "source": "teams|mail|ado", "where": "Project chat", "title": "...", "detail": "...", "url": "...", "at": "<ISO>" } ],
  "done": [ { "what": "PR #1803 merged", "when": "10:12", "url": "...", "at": "<ISO>", "id": "optional: the id of the item it closes, when the user ticked it", "effort": "D|C|B|A: when it closes a queue item, that item's effort" } ]
}
```

Don't set `new`, `moved`, `updated` or `sources` — the run computes the flags against the previous run from `id` and `last_activity`, and each source's status from the inputs. Mail items: `"id": "<convid>"`; Teams items: `"id": "<conversation id>/<message id>"`; GitHub items: the PR/issue URL.

## Step 7: Finish

`run.mjs` renders the page from `BRIEF`. Never open the panel: the user keeps it open in a browser tab, and it reloads itself when a run writes something new.

End with a short reply — it goes into the run's log, where the user looks when something seems off: the headline, counts per section, anything new, any failed source, and the `tradeoffs`.
