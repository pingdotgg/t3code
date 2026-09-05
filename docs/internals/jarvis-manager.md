# Jarvis manager

> For maintainers. Using T3 Code? See [Jarvis](../user/jarvis.md).

Jarvis is a provider-neutral command and voice layer over the existing T3 orchestration domain. It does not introduce a manager model or bypass provider adapters. For the multi-node MVP, T3 remains the authority: each running T3 environment is one execution node, and Jarvis routes a request to that node's ordinary orchestration and provider services.

## Multi-node boundary

`EnvironmentId` is the stable node identity. The client does not invent a second Jarvis identity or copy a project's files between nodes. Web and desktop clients keep the paired environments in `EnvironmentRegistry`; Jarvis Companion keeps a durable node directory keyed by the same environment identity. Both surfaces refresh each node independently and combine only the presentation catalog.

The combined catalog is node-qualified:

- `ProjectRef` is `{ nodeId, projectId }`. A project ID is meaningful only in its owning environment.
- `TaskRef` records the `executionNodeId` and remote task/thread identity, with project and provider identity when available.
- Projects, providers, and task-desk entries are grouped and labeled by node. Equal project titles are candidates, not an implicit selection.
- Provider readiness is read from the target node's live provider registry. A provider that is installed or authenticated on one node is not available on another node until that node is configured independently.

The client sends the selected `ProjectRef` to the target environment. The authenticated HTTP or WebSocket boundary checks that the reference belongs to its own `EnvironmentId`; a disconnected or mismatched target fails instead of falling back to another node. A continuation uses the `TaskRef`'s execution node and remote thread identity (represented on the execution input by the qualified project and exact reference thread), so the follow-up is executed by the original node and provider conversation even when the controlling client is attached to a different node. Pairing exchanges only the session credential needed to control the selected T3 environment; provider credentials remain node-local.

The MVP has no central discovery service, mobile multi-node surface, or repository synchronization. Nodes enter the directory through explicit pairing or an existing T3 connection path, and every node keeps its own workspace and event store.

## Director seam

The Jarvis Director is a deterministic control module, not an LLM. It accepts an utterance, the project already resolved by the client, and an optional exact task reference. It produces one closed plan: start, steer, queue, interrupt, report status, reroute, focus a project, or request clarification.

This boundary is deliberately narrow:

- The web/desktop mesh and Companion resolve spoken project names against the typed catalogs of connected nodes. They never tell an agent to change directory.
- The Companion voice adapter treats that catalog as a closed entity vocabulary. Exact, ordinal, and conservative phonetic resolution produce a stable project ID; canonical names replace clear ASR sound-alikes before dispatch.
- The Director interprets only a controlled conversational grammar. It never invents a thread or project when a referential phrase is ambiguous.
- `JarvisManager` adapts the plan to ordinary T3 commands on the selected execution node. Providers still receive turns through their existing adapters.
- Queued follow-ups are durable `jarvis.followup.queued` activities. `JarvisQueueReactor` starts the next item when the exact thread becomes ready, with deterministic command identifiers for replay safety.
- Approval presentation is an adapter over typed approval data. It keeps the exact command for visual review while speech receives a conservative risk explanation.

The Director is intentionally extensible through more typed intents and adapters. An optional language model may later normalize unusually phrased speech into this schema, but it must never authorize tools, select an ambiguous target, or dispatch orchestration commands directly.

Multi-conversation focus, back/forward navigation, and named-task resolution are specified separately in [Jarvis task desk](./jarvis-task-desk.md). They require durable per-client focus history rather than expanding the single recent-task reference into more regular expressions.

## Request path

1. A full client sends `jarvis.execute` with a node-qualified `ProjectRef`, an optional exact reference/context thread, request metadata, and utterance. Before using the authenticated `POST /api/orchestration/jarvis` boundary, the Windows Companion resolves an explicit spoken project name across its paired node catalogs. Ambiguity—including equal names on different nodes—becomes a clarification with labeled candidates. An older Companion may omit the project only when the selected environment has exactly one project; the server rejects an ambiguous unscoped request instead of guessing from visible or recent UI activity.
2. `resolveTaskIntent` deterministically matches explicit provider, model, and effort names against the selected node's live provider registry. A Companion may instead provide a saved `ModelSelection`; the server revalidates it against that same node and treats the utterance as the objective. It never substitutes a provider from a different node.
3. `JarvisManager` emits ordinary orchestration commands on the execution node. New work uses `thread.turn.start`; questions and approvals use the existing response commands. Steering, queueing, interruption, and continuation use the exact node-qualified task reference; rerouting creates a new thread in the newly resolved project and node.
4. Cross-provider reviews create an ordinary target-provider thread on the selected node and append reciprocal `jarvis.review.*` activities so the relationship is durable and inspectable.

Unknown or unavailable selections return structured clarification. There is no silent provider or model fallback.

### Node-owned default agent

`ServerSettings.jarvisDefaultModelSelection` is a nullable, atomically replaced model selection.
The control center reads and updates it through the selected environment's existing config and
settings commands, never through primary-environment settings. No additional mesh protocol or
provider-specific dispatch path is needed.

