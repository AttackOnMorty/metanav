# How Meta-Nav works

Meta-Nav is one page that answers **"what should I do now?"** It reads your Outlook mail and calendar, your Teams chats, GitHub and (optionally) Azure DevOps. An AI judges what's yours to do, what others owe you and what's worth knowing, ranks your to-dos by the cost of delay, and writes it all into a local page styled after Persona 5.

This document follows one refresh from start to finish, then explains each part of the page. `INSTALL.md` sets it up; `JUDGE.md` holds the exact instructions the AI follows.

```
  the hour, SYNC NOW, or metanav
                   ▼   run.mjs runs these steps
  1. Collect   collect.mjs + fetch.mjs      ~25 s, no AI
               Outlook · Calendar · Teams · GitHub · Azure DevOps  →  inputs.json
                   ▼
  2. Judge     Claude Code or Codex, JUDGE.md  ~2–10 min
               inputs + the previous run + your clicks  →  brief.json
                   ▼
  3. Render    render.mjs                    →  index.html, stamp.js, runs/<time>.json
                   ▼
  4. The page  reloads itself; your clicks go to state.json and into the next run
```

---

## 1. When it refreshes

- **On a schedule.** Meta-Nav's background service (`state.mjs`, started at login by launchd on macOS or Task Scheduler on Windows) starts a run on the hour. `run.mjs` only goes ahead on weekdays within `hours` in `config.json` (9:00 to 18:00 by default). If the computer was asleep on the hour, the run starts as soon as it wakes.
- **On demand, at any hour.** Use the **SYNC NOW** button on the page, or type `metanav` in a terminal.
- **One at a time.** A lock stops two runs overlapping. While a run works, the page shows **Syncing**.
- **Incremental.** Each run starts from the previous run's judgement. It re-checks everything that was still open, and reads only what's new since the last run. The very first run reads the last 30 days (`lookback_days`), so an ask nobody answered three weeks ago still turns up.
- **The page updates itself.** Leave the tab open. Every minute the page checks a small `stamp.js` file and reloads only when a run has written something new.

## 2. Collecting the data (no AI involved)

`collect.mjs` reads everything in about 25 seconds and writes one file, `inputs.json`. Outlook and Teams are read in a headless Chrome that has its own profile, where you signed in once.

| Source | What's read | What's never done |
| --- | --- | --- |
| **Outlook mail** | The message lists of your Inbox and the subfolders you name, plus Sent Items: sender or recipients, subject, preview, flags, time. A meeting invite also gives the meeting's own time. | No message is opened, so nothing is marked read. Notification folders you list (e.g. GitHub) are skipped. |
| **Outlook calendar** | Today's day view: each meeting's title and time. | Cancelled and declined meetings, other people's leave, and the personal blocks you list are dropped. |
| **Teams** | Teams on the web keeps recent chats in its own browser cache. Meta-Nav reads that cache: direct chats, group chats and meeting chats with something new since the last run. Where you took part, it also takes the last 30 days of history for context. | No API calls and no chat opened, so nothing is marked read. Channels aren't read. Bot and reminder chats you list are skipped. |
| **GitHub** (`gh`) | PRs waiting for your review, with their size and how long they've waited. Your open PRs: review state, CI, unresolved threads and new feedback. Your issues on the current sprint board, with body, comments, assignees, sprint end and when they were assigned to you. Where someone @mentioned you, and whether you've answered. The current state of any PR or issue the panel is already tracking. | Nothing is written to GitHub. |
| **Azure DevOps** (optional, `az`) | The same as GitHub, across your organisation: work items assigned to you that are under way, pull requests waiting on your review, your own PRs' votes, comments, build checks and conflicts, and work item discussions that @mention you. Optionally the latest release of one pipeline, stage by stage. | Nothing is written to Azure DevOps. A mention in a PR comment arrives as notification mail instead. |

If Microsoft asks you to sign in again, that source is marked failed and the page shows a red banner with a **SIGN IN** button (section 5).

## 3. Judging (the AI)

The judge — Claude Code (Opus by default) or Codex, set by `agent` and `judge_model` in `config.json` — reads the inputs, the previous run's result and your clicks. It can only read files and write its one result file: no network, no shell. It sorts everything into four lists:

| List | On the page | What goes in |
| --- | --- | --- |
| `queue` | **Target** + **Requests** | What's yours to do, ranked. |
| `waiting` | **Waiting On** | What other people owe you. |
| `highlights` | **Phan-Site** | What you'd want to know today, with nothing to do. |
| `done` | **DONE!** rows | What closed today. |

Six principles decide where things go:

1. **Ownership.** Something is yours when it's yours to deliver. That means one of these:
   - asked of you (a direct question, an @mention that asks something, an email that asks you);
   - promised by you ("I'll…", "let me check");
   - assigned to you (a review request, an issue, your sprint item under way);
   - your own PR's next step;
   - your share of a group ask.

   Being copied, greeted or tagged doesn't make it yours.
2. **Waiting.** You asked and they haven't delivered. When an ask went to several people including you, it splits: your part goes to Requests, theirs to Waiting On, and each part closes on its own.
3. **Closure.** A matter closes when its owner delivers or the asker lets it go, in any system. Examples: a reply that answers it, a PR merged or reviewed, received mail you deleted or archived, your own tick on the page. When it's unclear whether something is closed, an item already on the page stays.
4. **One matter, one item.** An email ask chased in Teams, or a PR discussed in a chat, becomes one item. All its messages are folded into one thread.
5. **Cost of delay ÷ time** orders your to-dos (next section).
6. **Only what the data says.** No guessed dates, times or outcomes. Items carried over from the previous run are judged again from scratch, not copied.

## 4. Priority: how Requests are ordered

1. **Expedite first.** Someone blocked on you right now goes on top: a PR that can't merge until you review it, or a teammate who can't continue.
2. **Then cost of delay ÷ time.** This is Smith's rule, the WSJF of product work: on one person's list, it's the order that keeps the total cost of waiting lowest.
   - **Cost** is what another day of waiting costs. It depends on how many people are affected, who they are (production or customers, then the team, then only you), and what rides on it. Waiting only adds cost where waiting itself hurts: someone's patience (more if they chase again), or a promise you made. Something nobody is waiting on gains nothing from age. A bug hurting production users costs a lot every day, even with no deadline.
   - **Time** is how long the work takes, shown as a letter, like the game's Difficulty column:

     | Letter | Takes |
     | --- | --- |
     | **D** | Minutes: a reply, an approval. |
     | **C** | Under an hour: a normal review, a short write-up. |
     | **B** | A few hours: a bug hunt, a small feature. |
     | **A** | A day or more: a big item under way. |

   - **Deadlines by slack.** Slack is the time left before a due date or sprint end, minus the time the work takes, counting today's meetings. An item with plenty of slack ranks by cost like everything else. As its slack runs out it rises, and with none left it goes on top.
   - **Today's project** (optional, `schedule` in `config.json`). If you work on one project per weekday, work for another project can wait until that project's day.
   - **Quick ones together.** Several few-minute items sit next to each other, so you can clear them in one go.
3. **Today's calendar shapes the order.**
   - Work a meeting needs moves up before that meeting.
   - A short gap before the next meeting suits a quick item; a long free stretch suits a big one.

A new item that costs something *today* is marked urgent and triggers a desktop notification. This is used sparingly.

**Every ranking is written down.** Each run stores, in `runs/<time>.json`:
- a `cost` sentence for every to-do;
- `tradeoffs`: where two rules pulled different ways, which one won and why.

The page doesn't show these. When the order looks wrong, they tell you which rule caused it.

## 5. The page, section by section

**Header.** It shows today's date and time of day, when the data was last synced, and **SYNC NOW**. A red banner appears when a source failed. When the cause is an expired sign-in, the banner has a **SIGN IN** button: it opens a Chrome window on Outlook and Teams, closes it once you're in, and refreshes.

**Target: do this now.** The top of the ranked list, as a large card. It shows:
- why it's first (the red tag);
- one sentence on what matters about it;
- buttons that start the work, such as Open PR or Reply in Teams;
- its difficulty letter in the red corner.

**TAKE IT DONE** marks it finished.

