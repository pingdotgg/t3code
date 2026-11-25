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
   work only where the board truly needs data the client can't get today.
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
creating tasks from the board; manual lane overrides; LLM-generated summaries; moving into
upstream's pane system; mobile (ignored for now).

## UX draft (to iterate on)

The clickable prototype lives at [prototype/index.html](prototype/index.html) (open it in a
browser; fake data, no build). It is the reference for phase 3; its "Prototype" panel only
drives the fake live simulation and the theme.

- **Entry point:** a board icon in the sidebar footer, with a Needs-you count.
- **Board layout:** **full screen**; the sidebar hides while the board is open. Top left, where
  the sidebar keeps them on the main page, sit Back (to the last thread), **New thread** and
  search, lined up with the left panel. New thread opens in that panel with a project picker;
  the new card arrives under _Working_ and you stay on the board.
- **Layout:** one **swimlane per project** (rows; projects with Needs-you cards first, then
  sidebar order; collapsible; hidden when empty), crossed with three **lanes** (columns): _Needs you_ → _Working_ → _Done_.
  A project filter and a text filter sit in the header.
- **Lanes:** _Needs you_ holds approvals, questions, failed turns, usage limits and PRs with
  failing checks, oldest wait first. _Working_ holds setting up, working and waiting on
  subagents. _Done_ holds finished turns (diff or PR), the same word the sidebar uses. Other
  lanes sort newest first. A merged or settled thread leaves the board but stays in the
  sidebar, and it comes back with Reopen (thread view, or Undo right after settling).
- **Snooze:** a snoozed thread leaves the board until it wakes, then returns to its lane on
  top with a "Woke" chip (cleared once you peek or open it). It wakes early if it starts waiting
  on you. Snooze sits in the peek (not while an approval waits); Undo right after snoozing,
  and "Wake now" in the thread view.
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

None right now.

## Phases

| #   | Phase               | Output                                                                                  | Status                     |
| --- | ------------------- | --------------------------------------------------------------------------------------- | -------------------------- |
| 0   | Vision and setup    | This doc, the fork, the T3 project                                                      | done                       |
| 1   | UX prototype        | Clickable mock with fake threads: lanes, card anatomy, click and Ctrl-click flow        | done                       |
| 2   | Data spike          | Map lanes, cards and the peek to real thread state in client-runtime                    | done                       |
| 3   | Build               | Board behind a Labs toggle, in small steps (shell → lanes → cards → peek → live polish) | steps 1–4 done; see review |
| 4   | Upstream (optional) | Ideas discussion upstream with a demo                                                   | -                          |

## Data map (phase 2)

Every thread's shell (`EnvironmentThreadShell`, `packages/client-runtime/src/state/models.ts`;
wire type `OrchestrationV2ThreadShell` in `packages/contracts/src/orchestrationV2.ts`) is
already on the client for the sidebar, per environment. The board reads the same shells, so
lanes and most of the card cost no new subscriptions.

