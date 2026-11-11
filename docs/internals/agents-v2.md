# Agents on orchestrator V2

The Agents board is a profile-indexed view of native V2 threads. It must not own
another run state machine, provider process, event log, or transcript. A profile
is a settings record; creation resolves its revision and freezes its instructions
on the native thread. Later library edits affect new threads only. The common
provider turn boundary supplies these instructions, including after a provider
switch. The fork supplies them as a delimited prompt prefix, not as a native
provider system/developer message; provider-specific instruction priority still
needs acceptance testing.

## Upstream relationship

V2 landed upstream as pingdotgg/t3code#2829 (squash commit `de34391427`), and
upstream main is an ancestor of this work, so track upstream main with ordinary
merges. Upstream migrations keep upstream's ids and names; fork migrations have
their own ledger (below). A V1 client/server mixture is not a supported
deployment.

## Data boundary

Fork-only migrations live in `Migrations/fork/` and record in
`effect_sql_fork_migrations`, because the migrator skips every id at or below the highest
recorded one: any fork id in upstream's table masks a future upstream migration. Each fork
migration names the upstream migration it runs after, so a fresh database replays the order
existing ones ran in. Fork builds before the split recorded both in one table (fork ids 52,
53, 56, 58, 61, 62, 65, 75, 77, 78); `splitLegacyForkLedger` moves those rows once, keeping
exactly the applied set, and refuses ledgers that mix in V2 preview numbering.
Fork migration 3 created a differently shaped `scheduled_tasks`; the fork's V2 migration (upstream 55) renames it to
`legacy_scheduled_tasks` before upstream's `CREATE TABLE IF NOT EXISTS` would keep the
wrong columns, and `ScheduledTaskService` imports and drops it at startup, when profiles
can be resolved. Scheduled tasks otherwise run on upstream's service; the fork adds an
optional `profileId` (runs launch with the profile's latest revision and reuse the thread
the first run created) and `cron`/`once` schedules.
Tests use memory databases; integrated verification uses a read-only SQLite backup
copy in the worktree. Never experiment against the installed database.

Legacy import retains the profile snapshot. Upstream now owns the earlier draft's
event-sink and transcript-ordinal fixes: it projects shell events through the
native event sink. Reserve legacy transcript ordinals before writing those events:
normalizing the first/last preview messages first consumes ordinals needed by the
subsequent full transcript. The import regression checks visibility before replay
and preservation after replay. Data produced by earlier exploratory versions of
this branch is disposable; recreate its sandbox from the V1 snapshot.

## Client MCP is a separate boundary

V2's MCP HTTP server and toolkits serve one environment's provider invocation.
They do not have the client's authorized connection registry and cannot replace
the client-facing gateway. Retain `packages/mcp-gateway`, its durable delivery and
grant checks, and the client/desktop bridge. The runtime port adapts this gateway
to native V2 queries, commands, runtime requests, and receipts. Environment ID is
required for routing; a project or thread ID alone is never globally unique.
Readable provider/model labels are resolved against the target environment's
catalog. The gateway never creates a broader grant to compensate for routing.

`t3_get_agents_view` lists profiles with associated chats and accepts `profileId`
and settlement filters. Native run IDs are available on thread summaries and
native run records on thread detail. Gateway events are bounded shell changes
with environment-qualified IDs. This changes the old activity-event vocabulary;
external consumers must not assume V1 session/activity payloads survive.

Pause/cancel map to native interruption; stop detaches the native runtime session;
resume/retry create a native continuation message and restart requests restart
semantics. These are compatibility mappings, not a new persisted lifecycle.
Individual native runtime requests can be answered. V1 atomic approval-plan
modification is unsupported and fails explicitly; do not emulate atomicity by
sequentially granting approvals.

## Reuse and retained fork surface

The current fork Agents workspace, profile editing, machine-scoped project picker, enabled-model catalog,
and client gateway remain fork UI/application concerns. Embedded new/hover chats
render the same V2 composer as normal chat, including attachments and model
controls. Native projections provide status, transcript, PR links, and settlement.
Native settlement rechecks all eligible associated chats after a merge, retaining
upstream protections for active, pinned, or explicitly unsettled work.

The old local workspace MCP toolkit, V1 lifecycle/approval-batch orchestration,
and provider-specific profile instruction injection are superseded. Skill resources
remain content-addressed, thread-scoped files, materialized at the common V2 turn
boundary. The thread's profile snapshot names its instructions and skills by `contentHash`;
the content lives once in `profile_snapshots`, because every whole-thread event (a read
receipt included) repeats the snapshot. The thread-create path stores the row before
dispatching, so no committed event references a missing one. Events written before the
split still carry the content inline: the event store hashes it while decoding, and fork
migration 11 stored every such content, so replay resolves the same row. Keep the profile
snapshot, profile revision/tombstone settings merge, client grant/delivery store,
and machine-aware navigation. Desktop branding, fork release feed, bundled build
version, and branded startup route remain independent of orchestration. The fork removed
T3 Connect and requires no cloud of its own.

V2 now owns durable queued runs, queued editing, worktree preparation, and draft
promotion. The fork's V1 browser-local message queue and worktree activity recovery
are superseded by those native paths; they must not be layered on top of V2.

Command Code uses the fork CLI protocol helpers at a native V2 adapter boundary.
The orchestrator owns queueing and terminal runs; the CLI owns resumable history.
Headless approvals remain noninteractive and never elevate supervised permissions.

There is one MCP per chat: the server's `t3-code`. The T3 Agents tools join it from the
gateway catalog (`packages/mcp-gateway/src/catalog.ts`) and run through the same
`GatewayRuntimePort` the external gateway uses, backed in-process by the server's own WS RPC
handlers (`apps/server/src/mcp/agents`). A new tool added to the catalog appears in both
places, and a new RPC either stream adds is reachable through the port. Calls for other
environments route to a connected app over `mcpGateway.connect`; the app only answers for
environments its user granted, and the server applies those grants' scopes. Keep tools that
need the gateway's event store in `GATEWAY_ONLY_TOOLS`.

