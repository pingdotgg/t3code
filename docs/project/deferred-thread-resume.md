# Deferred thread resume

## Summary

Long-running external work currently encourages an agent to poll: sleep, spend another inference
turn checking status, and repeat. T3 should provide host-owned waiting primitives so elapsed time
does not consume model inference.

This project is split into two deliberately different capabilities:

1. **Live wait** — a tool call remains open while the current provider turn and T3 server process
   remain alive. The host completes the tool call after a delay or cancellation. This is the first
   implementation milestone and the scope of the initial PR.
2. **Durable resume** — the current turn ends, T3 persists a waitpoint, and a scheduler starts a new
   turn after a timer or external event. This is required for restarts, webhook triggers, and
   long-lived watches such as pull-request CI. The first durable adapter is a local GitHub watcher;
   it does not depend on T3 Connect or public webhook infrastructure.

## Problem

Agents commonly monitor commands, CI, deployments, and review bots by polling every few seconds.
Most polls provide no new information, but each one wakes the model and consumes inference. T3
already owns provider sessions and their UI lifecycle, so it is the right layer to wait without
asking the model to reason again.

## Goals

- Let a Codex agent wait from 1 second to 1 hour without periodic model inference.
- Show the wait through the existing dynamic-tool lifecycle in the thread timeline.
- Cancel a live wait promptly when its turn is interrupted or its provider session closes.
- Keep the first change isolated to the Codex provider runtime and compatible with app-server
  versions that ignore unknown experimental `thread/start` fields.
- Define the durable timer/trigger architecture before extending the feature to external events.

## Non-goals for the initial PR

- Surviving a T3 process restart.
- Waking a completed thread from a webhook or WebSocket event.
- Polling GitHub on behalf of an agent.
- Provider-neutral tool injection. Claude, OpenCode, and ACP need equivalent provider hooks before
  they can expose the same capability.
- A new bespoke waiting UI. Codex already emits dynamic-tool started/completed events and T3 already
  renders them.

## User and agent experience

T3 registers a namespaced `t3.wait` dynamic tool when it starts a new Codex thread. The tool accepts:

- `durationMs`: integer duration from 1,000 through 3,600,000 milliseconds.
- `reason`: optional short explanation shown in the tool arguments.

The tool description tells the agent to use it for intentional idle periods while external work is
running, and not for ordinary command execution or sub-second delays. While it is open, the thread
remains visibly active. On expiry it returns the elapsed duration and the agent may perform one
status check. Interrupting the turn cancels the wait before T3 sends the provider interrupt request.

## Technical approach: live wait

### Provider registration

Codex app-server supports experimental `dynamicTools` on `thread/start` and sends calls to the host
as `item/tool/call` server requests. T3 already initializes app-server with experimental API support.
The checked-in generated schema exposes the dynamic-tool specification and call types but currently
omits the experimental `dynamicTools` property from `V2ThreadStartParams`, so thread creation uses
the raw protocol request and decodes the response with the existing generated response schema.

The field is only sent on fresh `thread/start`. A resumed provider thread keeps the tool catalog
with which it was created; old threads therefore gain the tool after a recoverable resume fallback
or when the user starts a new thread.

### Execution and cancellation

The handler validates the namespace, tool name, and bounded duration. It races an Effect sleep
against a per-turn cancellation deferred. The deferred is completed before `turn/interrupt` and all
outstanding wait deferreds are completed during session shutdown.

The response uses Codex's normal `DynamicToolCallResponse`: successful expiry returns
`success: true`; invalid input, unknown tools, and cancellation return `success: false` with a short
text result. No timer loop and no model request occurs while the Effect sleep is pending.

### Compatibility

`dynamicTools` is an experimental app-server field. Older app-server versions deserialize unknown
fields permissively, so thread creation continues and the tool is simply unavailable. Current
versions advertise the tool to the model and issue `item/tool/call` requests. T3's existing Codex
adapter maps `dynamicToolCall` lifecycle items to canonical `dynamic_tool_call` activities, and the
web timeline already renders those activities.

## Follow-up architecture: durable resume

A durable implementation should not keep a provider request or inference turn open. It needs a
persisted waitpoint owned by orchestration:

```text
agent registers waitpoint -> current turn settles -> scheduler sleeps outside inference
       ^                                                |
       |                                                v
 timer / webhook / provider event -> claim waitpoint -> start one continuation turn
```

Suggested waitpoint fields:

- id, T3 thread id, provider instance id, and original turn id
- kind: `timer`, `webhook`, or provider-specific event
- condition payload and optional deadline
- continuation prompt/template
- state: `pending`, `claimed`, `delivered`, `cancelled`, or `expired`
- idempotency key, attempt count, timestamps, and last error

Delivery should be at-least-once with an atomic claim and idempotent continuation key. On startup,
the scheduler reloads pending waitpoints and re-arms timers. External triggers should enter through
authenticated, scoped adapters rather than exposing a generic unauthenticated callback. A GitHub PR
watcher can translate polling results or future webhooks into normalized waitpoint signals. An
explicit sidebar `waiting` state remains a possible follow-up; the first durable adapter relies on
the registered tool activity and normal thread-running transition when delivery occurs.

## Alternatives considered

- **Agent-side polling:** no server work, but repeatedly consumes inference and is the behavior this
  feature is intended to replace.
- **MCP wait server:** portable across clients, but T3 would lose direct lifecycle ownership and
  cancellation unless it also hosted and correlated the MCP server. Codex dynamic tools give T3 a
  smaller first integration.
