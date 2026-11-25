# Roadmap

The roadmap is a fork feature. Its state is a separate event stream held by one environment, the
roadmap home. Every write goes through
[`RoadmapService`](../../apps/server/src/fork/roadmap/RoadmapService.ts), which the RPC, the MCP
tools and the turn context all call.

## A sibling event stream

Roadmap state lives in `roadmap_events`, `roadmap_command_receipts` and projection tables for
items, attachments and sprints, created by fork migrations 7
([`007_Roadmap.ts`](../../apps/server/src/persistence/fork/migrations/007_Roadmap.ts)) and 8
([`008_RoadmapCalendar.ts`](../../apps/server/src/persistence/fork/migrations/008_RoadmapCalendar.ts)). It follows
the orchestration model: a pure planner decides the event, and the event, its projection rows and
the command receipt commit in one transaction. It does not write to `orchestration_events`, because
a third aggregate kind there would be mishandled in three places:

- Command receipts accept only the `project` and `thread` aggregate kinds
  ([`OrchestrationCommandReceipts.ts`](../../apps/server/src/persistence/OrchestrationCommandReceipts.ts)).
- Replay decodes every kind other than `project` as a thread event (`rowToApplicationStoredEvent`
  in [`OrchestrationEventStore.ts`](../../apps/server/src/persistence/OrchestrationEventStore.ts)).
- Projection maintenance verifies and rebuilds thread projections only
  ([`ProjectionMaintenance.ts`](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts)).

Upstream's maintenance never touches the roadmap tables, so it never repairs them either.
`RoadmapStore.rebuild` replays `roadmap_events` into the projections, but no startup or maintenance
path calls it yet.

Sprints are records in the same stream, not items, but their events store the sprint id in
`roadmap_events.item_id`. `toStoredEvents` in
[`RoadmapStore.ts`](../../apps/server/src/fork/roadmap/RoadmapStore.ts) reads the column back as
`sprintId` only when the event type starts with `roadmap.sprint.`, so a new sprint event must keep
that prefix. Deleting a sprint clears it from its items in the same commit, but the change is
recorded only on the `roadmap.sprint.deleted` event, in `clearedItemIds`. The items' own events do
not show it.

`RoadmapService` owns the write lock and the publisher for the live stream. Every caller must share
one instance. A second instance would have its own lock and its own stream, so its commits would
never reach the other's subscribers. `server.ts` builds one layer value for both the orchestration
runtime and the fork services for this reason.