### Children and subagents

A thread hangs off another in one of two mutually exclusive ways, recorded in
`parentRelationship` and read through `threadParentRelationship`
(`packages/contracts/src/orchestrationV2.ts`):

- A **child** is a full agent chat with its own context doing a separate part of a larger task.
  It is a card nested in its parent's card and a sidebar row, settles on its own, can be
  re-parented, and owns its own subagents.
- A **subagent** is a helper inside one agent's run that saves that agent's context. It is never
  a card or a sidebar row; it appears only in its owner's Lineage panel and cannot move.

`parentThreadId` is the single owner pointer for both, so the settle cascade and the
in-progress rollup cover children and subagents without knowing the kind. Everything that
decides _visibility_ must ask for the kind instead.

`lineage.relationshipToParent: "subagent"` does not mean "subagent" in this sense. It records
that a task spawned the thread and drives task-result delivery back to the delegator. A
`delegate_task` run as a named agent keeps that lineage, so its result still returns through
`task_status`, but it is a child: a named agent doing separate work has its own context. Only
profile-less `delegate_task` helpers and provider-native subagents are subagents. The profile
cannot stand in for the kind, because a spawned thread inherits its owner's profile snapshot.

Rows written before the kind was stored fall back to their lineage on clients. On every start
`repairThreadParents` (`threadParentLinks.ts`) records the kind for task-spawned rows, treating a
named agent other than the owner's, or a row the user moved, as a child. It also makes any thread
whose parent or owner is gone top-level, so nothing ends up hidden from both the board and
Lineage.

Parent links may point at a chat on another machine through `parentEnvironmentId`. A server
cannot check a parent it does not host, so it validates existence and cycles only for local
parents; clients resolve parents by both IDs.

### Child tasks

An ordinary child has no `task_status` delivery, so a parent learns about it through its task
record (`apps/server/src/threadTask/`). Three distinctions are easy to collapse and must not be:

- **A finished turn is not a finished task.** Run state is read, never stored on the task.
  Child activity never dispatches automatic parent messages, including task updates, check-back
  deadlines, and named-agent delegation completion. The parent waits for the child thread to end
  and reads its result, or watches task state. `checkBack` records a watcher T3 cannot see; its
  deadline affects continuation liveness without scheduling a message. A question is the one
  exception: a waiting child cannot end, so its question wakes its local parent, which answers or
  asks its own parent, and so on up to the root (`DelegatedTaskQuestionReactor`). The parent's own
  message to the child closes the child's open async questions, so a late answer cannot start an
  empty run.
- **Consent is not acceptance.** `settleWhenAccepted` is the owner's standing permission to settle;
  the owner's `accept` names one DONE revision after its gates pass. Any content change bumps the
  revision and drops acceptance. Settlement waits for both, then for the worker's turn and every
  descendant task and run.
- **Recovery must not replay retired messages.** Legacy pending task wakes are cleared and all
  queued task wake runs are cancelled, including explicit reports. Incoming remote task state
  remains readable, but legacy wake metadata is discarded so older peers cannot resume delivery.

A chat may also ask to settle itself after its turn (`t3_settle_after_turn`). The request is
stored, so it survives the turn that made it, and it never discards a queued wake: it waits for the
run, queued wakes, unaccepted child tasks, and active descendants, and a later user message
withdraws it.

Callers are never input fields. An agent's task call always runs on its own server as the MCP
credential's thread (`LocalGatewayPort`, kept local by `createRoutedGatewayPort`); it is never relayed
as the user. Calls without a calling chat act as the session's user under its RPC scopes.

A child on another machine keeps its task on its own environment, the single writer. The owner's
environment holds a read-only mirror. At assignment the owner's server mints a capability that only
the two servers store, and every later call between them (`threadTasks.remoteDeliver`,
`remoteOwnerAction`) presents it, so the receiver acts as that task's peer and never as the
relaying app's user. Calls travel through a connected app (`McpGatewayBroker`), which is live only:
the worker side keeps a delivery cursor per task, retries when an app connects or the server
starts, and the owner side ignores a cursor it has already applied. Task changes update the
owner's readable mirror without dispatching chat messages. With no app
connected, owner actions fail and the mirror's `sync` shows the last delivery.

Peers and the relaying app may run older contracts, and Schema drops unknown keys but rejects an
unknown literal. So the task view grows only by optional fields: a new continuation or wake reason
added as a union member would fail every delivery through an older peer. `checkBack` follows this,
but an older relay may omit that optional metadata. Legacy wake fields remain decodable
but never cause delivery on an updated owner.

Workers (any chat with a task) may message only their own children, on every send path; Captains
coordinate freely. Gateway-originated turns are stored as agent messages, so a relay never counts
as the user writing.

### Threads on another machine

The orchestrator thread tools (`t3_thread_launch`, `_read`, `_wait`, `_send`) reach a thread on
another environment through the same connected app
([`remoteThreads.ts`](../../apps/server/src/mcp/agents/remoteThreads.ts)). That app is the user's
installed T3 Code, so these calls may use only runtime-port methods it already relays: a launch
maps onto `createThread` (a project, a root or new-worktree checkout, no scratch folder, existing
worktree, branch name, or attachments), a read returns messages rather than the timeline, a send
cannot steer or restart, and a wait re-reads the thread with backoff because the relay streams
nothing. Whatever a remote call cannot honor is refused rather than dropped, and a named child
created there, by either launch tool, is assigned as a remote task at once so the owner's sweep
lists it.