For new tasks, selection precedence is explicit request selection (including Companion), explicit
spoken provider/model, node Jarvis default, then the project's ordinary default. The Director's
existing clarification behavior applies when none resolves. Defaults are passed as
`fallbackModelSelection`, separately from authoritative `modelSelection`, so a project preference
cannot suppress a spoken provider choice. Continuations, queued work, and reroutes preserve their
existing task's selection. A configured but unavailable selection is an error to explain, not
permission to choose a different agent.

The web/desktop control center projects live registered connections alongside the asynchronously
loaded mesh catalog. It marks the desktop primary environment as this device, but never labels a
browser's remote primary environment as the user's device. Connection membership/status changes
refresh catalogs without polling, and stale refresh responses cannot overwrite newer results.

For routed work, the client supplies a stable `requestId` plus optional origin node and interaction identity. The server derives command and event identifiers from an authenticated acceptance key and persists the request metadata in the task-created activity. T3's command receipts and event metadata are the authoritative deduplication record: retrying the same request reuses the receipt-backed command identifiers, while reusing a request ID with a different payload returns a conflict instead of creating a second task. This is idempotency at the command/event boundary, not a task name that callers may reuse for unrelated work.

## Report path

`JarvisReportReactor` observes report-worthy orchestration events independently of presentation subscribers, reloads canonical thread detail, and appends each immutable report to a bounded Host outbox. It replays persisted orchestration events on startup, so a crash between the domain commit and report projection does not permanently lose the report. Resolved approval and user-input activities deactivate only the matching request's pending report. A routed report carries its `TaskRef` and request origin, so the receiving client can recover the exact execution node and task instead of inferring them from the visible workspace.

Capability-aware clients use `jarvis.subscribeReportInbox`. The first subscription registers the authenticated session at the current outbox head; later reports remain pending across WebSocket disconnects and Host or Companion restarts until that session monotonically acknowledges a batch. Batches contain at most 32 rows, inactive rows advance the cursor without presentation, and retention is bounded to the newest 512 reports with an explicit truncation marker when a cursor falls behind. Cursors use the authenticated pairing session rather than the renderer's ephemeral speaker-election device ID, so separate paired devices progress independently. `jarvis.subscribeReports` remains the hot, single-report compatibility stream for older clients.

Clients claim each report through `jarvis.claimSpeaker`. `JarvisSpeakerLease` collects claims for 200 ms, chooses the highest priority with a stable device-id tie break, and freezes the winner for the report's retention window. It owns no timer, heartbeat, or polling fiber; expired elections are removed opportunistically on the next claim.

For durable-inbox reports, the winning claim acquires a ten-minute Host-persisted speech lease. The client confirms the report only after synthesis succeeds; another device cannot speak during the lease, while a crashed winner leaves the report eligible for a later election after expiry. Confirmed reports remain deduplicated for the outbox retention lifetime, including across Host restarts.

The originating interaction is the intended short-briefing consumer. Other clients can retain and render the report but do not steal an origin-directed Companion/browser interaction. The winning client remembers the report's environment, project, and thread in memory. The next relay response can therefore target the reporting thread even when another thread is visible. The server also rejects a continuation whose thread and project do not match, and a missing continuation thread cannot silently become new work.

## Performance boundaries

- The UI host is small; the dialog is dynamically imported.
- Disabled voice clients do not subscribe to the report stream.
- Speech recognition exists only for a single user-initiated capture.
- Companion speech recognition uses a resident, locally bundled Parakeet TDT/CTC 110M INT8 model and treats push-to-talk release as the full-utterance boundary. Companion speech synthesis uses the Pocket Alba voice in a killable child process. A valid local capture starts prewarming Pocket while the user speaks, then coalesces with that advisory warm after transcript review and gives it a bounded grace period before Host dispatch. It reserves the next speech position before dispatch and settles that reservation immediately after the Host result: accepted work commits the acknowledgement only when the live Pocket lifecycle is ready or synthesizing, while rejection, follow-up input, or an offloaded/warming worker cancels it. This prevents later local failures and completion reports from stranding, overtaking, or following a stale acknowledgement. Remote reports retain the separate claim-before-prewarm rule: the relay asks local Electron main to prewarm only after that device wins the Host speech claim. Adaptive retention keeps the worker available during active work and allows up to 120 seconds of idle warmth before offload when it is not active. The user can interrupt current playback from the Companion without changing Host report acknowledgement.
- Durable report delivery reuses the authenticated WebSocket and T3 Connect transport; append, acknowledgement, and blocker-resolution events wake subscribers without polling.
- No new provider-specific logic exists; adapters continue to receive normal orchestration commands.

The wire contracts live in `packages/contracts/src/jarvis.ts` and `packages/contracts/src/environmentHttp.ts`; the server boundary is `apps/server/src/jarvis/`, `apps/server/src/orchestration/http.ts`, and the WebSocket handlers. The Companion exchanges its pairing credential for an Electron session cookie, obtains a provider catalog through `GET /api/orchestration/jarvis/providers`, and sends its transcript plus saved selection through `POST /api/orchestration/jarvis` directly. Its hidden page has a report-only preload bridge and is never a task-start relay.
