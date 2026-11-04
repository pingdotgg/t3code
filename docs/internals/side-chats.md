# Side chats

A side chat lets a learner ask about a highlight in an assistant reply without touching the lesson, the
nearest ancestor thread that is not a side chat. It is an ordinary thread with an optional `sideChat`
field: a `fork` of its anchor with `forkedFrom: null` and no context transfer. The app thread holds the
text (excerpt, summary, note); shells reach every client, so they carry a slim copy from
`threadShellSideChatOf`, which both
[ProjectionStore](../../apps/server/src/orchestration-v2/ProjectionStore.ts) builders must call. Shells
that leave out older settled threads never leave out a side chat, since the lesson's marks and Map read
it there: `isOlderSettledThreadShell`, the ShellStream cut, the shell index's `sideChat` (subscriber
snapshots pick which shells to read from it) and the older-settled SQL in ProjectionStore and ThreadSearch
must agree. The parent's `sideChatNoteDeliveries` maps each child to the note
`requestId` it last received.

Open and Done are dedicated commands, not flags on `thread.fork` or `thread.merge_back`, so an older
server rejects them instead of quietly forking. Internal completions are dropped unless their
`requestId` and status still match
([Orchestrator](../../apps/server/src/orchestration-v2/Orchestrator.ts)). Done stops a running turn,
cancels queued messages, finishes open descendants deepest first and queues a note that leaves out
messages cancelled before they started while retaining failed or interrupted messages; an empty or
discarded side chat is deleted instead. Archive, unarchive and delete reach descendants
through a `side-chat.cascade` effect; a side
chat under an archived parent cannot be unarchived alone. A side chat has no page of its own: its route
settles on the lesson with it revealed in the panel
([ThreadRouteView](../../apps/web/src/components/ThreadRouteView.tsx)).

## Background text

`side-chat.opening` and `side-chat.outcome` share a text-generation lane with `thread-title.generate`
([EffectOutbox](../../apps/server/src/orchestration-v2/EffectOutbox.ts)). Lane effects never block the
thread's other effects, and at most `TEXT_GENERATION_LANE_MAX_CONCURRENCY` (2) run at once. The worker
has 4 slots (`DEFAULT_EFFECT_WORKER_CONCURRENCY` in
[EffectWorker](../../apps/server/src/orchestration-v2/EffectWorker.ts)), so summaries cannot stall turn
starts. Neither effect fails: errors are recorded on the side chat as `failed`, since a failed outbox
row pins the lesson's worktree. Text uses the lesson provider's text model, its small default or the
global setting ([`resolveSideChatTextModel`](../../packages/shared/src/serverSettings.ts)), in an empty
temp directory so the project's `AGENTS.md` and `CLAUDE.md` cannot leak into summaries.
Side chats opened from the same conversation state with the same text model share one summary,
including while one is still being written. That state is the anchor thread's visible messages plus,
for a nested side chat, the parent side chat's summary. A new or changed message produces a fresh
summary. The cache is in memory, so a server restart writes a new one.

## Context in

[ProviderTurnStartService](../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts) hands a
new provider thread the opening context. It waits up to `SIDE_CHAT_WAIT_CAP_MS` for the summary before
taking the workspace lease, which the side chat shares with the lesson. A context sent without the
summary gets the fallback title, and the summary rides the next turn on its own once it lands. It is
owed only while no handoff of the side chat contains its text
([`owedSideChatSummary`](../../apps/server/src/orchestration-v2/sideChat/sideChatOpening.ts)), so it
is written at most once and never after an opening that carried it. A later fresh native thread gets
the summary in its own opening, which drops a late summary still carried from a stopped run. The text
is the record because the summary can land while a turn start, which holds no lock, is writing a
fallback opening.

A new side chat, including nested ones, starts with `sideChatModelSelection` when that instance is
enabled; otherwise it uses the anchor's model. It may use another provider than the lesson, and that
provider receives the opening: the lesson summary, the highlight and the text around it. Summaries
and notes still use the lesson's text model described above. Skills are appended as `$name` after the
user text, in provider text only, on the turn that delivers the opening (the first turn or a later
fresh native thread), when the run's provider lists them in its cached catalog (the run's cwd snapshot
if a client warmed it, otherwise the machine list); nothing is scanned at turn start. A
first message that is a slash command, `/goal` or `/compact` gets none. After `/goal` or `/compact`,
Claude's opening and skills wait for the next turn, while Codex injects the opening during the command
turn. Grok expands only a leading mention, so it gets none; Claude expands one skill natively per
message; OpenCode v1, Antigravity, the ACP registry and Muse get the text only.

