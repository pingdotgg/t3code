# Thread Board: vision

> Fork-only document (cogwal/t3code). It is the source of truth for the Thread Board's
> end goal. Every agent working in this fork reads it before doing board work.
> When the developer makes a decision, record it in the [Decision log](#decision-log)
> and rewrite the affected sections. Don't add a second, conflicting account.

## North star

A **live board of every thread**. It answers "what needs me, what is running, what is
ready" at a glance, so the developer can steer many agents without opening threads one
by one.

Each thread is a **card**, and cards **move between lanes on their own** as thread state
changes. A card is big enough to carry a very short status: what the agent is doing, what
it is asking, and what is ready to review. The developer can deal with most cards right
from the board and jump into the full thread only when needed.

## Why

T3 Code's sidebar is a list. Once several agents run in parallel, finding the one waiting
on an approval, the one that finished, and the one that is stuck means clicking through
threads. The board turns that into one view you can scan.

## Principles

1. **Summary first, not live chat.** A card shows a short status, not a timeline.
   Upstream declined a board of live chat cards (pingdotgg/t3code#9046, Sep 2026).
   Staying light is what sets this board apart from that one.
2. **Lanes come from state.** A thread moves because its state changed, never because
   someone dragged it. No second source of truth for status.
3. **Triage without leaving the board.** The usual actions (approve, answer a question,
   send a follow-up, open the PR) work from the board itself.
4. **Reuse what exists.** Read thread state through `packages/client-runtime`. Add server
   work only where the board truly needs it (for example, generating summaries).
5. **Performance is a feature.** Many live cards must not mean heavy websocket traffic or
   lots of re-rendering. Follow upstream AGENTS.md and
   `docs/internals/16_performance-regressions.md`.
6. **Isolated and switchable.** The board sits behind a Labs toggle and touches upstream
   code as little as possible, so pulling upstream changes stays cheap and the board could
   be proposed upstream later.
7. **Smallest model that works** (Theo's note in AGENTS.md applies here too).

## Scope

**In (first version):** web and desktop; a board covering every project with a project
filter; lanes set automatically; cards with a short status; a peek panel for triage;
navigation into the full thread.

**Out (for now):** workflow engines or lanes that drive agents (that was #3135's scope);
creating tasks from the board; manual lane overrides; mobile. Mobile is an open question,
not a rejection.

## UX draft (to iterate on)

The clickable prototype lives at [prototype/index.html](prototype/index.html) (open it in a
browser; fake data, no build). Its "Prototype" panel toggles the variants that are still open.

- **Entry point:** a board icon in the sidebar footer, with a Needs-you count.
- **Board layout (being tried):** **full screen**, with a "Back" button and its own
  **New thread** buttons (header, and one per swimlane). A new thread starts from the left
  panel and its card arrives under *Working*; you stay on the board. The earlier layout, a page
  **beside the sidebar** like Pull requests (footer icons become "Back", new threads start from
  the sidebar), stays a prototype toggle until this is settled.
- **Layout:** one **swimlane per project** (rows, in sidebar order, collapsible, hidden when
  empty), crossed with three **lanes** (columns): *Needs you* → *Working* → *Done*.
  A project filter and a text filter sit in the header.
- **Lanes:** *Needs you* holds approvals, questions, failed turns, usage limits and PRs with
  failing checks, oldest wait first. *Working* holds setting up, working and waiting on
  subagents. *Done* holds finished turns (diff or PR), the same word the sidebar uses. Other
  lanes sort newest first. A merged or settled thread leaves the board but stays in the
  sidebar, and it comes back with Reopen (thread view, or Undo right after settling).
- **Card:** status (icon, label, working time) and time since last activity; the title; a grey
  line from thread state, only when it adds something (the running command or tool call, or the
  last assistant message of a finished turn); for Needs-you cards, the request itself with
  **quick actions** (Approve/Deny, answer options, Retry, switch model, Fix checks/Open PR); PR,
  diff and queued chips. Project, branch and model stay off the card (the swimlane and the peek
  carry them).
- **Click:** opens the **peek**, a panel on the **left** of the lanes with the popover's
  floating look, pushing the lanes aside: summary, pending request, PR checks, changed files,
  recent activity, actions (Stop, Create/Open PR, Settle) and a composer. You stay on the board.
  A follow-up sent while the agent runs is queued.
- **Ctrl-click (Cmd-click on macOS):** navigates to the full thread view. The peek also has
  "Open thread", and the thread view links back to the board.
- **Keyboard:** arrows move between cards (up/down walk a lane across projects), Enter peeks,
  Mod+Enter opens, Esc closes the panel, Mod+Shift+B toggles the board.
- **Live:** cards slide to their new lane once (short FLIP transition) and flash once.
  Nothing animates continuously.

## Open questions

1. Full screen with its own New thread buttons, or beside the sidebar? (Prototype toggle.)
2. Should the peek push the lanes aside (current) or float over them? Undecided; push for now.
3. Is a state-built grey line enough, or will finished threads need an LLM summary later?
4. Swimlane order: sidebar order (current), or projects with Needs-you cards first?
5. Where snoozed threads go (hidden, or a lane state of their own).
6. Later, the board could move into upstream's pane system (#28839–#28845, #28845 "tabs in
   split panes") once that lands.
7. Mobile: later, or never?

## Data the board needs (learned from the prototype, feeds phase 2)

Short list; rewrite entries as phase 2 answers them.

- **Lane = turn state + work state.** The sidebar's `resolveSidebarRowStatus`
  (`apps/web/src/components/Sidebar.logic.ts`) covers the turn: approval, input, request,
  preparing, working, waiting (on subagents), failed, limited, ready. On top of that, PR state
  decides lanes (failing checks → *Needs you*), and "merged or settled" (`settledOverride`)
  decides whether a thread is on the board at all.
- **Pending request content, not just a flag.** The "Asked:" line and the peek need the
  approval's command and reason, the question and its options, the failure message, and the
  usage limit's reset time plus a model to switch to.
- **PR and checks per thread.** Number, state (open, merged), checks running (x of n),
  passed, or failing with the failing check names (the "Fix checks" quick action sends them). Upstream already links PRs to threads; check
  whether check status is available without one subscription per card.
- **The grey line, from thread state.** Running: the current command or tool call. Finished:
  an excerpt of the last assistant message. Waiting cards show the request instead.
- **Diff stats of the settled turn** (+/−, file list for the peek).
- **Timestamps:** last activity (sorting, "11m"), turn start (working duration), and when the
  thread entered its lane (Needs you is a queue, oldest first).
- **Origin and relations:** started by a scheduled task, waiting on N subagents, queued
  follow-ups. Provider and model only for the peek.
- **Summary-level data for every thread, all projects.** The sidebar leases row subscriptions
  (`useSidebarRowSubscriptionLease`); the board must not pull full thread detail per card.

## Decision log

Add new entries at the bottom: date, decision, reason.

- **2026-11-24** Build in a fork (`cogwal/t3code`), and maybe propose it upstream later.
  Reason: upstream closed earlier board PRs (#9046, #3135), so building first and
  proposing with a demo has the best odds.
- **2026-11-24** Build on upstream `main`, not on the redesign stack (#28839–#28845).
  Reason: that stack is unmerged, marked DO NOT MERGE, and changes daily. Keep the board
  self-contained so it can move into the pane system later.
- **2026-11-24** Keep project context in this file plus a pointer at the top of
  `AGENTS.md`, under the fork-only `fork/` folder.
- **2026-11-24** Prototype the UX with fake data before changing app code.
- **2026-11-25** The board is a page next to the sidebar, like Pull requests, not an overlay.
  Reason: the thread list stays in reach, so new threads start the usual way from the sidebar.
- **2026-11-25** No *Done* lane; merged or settled threads leave the board (sidebar keeps them,
  Reopen brings them back). Reason: the lane added nothing and cost horizontal space.
- **2026-11-25** Swimlanes per project crossed with the lanes. Reason: groups related threads.
- **2026-11-25** Failed turns and PRs with failing checks go in *Needs you*.
- **2026-11-25** Needs-you cards get quick actions; deeper triage stays in the peek.
- **2026-11-25** Leaner cards: waiting cards drop the grey line (the status and the request say
  enough); project, branch and model leave the card.
- **2026-11-25** The peek is a side panel with the popover's floating look.
- **2026-11-25** Sorting: *Needs you* oldest wait first, other lanes newest first.
- **2026-11-25** The peek moves to the left of the lanes; it keeps pushing them aside for now.
- **2026-11-25** Entry point: the board icon in the sidebar footer.
- **2026-11-25** The grey line comes from thread state; no LLM summary.
- **2026-11-25** The third lane is called *Done*, matching the sidebar's word for a finished turn.
- **2026-11-25** Trying a full-screen board with its own New thread buttons, after seeing the
  beside-the-sidebar page. Reason: start threads without leaving the board.

## Prior art (upstream, all closed)

- #9046: board view of simultaneous live chats; maintainers declined it "in its current
  form".
- #3135 / #3032: Workflow Boards, kanban lanes that drive agents.
- #7091: flexible live session board (beejsbj's fork).
- #3170: `/dashboard` issues view joining PRs with worktrees and threads.

Read these before designing something they already tried.

## Fork workflow

- Remotes: `origin` = cogwal/t3code (push here); `upstream` = pingdotgg/t3code (fetch
  only, push disabled).
- Pull upstream changes: `git fetch upstream && git merge upstream/main` on `main`. Do
  this often; upstream moves several times a day.
- Board work: feature branches off `main`, merged into the fork's `main`.
- Upstreaming later: branch from `upstream/main` and cherry-pick the board commits,
  leaving out `fork/` and the pointer block in `AGENTS.md`.
