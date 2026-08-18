# Notifications: one server-side detector, one outbox

Notification transitions are detected exactly once, on the server, by a single `NotificationReactor` reading the post-commit domain event stream. Every decision it makes becomes a durable row in the `notification_outbox` projection. Clients are dumb transports: they subscribe to a stream of already-decided edges, render them, and report back what they did with each one.

## Why this shape

Earlier notification attempts in T3 Code were client-side detectors diffing lossy snapshots — coalesced shell updates, cross-environment aggregates, cached client state — each with its own dedup key. Duplicate and phantom notifications were structural, not bugs to be fixed. Putting the one detector at the source of truth removes the whole class.

It also makes detection provider-agnostic. The reactor reads orchestration domain events, so Codex, Claude, Cursor, Grok, and OpenCode are all covered with zero per-provider work.

### Considered and rejected

**A client-side reducer.** Faster to land, and a tested implementation existed. Rejected: it keeps snapshot-diff fragility, cursor-based attention identity, and leaves no durable record of why anything fired. Its ~30-case test suite was kept as the reactor's behavioral spec; its runtime code was not shipped. No second detector may ever ship alongside the reactor.

**Notification edges as domain events** (`thread.notification-raised`). Rejected: a notification is a _view over_ the domain, not a _fact about_ it. The outbox is durable and replayable without polluting aggregate history.

## Detection versus policy

The split is what keeps transports simple and the audit trail honest.

The **reactor detects and records every candidate edge unconditionally**. Verdicts decidable from domain facts alone are recorded server-side and never pushed: `baseline`, `not-user-initiated`, `already-notified`, `duplicate-identity`.

**Transports apply the rest**, because it depends on facts only a client has. Each reports its outcome back over an RPC to complete the row: `shown`, or suppressed with reason `focused` or `disabled`. First outcome wins. Rows no transport ever claimed stay at `no-transport-connected`.

Suppression is never a dedup mechanism. A suppressed edge is recorded as suppressed, not as delivered.

## Identity and idempotence

```
turn-completed        t3:notif:<threadId>:turn-completed:<turnId>
turn-failed           t3:notif:<threadId>:turn-failed:<turnId>
approval-required     t3:notif:<threadId>:approval-required:<approvalRequestId>
user-input-required   t3:notif:<threadId>:user-input-required:<requestId>
```

`identity_key` is the primary key, so replay is insert-or-ignore. That is what makes re-running the reactor from sequence 0 reproduce the table exactly, and what makes a checkpoint revert unable to double-notify.

Terminal kinds are mutually exclusive per turn: a `turn-failed` edge takes the turn's slot from any `turn-completed` row already recorded for it, so a failure can never be muted by an earlier completion.

`updatedAt` must never be an identity input. It is the last domain-event timestamp, not a write clock — two edges can share a value, and a flapping request mints fresh ones.

Fail-safe directions are deliberate and point opposite ways: an **unknown baseline means silence**, an **unknown turn initiator means notify**.

## Phase derivation

The shared `agentAwareness` module resolves awareness phase in priority order, and the reactor reuses it verbatim — but reads attention edges from the **raw booleans**, never from the derived phase. Priority ordering swallows one of two simultaneous attentions, which would silently drop an edge.

Turn-settlement predicates that both server and clients need live in `@t3tools/shared` so the two sides cannot disagree. That includes classifying handoff-seeded turns as user-initiated.

## Transport stream

`notifications.subscribe` is a cursor-resumable WS stream of decided edges carrying their presentation strings — transports never re-derive copy. There is no catch-up on launch: transports present only edges detected while they were connected. The outbox supports a bounded catch-up drain, but it must arrive as a named setting, never as a side effect.

All wire shapes live in `packages/contracts`. Subscribe and outcome-reporting logic lives in `packages/client-runtime` so a future mobile transport reuses it rather than reimplementing it.

## Desktop specifics

The watcher runs in the **Electron main process**, so it outlives the window and keeps working while the app is closed.

Environment identity is load-bearing. The click target and the focus rule use the environment id from the **backend's own published descriptor** — the UUID the server persists — never the primary-local-environment sentinel, which names the desktop backend instance rather than the environment threads are routed by. The watcher reads the descriptor before subscribing, so no edge can be clicked without one; a click that somehow lands earlier reveals the window rather than parking a target that opens nothing.

Click navigation goes through the existing thread-route-target resolver, never hand-rolled pathname parsing.

## Per-environment

Each running server owns its own reactor, outbox, and stream. A web client connected to several environments subscribes per connection.

## Debugging

Every candidate edge the reactor evaluated is a `notification_outbox` row — fired or suppressed — carrying the verdict, the guard that produced it, and what a transport did with it:

```sql
SELECT detected_at, kind, detection_verdict, deciding_guard,
       transport_outcome, transport_name, turn_id, request_id, triggering_sequence
FROM notification_outbox
WHERE thread_id = '<thread-id>'
ORDER BY triggering_sequence;
```

Read `detection_verdict` and `transport_outcome` as a pair: the first says whether the reactor called it an edge, the second says what happened afterwards. "Nothing appeared" splits cleanly into a detection question and a delivery question.

A `detected` row still at `no-transport-connected` after a restart is expected — edges decided while replaying the gap the server was down for are recorded but never pushed, since they predate every transport now attached.

Absence of a row is informative too: no row means no candidate was ever formed. Either the triggering event is not in the stream, the thread was archived or deleted before the event landed, or the cursor never reached the event:

```sql
SELECT last_applied_sequence, updated_at FROM projection_state
WHERE projector = 'notifications.outbox';
```

The trace side is the `notifications.decide.edge` decision span, which mirrors both columns as `notifications.detection_verdict` and `notifications.deciding_guard` alongside the two-valued `decision.verdict`.

## Not in v1

Mobile transport and push infrastructure; the browser Notification API on web (a future transport the policy split makes purely additive); catch-up presentation of edges recorded while disconnected; per-kind, per-project, per-provider, or scheduled settings; custom sounds; notification history UI.