Notes attach at run start, not dispatch, so a queued message sees notes that became ready meanwhile.
[`awaitNotesForRunStart`](../../apps/server/src/orchestration-v2/sideChat/SideChatLifecycleService.ts)
runs inside the `provider-turn.start` effect. It returns before any tree read unless a person sent the
message and `hasSideChatChildren` is true. It waits in the effect, not a command, because the
completions it waits for take the lesson's lock. The wait holds one of the worker's 4 slots, and the
notes need a lane slot and a worker slot of their own, so four waiting turn starts would hold every
slot. `SIDE_CHAT_WAIT_CAP_MS` bounds that; a turn that misses it goes ahead and the note rides the next
user message. The cap counts from the send (a queued message waits once), from Done for a parent's
note, and from its start for the opening. Notes and late summaries that do not fit the budget are
dropped whole ([context handoffs](./context-handoffs.md)). Snapshots and live events strip every
handoff's `summary`; the side-chat dividers fetch theirs with `orchestration.getTurnItem` when
expanded ([WireProjection](../../apps/server/src/orchestration-v2/WireProjection.ts)).

## Locks, chain-up and reopen

Every command on a side chat takes its lesson's lock before its own. Done, cascade Done and auto-Done
write descendants holding only that lock, so a late write (a completion, a reopen) that read a row
before Done could otherwise overwrite Done's `done`. The locks are not reentrant, so the order is
always lesson, then thread, then that thread's upstream side chats, which upstream's delete cascade
locks. Neither kind of side chat may start the other (ThreadForkService and `thread.side_chat.open`
refuse it); either nesting would invert that order.

A side chat's note writer reads every ready note of its direct children, received or not (an earlier
note carrying one may never have reached the lesson), and counts them delivered when its own note
lands. Until the lesson holds one of its notes, a null answer becomes those notes verbatim, so a gap
three levels down reaches the lesson. Once the lesson holds a note written with a nested note in view,
that nested note is kept as `deliveredNestedNotes` and never fed to the writer again. `sideChatOutcomeRequestId` encodes depth so deeper writers are
claimed first, or a parent could hold a lane slot waiting on a child that cannot start. A side chat is
never open under a done one: a message in a done side chat, or a side chat opened under it, reopens it
and every done ancestor. A note the lesson received is kept as `deliveredNote`, so the next says only
what is new; a nested one is not, since the parent note carrying it may be dropped. A user message also
finishes the idle open side chats below it that have messages; busy ones stay open with their
ancestors, and empty ones stay open because their composer may hold an unsent draft.

## Downgrade safety and the capability gate

An official build must still read this database after a switch back, so:

- Side chats create no `fork` or `merge_back` transfer, which an official server would replay in full.
  A fork of a side chat drops `sideChat`, and merge-back from one is refused.
- A switch back needs no pending or running `side-chat.*` outbox row. An official server claims it,
  cannot decode it and leaves it `running`, which blocks its thread's lane.
- A switch back needs no `sideChat.*` entry in `keybindings.json`: an official server rejects the
  unknown command, then stops syncing defaults. [Keybindings](../../apps/server/src/keybindings.ts)
  never writes a lone default, but a user's own binding is written.

The fork's service-switch script, not the server, is where both are checked. Round-trip limits:

- An official server that touches a lesson or side chat rewrites its payload without `sideChat` and
  `sideChatNoteDeliveries`. After a later switch forward, those side chats show as ordinary forks, and
  ready notes may be sent to the lesson once more.
- Persisted `lesson-side-chat` and Map panel tabs are unknown kinds on an official client; close them.
- The Side chats settings are environment-wide `settings.json` keys; an official server drops them
  when it rewrites the file.

Older servers reject the commands and strip the optional fields, so clients hide every entry point
unless [`supportsLessonSideChats`](../../packages/contracts/src/environment.ts) holds: the server
advertises `lessonSideChats`, or `sideChats` with a `-learn.` version. Released T3 Learn servers used
`sideChats` before upstream took the name; `supportsSideChats` refuses upstream's `/side` on them,
since they would create a listed fork and delete it when its tab closes.

## Upstream side chats

Upstream has its own side chats: hidden forks with `lineage.sideChat` (`/side`, `/btw`, the panel's
**+** menu). Both kinds coexist. Every list, search, older-settled and agent-listing rule hides or
exempts both (`!isListedThreadLineage(lineage) || isSideChatThread(thread)`). A T3 Learn side chat's
lineage reads as a listed fork, so the tag filter's `visibilityParentKey` hides it with its lesson
([threadTagFilter](../../packages/client-runtime/src/state/threadTagFilter.ts)). T3 Learn's panel tab
kind is `lesson-side-chat`, so upstream's `side-chat` tab code never sees a T3 Learn side chat.