| Board needs                                                           | Source today                                                                                                                                                                                                                    | Gap                                                                                               |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Lane: approval, question, failed, limited, working, waiting, finished | `resolveSidebarRowStatus` (`apps/web/src/components/Sidebar.logic.ts`) over shell flags: `hasPendingApprovals`, `hasPendingUserInput`, `source.pendingRuntimeRequest.kind`, `runtime` (`status`, `lastErrorClass`), `latestRun` | None. Lives in `apps/web`, fine for a web-only board.                                             |
| Off the board: settled, snoozed, woke                                 | `settledOverride`, `snoozedUntil`; `effectiveSnoozed`, `threadWokeAt`, `canSnooze` in `client-runtime/src/state/threadSettled.ts`; commands in `threadCommands.ts`                                                              | None.                                                                                             |
| PR chip, failing checks → _Needs you_                                 | `pullRequests[].snapshot`: `state`, `checksState` (`passing`/`failing`/`pending`), `title`, `additions`/`deletions`; `resolveThreadCurrentPullRequestLink`                                                                      | No "x of n" check count. Failing check names only in `watch.failedChecks` when the PR is watched. |
| Grey line                                                             | Not available: the server sends `latestVisibleMessage: null` in every shell on purpose (message bodies stay in thread detail so shell hydration does not grow with transcripts)                                                 | Not shown on cards (decided); the peek reads it from thread detail.                               |
| Request content (approval command, question and options)              | `environmentThreadDetails.pendingRequestsAtom(ref)`, which subscribes to that thread's detail; upstream already uses it for waiting child threads                                                                               | Read only by Needs-you cards.                                                                     |
| Failure and usage limit text                                          | `runtime.lastError`, `lastErrorClass`, `usageLimitResetAt`, `limitRecovery`                                                                                                                                                     | None.                                                                                             |
| Diff chip                                                             | PR snapshot `additions`/`deletions` when a PR exists                                                                                                                                                                            | No per-turn diff stats in the shell (the sidebar's `latestRunDiff` is a stub returning null).     |
| Times: last activity, working duration, waiting since                 | `updatedAt`; `runtime.activityStartedAt` / `latestRun.startedAt`; `pendingRuntimeRequest.createdAt`                                                                                                                             | None.                                                                                             |
| Queued follow-up                                                      | `hasQueuedTurnStart` (`threadSettled.ts`)                                                                                                                                                                                       | A flag, not a count.                                                                              |
| Started by a scheduled task                                           | Not checked yet (`lineage`, `linkOrigin`, `workflowRun` are candidates)                                                                                                                                                         | Drop the chip for v1 unless one of these says it.                                                 |
| Peek: summary, files, activity                                        | Thread detail (`createEnvironmentThreadDetailAtoms`, `threadDetail.ts`), checkpoints (`threadCheckpoints.ts`)                                                                                                                   | Subscribe only while the peek is open.                                                            |

**Performance rule:** the board subscribes to nothing per card beyond the shells it already
has. Thread detail is fetched for the open peek and, if we choose that route, for Needs-you
cards (few, bounded). No per-card PR status queries: the shell's PR snapshot is enough.

## Decision log

Add new entries at the bottom: date, decision, reason.

- **2026-11-24** Build in a fork (`cogwal/t3code`), and maybe propose it upstream later.
  Reason: upstream closed earlier board PRs (#9046, #3135), so building first and
  proposing with a demo has the best odds.
- **2026-11-24** Build on upstream `main`, not on the redesign stack (#28839–#28845).
  Reason: that stack is unmerged, marked DO NOT MERGE, and changes daily. Keep the board
  self-contained.
- **2026-11-24** Keep project context in this file plus a pointer at the top of
  `AGENTS.md`, under the fork-only `fork/` folder.
- **2026-11-24** Prototype the UX with fake data before changing app code.
- **2026-11-25** The board is a page next to the sidebar, like Pull requests, not an overlay.
  Reason: the thread list stays in reach, so new threads start the usual way from the sidebar.
- **2026-11-25** No _Done_ lane; merged or settled threads leave the board (sidebar keeps them,
  Reopen brings them back). Reason: the lane added nothing and cost horizontal space.
- **2026-11-25** Swimlanes per project crossed with the lanes. Reason: groups related threads.
- **2026-11-25** Failed turns and PRs with failing checks go in _Needs you_.
- **2026-11-25** Needs-you cards get quick actions; deeper triage stays in the peek.
- **2026-11-25** Leaner cards: waiting cards drop the grey line (the status and the request say
  enough); project, branch and model leave the card.
- **2026-11-25** The peek is a side panel with the popover's floating look.
- **2026-11-25** Sorting: _Needs you_ oldest wait first, other lanes newest first.
- **2026-11-25** The peek moves to the left of the lanes; it keeps pushing them aside for now.
- **2026-11-25** Entry point: the board icon in the sidebar footer.
- **2026-11-25** The grey line comes from thread state; no LLM summary.
- **2026-11-25** The third lane is called _Done_, matching the sidebar's word for a finished turn.
- **2026-11-25** Trying a full-screen board with its own New thread buttons, after seeing the
  beside-the-sidebar page. Reason: start threads without leaving the board.
- **2026-11-25** Keep the full-screen board. New thread and search move to the top left, where
  the main page has them; the per-swimlane New thread buttons go (not useful).
- **2026-11-25** The peek keeps pushing the lanes aside (no floating variant).
- **2026-11-25** Swimlanes with Needs-you cards move to the top; the rest keep sidebar order.
- **2026-11-25** Snoozed threads leave the board until they wake, then return with "Woke".
  Reason: snooze means "not now", same as upstream's sidebar shelf.
- **2026-11-25** No LLM summaries; thread state is enough.
- **2026-11-25** The board will not move into upstream's pane system.
- **2026-11-25** Mobile is out of scope for now.
- **2026-11-25** Phase 1 is done; the prototype is the reference for the build.
- **2026-11-25** Prototype merged into the fork's `main`; the build happens on
  `fork/thread-board`.
- **2026-11-25** Correction to the data map: the shell carries no message text, so the grey line
  is not free; it is left out until decided (open question 1).
- **2026-11-25** No grey line on cards. Reason: the shell carries no message text, and cards
  stay lean; the peek shows the latest message instead.
- **2026-11-25** Quick actions on Needs-you cards: approve or decline (with the provider's other
  options in a menu) and one-click answers for a single single-choice question; anything richer
  opens the thread. Upstream has no single "retry", "switch model" or "fix checks" action that
  works without the thread, so failed and limited cards show the error or reset time, and
  failing-checks cards offer "Open pull request". Follow-ups for those go through the peek.
- **2026-11-25** For now the board's New thread button opens the usual "New thread in…" project
  picker, which then opens the regular new-thread composer (leaving the board). Reason: a
  new thread's defaults (model, permissions, worktree, `t3.json`) live in that flow; starting
  one from the board without leaving it needs a server RPC or a copy of that logic.
- **2026-11-25** No keyboard shortcut to open the board yet: keybinding commands live in the
  contracts and the keybinding settings, a bigger upstream touch than the palette entry.
- **2026-11-25** Data choices: request text comes from thread detail fetched only for Needs-you
  cards (server preview only if that proves costly); checks show running/failing without
  counts, failing names only when the PR is watched; the diff chip shows only with a PR (file
  list in the peek); the grey line uses the latest visible message, also while running.

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