- **Implement durable wake immediately:** covers timers and webhooks, but requires persistence,
  scheduler recovery, continuation policy, UI state, authorization, and idempotency in one change.
  Keeping live and durable semantics separate makes the first PR reviewable and testable.
- **Keep a WebSocket open for every trigger:** useful as an adapter transport, but not sufficient as
  the source of truth because sockets do not survive process or network failure.

## Durable GitHub watcher

The second implementation milestone adds `t3.await_github` for Codex. The tool takes an
`owner/repository`, pull-request number, condition, optional reason, and timeout. Registration reads
an initial snapshot through the authenticated `gh` CLI, persists the waitpoint, and returns
immediately. The agent is instructed to finish its current turn instead of polling.

Supported conditions are deliberately narrow:

- `checks_settled`: at least one reported check exists and every check is terminal. Failed checks
  still satisfy the condition so the resumed agent can diagnose them.
- `new_review_activity`: a review or issue comment appears that was not in the registration snapshot.
- `pull_request_closed`: the pull request is merged or closed without merging.

The local worker wakes every five seconds to find due database rows. It first verifies that the
originating T3 turn has settled, then queries GitHub no more than once per row every 30 seconds. A
busy thread is retried after five seconds without querying GitHub. The first poll occurs 30 seconds
after registration. If the user advances the thread with another turn, the older waitpoint expires
instead of injecting a stale continuation later.

Delivery uses a 60-second database lease and a deterministic orchestration command id. If T3 stops
after dispatching the continuation but before marking the row delivered, the lease expires and the
worker retries the same command id; the orchestration command-receipt store deduplicates it. Pending
rows and expired leases are discovered from SQLite on startup, so no in-memory timer is the source
of truth.

The continuation is a clearly identified T3 GitHub watcher message containing the observed result.
Normal orchestration events then move the thread back to its running state in connected clients.
No bespoke webhook route, GitHub App, T3 Connect link, or new frontend state is required for this
milestone.

### Durable GitHub non-goals

- Hosted monitoring while the local T3 server is offline. The worker catches up when T3 runs again.
- Generic arbitrary webhooks or user-supplied callback URLs.
- Durable timer waits; `t3.wait` remains the live timer primitive.
- Cross-provider exposure before those providers support an equivalent host-tool hook.
- Conditional HTTP requests or cross-waitpoint GitHub request coalescing. Those are optimizations if
  observed watch volume approaches GitHub API limits.

## Test plan

Focused automated coverage:

- Thread start sends the namespaced dynamic-tool schema through the raw request path and decodes the
  response.
- Recoverable resume fallback starts a fresh thread with the tool schema.
- Valid waits remain pending until the Effect test clock reaches the requested duration.
- Duration bounds, malformed arguments, wrong namespaces, and unknown tool names fail without sleep.
- Cancellation wins the race and returns a failed/cancelled tool result.
- Existing provider adapter tests continue to verify canonical dynamic-tool activity mapping.
- Migration and repository tests cover idempotent registration, due ordering, exclusive claims,
  expired-lease recovery, rescheduling, delivery, and expiry.
- GitHub adapter tests cover normalization and each supported condition.
- Worker tests cover active-turn deferral, satisfied-condition delivery, and duplicate suppression.
- The orchestration gateway test verifies deterministic continuation command and message ids.

Targeted validation:

- Format and lint changed files.
- Run the focused Codex runtime/dynamic-tool tests.
- Typecheck the server package.
- Manually start a Codex thread against a compatible app-server, request a short wait, confirm one
  tool activity appears and completes, then repeat while interrupting the turn.

## Rollout and observability

The initial feature has no migration and no feature flag. App-server compatibility degrades by
omitting the tool rather than breaking the session. Existing provider event ingestion records the
dynamic-tool lifecycle. A follow-up may add wait duration/cancellation metrics once the contract is
used beyond Codex.

The GitHub milestone adds migration 034 and no feature flag. Removing the runtime layer stops new
polls without deleting rows; reverting the code leaves the additive table inert. Structured logs are
emitted when a waitpoint is registered, delivered, or a worker tick fails. Per-condition counters and
request coalescing can be added after real watch volume is observed.

## Risks

- Experimental app-server protocol changes: isolate the raw field construction and response decode
  so regeneration can replace it cleanly.
- Excessive waits: enforce a one-hour upper bound.
- Interrupted waits continuing in the background: correlate cancellation by provider turn and settle
  it before sending the interrupt request.
- Confusing live and durable behavior: name and document the initial tool as a live wait and do not
  claim restart or webhook guarantees.
- GitHub CLI authentication loss: retain the pending row, store the last error, and retry until its
  deadline rather than waking the model with an infrastructure failure.
- Duplicate continuation after a crash: use a delivery lease plus deterministic orchestration
  command id so the existing command receipt is the idempotency boundary.

## Definition of done for the initial PR

- A new Codex thread receives the `t3.wait` tool.
- A valid call sleeps in T3 and completes without model polling.
- Interrupt and session close cancel outstanding waits.
- Focused tests and server typecheck pass.
- The provider documentation explains the capability and its live-session limitation.
- The PR explicitly links this design and leaves durable waitpoints as follow-up scope.

## Definition of done for the GitHub milestone

- `t3.await_github` validates and snapshots a pull request through authenticated `gh`.
- Registration returns immediately and the agent is told to finish its current turn.
- Pending rows and expired delivery leases survive a T3 restart.
- A busy thread is never probed or resumed; a satisfied condition starts one continuation turn.
- Missing threads and elapsed deadlines move the waitpoint to `expired`.
- Focused migration, repository, adapter, worker, gateway, and Codex runtime tests pass.
- The server package typechecks and the live `gh` payload shape is smoke-tested against a real PR.