**Requests.** The rest of your to-dos, in rank order. Each row has:
- **A status on the left**, in this order of preference: `NEW!` (appeared since the last run), `UPDATE` (something happened on it), `URGENT`, `DEADLINE`. Otherwise, how long it has been yours, as `3d` or `TODAY`.
- **The title**, with one line of reason under it. Hover over a row to read both in full.
- **A short tag saying why it's ranked there**, such as "Alex is blocked" or "Sprint ends 13/10".
- **The difficulty letter**, and a ✓ to mark it done. The ⊘ that appears in a row's corner dismisses it instead: not yours, or not going to happen (the target card has a Dismiss button).

At the bottom, today's finished items stay as grey `DONE!` rows with their difficulty letter, and dismissed ones as `DROPPED`. A row you ticked yourself keeps **UNDO**. When the next run confirms what happened, it adds a note under your tick.

**Waiting On: your messages.** It's laid out like the game's IM inbox: one bar per matter and the people who owe it. Names shown dimmed have already delivered. Above each bar, its status and how long it has been quiet:
- `CHASE`: time to nudge them, because it blocks you or has gone quiet long enough;
- `NEW` or `UPDATE`: new, or something happened since the last run.

Click a bar to open it:
- **The conversation** shows the last few messages as chat bubbles. Each speaker is named, plus MAIL, TEAMS or GITHUB when the thread spans systems.
- **Send calling card** shows a drafted nudge in the conversation's own language. Edit it, then **Copy & open** copies it and opens the chat or mail where the conversation is live.
- **✓ Resolved** means you've stopped waiting.

**Phan-Site: news.** What you'd be glad to have seen today, with nothing to do: decisions and feedback on your projects, team news (leave, new starters), a social plan, a new issue about your work that isn't yours. Each post is tagged `NEW` or `UPDATE`. **Got it** hides a post; it comes back only if something new happens on it.

## 6. Your clicks

- **What gets saved.** ✓ (done), Resolved and Got it are saved by the same background service (`state.mjs`, on `127.0.0.1` only) into `state.json`. Every browser on your computer sees the same clicks.
- **Ticked means closed.** The next run treats a ticked item as closed. If something new happens on it later, it comes back.
- **Dismissed means closed by your decision.** The run won't bring it back from the same messages, and writes no done row for it. If you only disagree with how it was read ("you can test it tomorrow"), reply in the conversation instead: the next run follows the reply.
- **Deleting received mail counts as done.** Archiving it does too.

## 7. Privacy and files

- **Read-only.** Nothing is sent, opened or marked read anywhere.
- **Everything stays on your computer.** The collected mail and chats (`inputs.json`) are deleted at the end of every run.

| Where | What |
| --- | --- |
| `~/metanav/index.html` | The page. Keep it open in a tab. |
| `~/metanav/runs/` | Each run's result, including `cost` and `tradeoffs`, kept 14 days. The next run starts from the newest. |
| `~/metanav/logs/` | Each run's log, kept 7 days. `result` is the run's own summary. |
| `~/metanav/state.json` | Your clicks. |
| `~/Library/Caches/metanav/` (Windows: `%LOCALAPPDATA%\metanav\`) | Meta-Nav's own Chrome profile, with your Microsoft sign-in. |
| `~/.claude/skills/metanav/` (or `~/.agents/skills/metanav/` with Codex) | The skill: `run.mjs` (the runner), `JUDGE.md` (the judge's instructions), `config.json`, and the scripts. |

## 8. When something looks off

| Symptom | What to do |
| --- | --- |
| The order seems wrong | Open the newest file in `~/metanav/runs/` and read `tradeoffs`, and the `cost` of the items involved. They show which rule decided it. |
| A source is red | Click **SIGN IN**. If it's still red, the newest log in `~/metanav/logs/` says why. |
| Something finished is still listed | Tick it. Runs only close what the data shows, so a reply in a system Meta-Nav doesn't read won't close it. |
| Something is missing | Runs judge again from scratch each time. `metanav` refreshes now; the run's summary in the log lists what it saw. |
| Dates or times look wrong | Outlook on the web must be in English, with a day/month/year date format and a 12-hour clock. |