The subscribe and dispatch RPCs live in the fork RPC group. See
[fork schema](./fork-schema.md#websocket-rpcs).

## The roadmap home

The server setting `roadmap.homeEnvironmentId` names the home. Null means this environment.
`RoadmapService.isHome` compares it with the environment's own id.

- Only the home applies commands. `dispatch` elsewhere fails with `roadmap_home_elsewhere`.
- Off the home, an environment linked to the home forwards reads and queues writes (see
  [The one-way link](#the-one-way-link)). An environment that is neither refuses reads too, because
  its local tables are empty rather than the roadmap.
- `roadmap.subscribe` does not check the home. Subscribing to the wrong environment returns an
  empty roadmap, not an error.

Clients talk to the home directly. The web client reads the setting from the primary environment
only (`useRoadmapHome` in [`state/roadmap.ts`](../../apps/web/src/state/roadmap.ts)). A client
with no primary environment resolves no home and shows no roadmap. On any other
environment, the setting only decides whether that environment's own MCP tools and turn context
treat it as the home.

Every environment defaults to null, so each one considers itself the home until told otherwise. An
agent on a second environment left at the default reads and writes that environment's own roadmap,
which no client shows.

Threads on other environments attach by reference, as an environment id and a thread id. A client
connected to both environments can attach them. Their agents reach the roadmap only through their
environment's link; without one they get `roadmap_home_elsewhere` from the MCP tools and no context
block.

Changing the setting does not move any data. The new home shows its own roadmap.

## The one-way link

An environment that is not the home holds the home's URL and a roadmap-link session in its secret
store ([`RoadmapLink`](../../apps/server/src/fork/roadmap/RoadmapLink.ts)). It calls the home over
HTTP, through the environment API's `roadmap` group
([`http.ts`](../../apps/server/src/fork/roadmap/http.ts)). The home never connects out, so a home
that is a laptop asleep half the day costs the other environments nothing but a queue.

The session's subject is `roadmap-link:<environmentId>` and its scopes are `roadmap:read` and
`roadmap:write`. Every other HTTP and WebSocket path refuses the subject, as they refuse
`mcp-client` (see [environment auth](./04_environment-auth.md)). The reason is the actor check: the
home applies a write only when its actor is an agent or steward of the environment the subject
names, and refuses user and GitHub actors outright. No other path makes that check, so a link
session there could act as the user. The roadmap group also refuses when its own environment is not
the home, so a link can never forward a call on to a further home.

Linking goes through the client, which is connected to both environments. It mints a one-time grant
on the home (`roadmap.link.mint`) and hands it to the other environment (`roadmap.link.configure`),
which spends it at the home's `/oauth/token` for a session that lasts a year. The year-long
credential never passes through the client, and configuring fails, storing nothing, when the other
environment cannot reach the home at the URL it was given. Both RPCs need `access:write`. Revoking
the session in the home's connections list cuts the link; the other side then reports it
unreachable.

### Writes queue; reads do not

`RoadmapService.submit` is the write path for agents. Off the home it puts the command in
`roadmap_link_outbox` (fork migration 9), and
[`RoadmapLinkOutbox`](../../apps/server/src/fork/roadmap/RoadmapLinkOutbox.ts) sends it.

- One worker sends the oldest pending row and nothing behind it, so the home applies writes in the
  order they were made. A transport failure leaves the row at the head.
- Transport failures retry forever, waiting one second and doubling to a minute. The home's
  `internal` and `roadmap_home_elsewhere` answers count as transport failures, because the home may
  answer differently later.
- Any other `RoadmapError` from the home ends that row alone. It stays in the table as `rejected`
  with the error, is never sent again, and a later submit of the same command answers with it.
- Resending a row the home applied but whose answer was lost is safe, because the home's command
  receipts replay the first outcome.

A submit waits up to five seconds for the home's answer, so an agent on a reachable home still hears
a refusal. A failed try at the home ends every wait at once, and the MCP tools then report
`{ queued: true, itemId }`. While the home is already known to be down, a submit does not wait.

Reads go straight to the home with a ten second timeout and fail when it does not answer. Tools
that name their item therefore skip reading it first, so they can still queue while the home is
down. Resolving a thread's own item needs the home to answer.

### Possibly out of date

The turn context keeps the last block the home rendered for each thread, in memory. When the home
does not answer within three seconds, the agent gets that copy with a first line saying it is
possibly out of date and when it was fetched. A thread with no copy gets no block. Unlinking drops
the copies, and a restart loses them.

The home renders the block for every environment (`forThread` on the roadmap group), so agents on
every environment see the same text and only one copy of the renderer exists.

## Agent context rides in the provider-bound text

An attached thread's agent sees its work item at the start of every turn.
[`RoadmapTurnContext`](../../apps/server/src/fork/roadmap/RoadmapTurnContext.ts) renders the block
and
[`ProviderTurnStartService`](../../apps/server/src/orchestration-v2/ProviderTurnStartService.ts)
prepends it to the provider-bound text, next to handoff context. This is one route for every
adapter. A system prompt cannot carry it, because Claude's system prompt is fixed for the session
and the block must refresh each turn.

- The stored user message is unchanged. The block never appears in the thread's history.
- A message that starts with `/` gets no block, because the provider must see the slash command
  first.
- `forThread` never fails. It logs a warning and returns the last copy, or an empty block, on any
  error or defect, so a roadmap problem cannot stop a turn.
- Steered messages do not pass through turn start and carry no block.

The attachment projection allows several items per thread. The planner refuses a second one with
`already_attached`, and both the turn context and the MCP tools read only the thread's first item.
Allowing more than one item per thread needs all three changed.

## Calculations run where the data is

Velocity, forecasts, burn, rank and working-day arithmetic live in one pure module,
[`roadmapCalc.ts`](../../packages/shared/src/roadmapCalc.ts), exported as
`@lathe/shared/roadmapCalc`. It never reads the clock. Every function that depends on the date takes
`today`.

There is no server endpoint for Today or the Timeline. Clients build both from the snapshot they
already stream, in [`today.ts`](../../packages/client-runtime/src/roadmap/today.ts) and
[`timeline.ts`](../../packages/client-runtime/src/roadmap/timeline.ts). Today needs thread shells
and pull request review requests from every connected environment, and only the client holds those.
The server runs the same module for the MCP tools and the turn context, through
[`RoadmapProgress.ts`](../../apps/server/src/fork/roadmap/RoadmapProgress.ts). An agent and the
Roadmap page agree because they share this code. Change a rule in the module, never in a view or a
handler.

## History lives on the item

The calculations need history that phase 1 items did not keep: when the state last changed, when the
item was completed, when each criterion was ticked, and the hours log. Clients receive items, not
events, so the item carries this history in `payload_json` and the planner maintains it.
`completedAt` clears when an item leaves Done.

Migration 8 backfilled `stateChangedAt` and `completedAt` in the item projection from `updated_at`.
It also upgraded the stored `roadmap.item.created` payloads, taking the same fields from the
creation time, because `RoadmapStore.rebuild` decodes every stored event with the current schema. A
future required item field needs the same upgrade or a decoding default, or a rebuild cannot decode
old events. The backfilled values are approximate. A phase 1 item that was done counts as completed
on its last update, which can put it in the first velocity window.

`progressNotes` took the decoding default instead, so migration 10 only writes the empty list into
the item projection and leaves stored events alone.

### Note kinds belong to actors

Progress notes are the one place agents, GitHub sync and the steward all write prose onto an item,
so the planner ties each kind to its writer: `progress` from any actor, `sync` only from `github`,
`drift` and `unsure` only from `steward`. Only the user removes a note. GitHub sync and the steward
rely on this, so a kind check belongs in `planRoadmapCommand`, never in the code that writes the
note. An item keeps its newest 50 notes; the projection drops the oldest.

## GitHub sync

[`RoadmapGitHubSync`](../../apps/server/src/fork/roadmap/RoadmapGitHubSync.ts) imports issues and
keeps their items in step. It starts on every environment, and every sweep and import first checks
`isHome`, so moving the home moves sync with it. It reads and writes through
[`GitHubIssueApi`](../../packages/source-control-github/src/server/GitHubIssueApi.ts) with the token
`GitHubAccountSelector.forRepository` pins for the issue's owner. An issue belongs to no checkout,
so a project's account override never applies.

### The agreement, not the clocks, finds a change

Each item's `source.base` records what the item and the issue agreed on at the last sync. The pure
[`reconcileIssue`](../../apps/server/src/fork/roadmap/RoadmapGitHubReconcile.ts) compares both
sides with it: a field that moved on one side is copied to the other, and only a field that moved
on both to different values is a conflict. Timestamps settle conflicts only. The issue's `updatedAt`
moves for comments and labels, so comparing it with the item's `updatedAt` would call every
comment a conflict.

The conflict clock on the Lathe side is `source.localChangedAt`, one time per synced field. The
projection stamps it when a user, agent or steward changes that field, never for the `github`
actor, so GitHub's own changes never look like local ones. The reactor watches the live stream for
a new stamp and requests a sweep of that item, which is how a local edit reaches GitHub within
seconds. Compare GitHub times by parsing: GitHub writes `...Z` without milliseconds, Lathe writes
`.000Z`, and the strings do not sort together.

Parent and blocker links count only issues that are themselves items. A GitHub parent no item
holds reads as no parent, so importing a sub-issue alone never pushes its parent link away, and the
link comes into the agreement once that parent is imported.

### What a sweep writes

- Remote changes apply first, as ordinary commands from the `github` actor. A refused one (a cycle,
  a type that cannot sit under the new parent) leaves the agreement, so the next sweep tries again.
- Pushes run inline. A failed push also leaves the agreement and `syncedAt` alone, so the next
  sweep pushes again. A rate-limited account pauses until GitHub's reset time.
- `roadmap.source.sync` records the new agreement only when it, `writable` or the issue's
  `updatedAt` changed. Without that check every open item would write an event every minute.
- Sync notes take an id hashed from the decision, so a retried sweep adds no second note.
- An issue the read no longer returns is left alone. A deleted issue and an account that cannot see
  it look the same, so sync never unlinks or deletes on its own.

Only `github` may run `roadmap.source.import` and `roadmap.source.sync`. An agent's import through
the MCP tool is recorded as GitHub's too, because the sync service makes the commands. The planner
refuses user and agent changes to synced fields of an unwritable issue with `read_only_source`;
the UI only explains it.

Linked pull requests are keys on the item. The card reads a pull request's details through the
thread's environment, and only while the link is hovered, so no pull request state rides in
roadmap events. Migration 11 writes `source` and `pullRequests` into stored items; both decode to
empty from older events.

## The steward

[`RoadmapSteward`](../../apps/server/src/fork/roadmap/RoadmapSteward.ts) runs on every environment
over the attached threads that environment owns. It never reads another environment's turns, and it
writes through `RoadmapService.submit` as `{ _tag: "steward", environmentId }`, so off the home its
writes queue in the link outbox like an agent's.

### Its limits live in the planner

The steward's output is a model's judgement, so nothing in its own code is trusted to hold the
limits. `planRoadmapCommand` refuses every steward command except `roadmap.criterion.tick` and
`roadmap.note.add`, which rules out field patches, priorities, due dates, state changes and Done. A
steward tick must tick, carry evidence, and land on an unticked criterion. The steward drops
refusals with a log line; they never surface.

The re-tick rule: once a criterion has been unticked, a steward tick needs `evidenceAfter`, the end
time of the turn its evidence cites, newer than the latest untick. Unticks clear the criterion, so
the time exists only in the event history. `RoadmapService.dispatch` reads it from `store.history`
for steward ticks alone and passes it to the planner as `criterionUntickedAt`. The rule counts any
untick, since the steward itself never unticks. The model names a turn number for each tick, and
[`stewardCommands`](../../apps/server/src/fork/roadmap/RoadmapStewardPrompt.ts) maps that number to
the turn's end time. A tick citing a turn outside the new ones is dropped before it is sent, so the
model cannot launder an old turn through a newer `evidenceAfter`.

### Runs see only new turns

`roadmap_steward_threads` (fork migration 12) records, per thread, the end of the newest turn a
run gave the model. A run digests turns that ended after it, and advances it after submitting, even
when the home refused every write, since the same turns would draw the same answer. A failed model
call or unreachable home leaves it, so the next run retries those turns.

Triggers come from `streamDomainEvents`, which is live only, so turns that end while the server is
down are never announced. The daily sweep covers them. Its "last sweep day" lives in memory on
purpose: the first tick after a start sweeps, and the per-thread cursor makes a repeated sweep cheap.
Notices for one thread coalesce while a run for it is queued.

A turn end reads nothing: the steward keeps in memory the set of threads it reads (owned here,
attached to an open item in an area with the steward on) and ignores turns on any other thread. Off
the home, a roadmap read is a request to the home, and most turns end on threads attached to
nothing. On the home, every roadmap commit and settings change rebuilds the set. The home's changes
are not streamed to a linked environment, so that environment polls the home every five minutes.
A thread that enters the set is queued at once, which is how turning an area's steward on, or
attaching a thread, takes effect without waiting for a turn. A stale set only delays a run, since
the cursor keeps the turns until it happens.

The model comes from `roadmap.stewardModelSelection`, which each environment holds because provider
logins differ per machine, and falls back to the text generation model. It runs through
`TextGeneration.generateStructured`, which every runner-based provider implements once in
`fromRunner`. Muse answers it through its JSON runner. ACP registry instances refuse it.

## Dates without a time zone

The server does not know the user's time zone. Clients compute in local dates (`localDateOf`), and
the server uses UTC dates (`todayUtc` and `utcDateOf`). A forecast in the MCP tools or the turn
context can differ from the page by a day near midnight.

The planner's snooze check refuses only dates on or before the UTC-12 date, the earliest calendar
date anywhere (`earliestToday` in
[`RoadmapCommands.ts`](../../apps/server/src/fork/roadmap/RoadmapCommands.ts)). Comparing with the
UTC date would refuse **Tomorrow** for users west of UTC in their evening. A date already past for
the user can be accepted. It expires at once, because each reader decides whether an item is snoozed
against its own today.
