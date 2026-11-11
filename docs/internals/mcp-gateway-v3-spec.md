# T3 MCP Gateway v3 Product Specification

Status: implementation specification
Scope: production MCP orchestration over the existing T3 runtime and its direct, Tailscale and SSH access paths
Repository: `jayleaton/t3code` fork only

## 1. Decision and non-goals

T3 MCP Gateway v3 is a capability-limited MCP facade over an existing T3 server. It is not a second remote execution system, a cloud scheduler, or a remote-access method. A voice agent talks MCP; the gateway resolves one or more already-connected T3 environments; the T3 server remains the owner of provider sessions, projects, threads, terminals, files, git state, and execution.

The gateway is optional. When MCP is disabled, the ordinary T3 client/server path and Gateway Runtime Port remain unchanged: stock T3 has no MCP listener, no MCP session, and no MCP credentials. The first release is production-only; no mock transport, development-only protocol, or compatibility promise for arbitrary third-party runtimes is required.

The implementation must remain compatible with the current sidecar-over-bridge architecture in approved commit `3e3330943` (`fix(mcp): harden grants and bridge startup`): an MCP stdio process owns the MCP server, a loopback authenticated bridge connects it to the client runtime, and grants are evaluated at call time. Extend that architecture rather than introducing a second remote control plane.

## 2. Current foundation and constraints

The existing code provides:

- `packages/mcp-gateway`: stdio MCP server, bridge authentication, environment grant filtering, and read/create/send tools.
- `packages/client-runtime/src/gateway`: `GatewayRuntimePort` as the client/runtime boundary.
- Web Settings: enable/disable state, a minimum-16-character bridge token, and the current per-environment `read`, `create`, and `send` grant matrix. The v3 Settings UX for that matrix is defined in §9.4; it remains a sidecar setting and does not alter stock T3 when MCP is off.
- Loopback bridge default `ws://127.0.0.1:47631`, challenge/proof authentication, one configured client, request timeouts, and replacement handling.
- Existing T3 connection/runtime boundaries described in `docs/internals/remote.md`, `docs/internals/connection-runtime.md`, and `docs/internals/environment-auth.md`.
- Tailscale and SSH remain endpoint/launch helpers, not new environment types.

The v3 work must preserve environment identity, scoped authorization, reconnect behavior, and the rule that projects and threads remain environment-local. A repository identity may correlate related clones but must never route a command.

## 3. User outcomes

A voice agent or other authorized MCP client can, without polling:

1. Discover healthy environments, projects, named profiles, capabilities, and available providers.
2. Create work on another machine with a selected profile or explicit per-thread overrides.
3. Receive ordered live lifecycle/progress/completion events through a webhook or durable subscription.
4. Reconnect after gateway/client/network interruption and replay events from a cursor without duplicate side effects.
5. Retrieve authorized artifacts such as screenshots, images, files, patches, logs, documents, and PR links.
6. Approve or reject pending approval requests, with an explicit confirmation gate for destructive actions.
7. Pause, resume, stop, cancel, retry, or restart work idempotently.
8. Execute a complete fork/upstream PR and review loop, including unresolved review state and checks.
9. Ask for a current summary and next action based on server history rather than reconstructing state by polling.

## 4. Architecture

```text
MCP client (ChatGPT voice or compatible host)
        | MCP stdio / JSON-RPC
        v
Optional t3-mcp-gateway sidecar
  - tool schemas and auth context
  - event subscription/webhook delivery
  - replay cursor, dedupe, acknowledgements
        | authenticated loopback WebSocket bridge
        v
T3 client runtime / Gateway Runtime Port
  - environment registry and connection supervisors
  - direct/Tailscale/SSH endpoint resolution
        | existing HTTP/WebSocket session
        v
T3 server on the selected environment
  - thread lifecycle and provider runtime
  - profiles/default snapshots
  - approvals, artifacts, git/PR operations
```

The bridge is a transport boundary, not a policy bypass. Every request carries a correlation ID and is authorized against the current environment grant and the server-side session scopes. The client runtime must not create its own retry loop for execution commands; it delegates lifecycle and receipt ownership to the T3 server.

### 4.1 Connection and environment model

An environment is the existing stable `environmentId` owned by one running T3 server. The gateway may address environments reachable through direct, bearer-paired, Tailscale, or desktop-managed SSH connections. Application traffic terminates at the T3 server.

Gateway discovery returns endpoint-independent environment metadata, connection phase, health, capabilities, and last-seen timestamps. It must not expose pairing/bootstrap secrets, bridge tokens, provider credentials, or signed asset URLs longer than needed for an authorized transfer.

### 4.2 Server-side ownership

The T3 server is authoritative for thread state, event sequence, approvals, artifacts, profile/default snapshots, and git/PR state. The gateway stores only delivery state (subscriptions, webhook configuration references, cursors, retry schedule, and dedupe records) and may cache read-only summaries with an explicit freshness timestamp.

## 5. Stable identifiers and envelopes

All IDs are opaque strings and must be unique within their declared scope:

- `environmentId`, `projectId`, `threadId`, `profileId`, `approvalPlanId`, `approvalActionId`, `artifactId`, `prId`, `subscriptionId`.
- `requestId`: caller-created idempotency key for a command attempt.
- `correlationId`: one value propagated across a voice request, command, server work, events, artifacts, and PR operations.
- `eventId`: globally unique immutable event ID.
- `eventSequence`: monotonically increasing per environment (or per thread where explicitly stated); never reused.

Every response uses this envelope:

```json
{
  "schemaVersion": "3",
  "requestId": "req_...",
  "correlationId": "corr_...",
  "serverTime": "2026-09-03T12:00:00Z",
  "data": {},
  "warnings": []
}
```

Errors are structured and stable:

```json
{
  "schemaVersion": "3",
  "error": {
    "code": "approval_required",
    "message": "Approval is required before this action can run.",
    "retryable": false,
    "requestId": "req_...",
    "correlationId": "corr_...",
    "environmentId": "env_...",
    "details": {}
  }
}
```

Unknown response fields must be ignored. New enum values require an `unknown`-safe client path. Existing v1 tools retain their names and required fields where practical; additive optional fields and new v3 tools are preferred over changing old meanings.

## 6. Thread lifecycle

### 6.1 States

The canonical states are:

`queued`, `running`, `waiting-approval`, `waiting-input`, `completed`, `failed`, `canceled`, `interrupted`.

Each state transition includes `from`, `to`, `reason`, `at`, `actor`, `correlationId`, and `eventId`. Terminal states are `completed`, `failed`, and `canceled`; `interrupted` is resumable and must say whether resume is available. A stopped or paused operation must not be reported as completed.

### 6.2 Commands

Expose lifecycle commands as MCP tools and equivalent Gateway Runtime Port methods:

- `t3_create_thread` (existing name, extended with profile/override snapshot and correlation ID)
- `t3_send_message`
- `t3_stop_thread` — request cooperative stop; return receipt and resulting state when known.
- `t3_cancel_thread` — cancel queued/running/waiting work; safe to repeat.
- `t3_pause_thread` / `t3_resume_thread`
- `t3_retry_thread` — retry the failed/interrupted operation with a new attempt ID, retaining history.
- `t3_restart_thread` — start a fresh execution attempt from the thread's selected restart point; never erase history.
- `t3_get_thread`, `t3_get_messages`
- `t3_summarize_thread` — return status, summary, blockers, artifacts, approvals, PR state, and next action from the authoritative snapshot.

Mutating tools require an explicit `requestId` and are idempotent. Repeating the same command with the same `(environmentId, threadId, requestId)` returns the original receipt/result. Reusing a request ID for a different payload is `idempotency_conflict`. Commands against an unknown or terminal-incompatible state return a typed, non-retryable error rather than silently changing state.

A command result is a receipt:

```json
{
  "operationId": "op_...",
  "requestId": "req_...",
  "correlationId": "corr_...",
  "acceptedAt": "...",
  "status": "accepted",
  "threadId": "thread_...",
  "currentState": "queued",
  "nextAction": "await_event"
}
```

## 7. Events, streaming, and delivery

### 7.1 Event types

The event stream includes at minimum:

`thread.started`, `thread.state_changed`, `thread.progress`, `thread.milestone`, `thread.blocked`, `thread.completed`, `thread.failed`, `thread.canceled`, `thread.interrupted`, `approval.requested`, `approval.updated`, `input.requested`, `artifact.created`, `artifact.updated`, `pr.updated`, `environment.health_changed`.

Every lifecycle/completion event contains `machine`, `project`, `threadTitle`, `status`, `summary`, and `nextAction` where applicable. Progress events may include `milestone`, percent only when meaningful, provider/runtime label, and a redacted blocker. Events must not contain provider secrets, raw access tokens, or unrestricted host paths.

### 7.2 Subscription and webhook contract

Support both transports with one event model:

- `t3_subscribe_events`: durable subscription over MCP/bridge for clients that can keep a session.
- `t3_register_webhook`: register an HTTPS endpoint and event/filter configuration; return a secret reference, not the secret in subsequent reads.
- `t3_update_webhook`, `t3_delete_webhook`, `t3_replay_events`.

Webhook delivery is POST with `Content-Type: application/json`, `X-T3-Event-Id`, `X-T3-Event-Sequence`, `X-T3-Correlation-Id`, and an HMAC signature using a secret configured by the authorized client. The body is the versioned event envelope. TLS is mandatory; loopback HTTP is allowed only for explicitly local development and is not a production acceptance path.

The receiver acknowledges with HTTP 2xx and may include `X-T3-Ack-Sequence`. A subscription client acknowledges with `t3_ack_events(subscriptionId, throughSequence)`. Delivery is at-least-once. The sender retries 5xx, network failures, and timeouts with bounded exponential backoff and records delivery attempts. It stops retrying after the configured retention window and reports a durable `delivery.failed` event/health condition.

Reconnect uses `afterSequence` (or `afterEventId` when sequence scope is known). The server replays retained events strictly in sequence order, then resumes live delivery. If the cursor is older than retention, return `cursor_expired` with a fresh snapshot requirement; do not pretend the stream is complete. Consumers dedupe by `eventId`; acknowledgements are monotonic and idempotent. A reconnect must never rerun a command or create a second webhook side effect.

Default retention: 7 days or 100,000 events per environment, whichever is reached first; operators may increase it. Event payloads are immutable. Delivery state is separate from event history.

## 8. First-class artifacts

Artifacts are durable records attached to a thread, operation, approval, or PR. Supported kinds: `image`, `screenshot`, `file`, `patch`, `log`, `document`, `pr_link`, and `check_report`.

```json
{
  "artifactId": "artifact_...",
  "kind": "screenshot",
  "name": "preview.png",
  "mediaType": "image/png",
  "sizeBytes": 12345,
  "sha256": "...",
  "environmentId": "env_...",
  "threadId": "thread_...",
  "createdAt": "...",
  "source": { "type": "workspace", "relativePath": "artifacts/preview.png" },
  "availability": "available",
  "metadata": { "redacted": false }
}
```

Artifacts must be authorized through the owning environment/thread scopes. Retrieval returns a bounded stream or signed, short-lived URL for the exact artifact; it never grants directory access. Large logs and documents support ranges/pages. Patches retain base revision, target revision, and file list. PR links include provider, repository, PR number, URL, draft state, checks, and unresolved review count.

Cross-machine retrieval means the authorized client can fetch from the owning environment through the existing connection/relay path. It does not copy artifacts into a central service unless an explicit future storage feature is approved. An artifact created event precedes or accompanies availability; clients must handle `pending`, `available`, and `failed` states.

## 9. Profiles, defaults, and permissions

### 9.1 Named profiles

Profiles are first-class named bundles visible in Settings and discoverable through MCP. A profile is not an anonymous global default. It has:

- stable `profileId` and user-visible `name` (for example, `Andy`);
- human-readable provider and model selection (for example, `OpenAI` / `GPT-5.3`);
- human-readable reasoning/effort setting (for example, `Medium`);
- runtime permission mode: `full-access`, `approval-required`, or `read-only`;
- approval policy and destructive-action policy;
- optional interaction mode, environment allowlist, and provider-specific settings;
- `revision`, `createdAt`, `updatedAt`.

The profile `Andy` example must be representable as a supported provider/model label such as `OpenAI` / `GPT-5.3`, `Medium` reasoning, and full access on selected T3 environments. Profile names are user data and may be renamed without changing historical snapshots. Provider instance IDs and model IDs are implementation details and are not profile fields or persisted profile data. The server may use transient option keys while resolving a selection, but the profile snapshot supplied to the agent is readable text.

A profile is selected by `profileId`; the server snapshots the resolved profile revision into the thread at creation. Editing/deleting a profile affects future threads only. Existing threads retain their model/runtime/permission snapshot unless an explicit thread override command is accepted.

### 9.2 Settings UX: grants and readable profile selections

The Settings screen keeps MCP as an optional sidecar over the ordinary T3 connection. MCP has one prominent enable/disable control. When disabled, Settings must not create an MCP listener, session, or credential, and the ordinary T3 path remains unchanged.

Grant editing is a machine-first matrix using the existing environment rows and `read`, `create`, and `send` capabilities:

- Each machine has one default access control: `Off` or `On`. `On` applies the selected baseline grant set for that machine; it is not ten independent checkboxes.
- Provide a `Select all` action for the visible machine list. It selects all currently listed machines, is safe on an empty list, and must not silently grant newly discovered machines later. A mixed selection is shown as indeterminate; selecting it selects all, and selecting again clears all. The action changes only the local pending form until Save.
- Individual machines are adjusted through a dropdown/menu opened from the machine row. The menu offers the baseline `Off`/`On` choice and, when the product exposes finer capabilities, the existing grant names (`Read`, `Create`, `Send`) as a compact tweak surface. Do not render a wall of per-capability tick boxes for every machine.
- The UI must show unsaved changes, support Cancel/Reset, and make Save explicit. Saving replaces only the edited grant entries. A grant is evaluated at call time; revoking it prevents subsequent calls but does not retroactively cancel work already accepted by T3.
- `Select all` is a convenience action, not an authorization bypass: server-side environment scopes and profile permissions still intersect with the MCP grant, and a denied or disconnected machine remains unavailable.

Named profile editing is also human-first:

- Provider is a required dropdown populated from the provider catalog T3 currently supports for the selected environment/account. Do not show or ask users to enter a provider instance ID.
- Model is a required dropdown filtered to models offered by the selected provider. Each option uses a human display label and may include a concise capability/context note. Do not show or ask users to enter a model ID. If the provider changes, clear an incompatible model rather than preserving a stale selection.
- Reasoning/effort and access/permission use labeled controls (`Low`/`Medium`/`High` where supported; `Full access`/`Approval required`/`Read only` as applicable), with explanations in words.
- The persisted profile representation contains the profile name plus readable provider, model, reasoning, access, approval, and optional environment-scope text. It must be understandable in a profile summary and in the agent context without decoding IDs. Provider/model IDs, credentials, and raw API configuration are never placed in that text.
- Discovery may return opaque IDs to correlate an option during the current edit, but those IDs are ephemeral and must not be serialized into the profile, agent-facing snapshot, audit text, or MCP response intended for user display. If a supported provider/model disappears, mark the profile unresolved with a readable warning and require re-selection before creating a new thread.

The profile summary should read as a sentence, for example: `Andy — OpenAI GPT-5.3, medium reasoning, full access, approval required for destructive actions; available on Office Mac and Build PC.` The exact labels may follow the provider catalog, but raw IDs must never be the primary or fallback UI.

### 9.3 Precedence

Resolve each setting in this order:

`thread override > selected named profile > provider default > global default > product fallback`.

For a thread created without a profile, the provider/global chain applies. Provider defaults are keyed by provider identity and must not leak across providers. The effective configuration and its source for each field are returned in read APIs. Changing any default never mutates existing threads.

### 9.4 Capability enforcement

MCP grants are coarse host/environment capabilities (`read`, `create`, `send`, and new explicit lifecycle/approval/artifact/review/admin scopes). The T3 server's OAuth-style environment scopes remain authoritative. Effective permission is the intersection of MCP grant, server session scope, profile permission, and thread state.

A call a server relays through a connected app runs only on an app whose own grant covers that call's scopes ([portScopes](../../packages/client-runtime/src/gateway/portScopes.ts)), and that app checks them again; grants of different apps never combine. A relayed call runs there as the app's user, so the calling server refuses work above the calling chat's modes before relaying it.

Never infer `full-access` from a missing approval plan. `read-only` cannot create, send, mutate lifecycle, approve, or write git. A profile may reduce capabilities granted by the host but may not elevate them. Profile and permission changes emit audit events.

## 10. Approval plans

Risky operations produce an approval plan before execution. The plan groups related actions with stable `approvalActionId`s, risk, affected paths/resources, proposed command/tool, reversibility, and whether destructive confirmation is required.

MCP tools:

- `t3_respond_to_approval` (one pending request at a time; `t3_summarize_thread` reports the current plan)

Approval decisions are idempotent by `requestId` and actor, and fail closed when the request is no longer pending. Destructive actions (deleting files, force-push, publishing non-draft changes, terminating processes, changing access, or equivalent provider actions) require a separate explicit `confirmDestructive: true`; ordinary approval cannot satisfy that gate. Every decision emits `approval.updated` with approved/rejected/modified/pending counts.

## 11. Git, PR, and code review workflow

Support repositories on the `jayleaton/t3code` fork and configured upstream repositories without ever pushing to `pingdotgg/t3code`. The repository target is explicit in every write operation: owner, repository, base branch, head branch, and fork/upstream role.

MCP tools:

- `t3_git_status`, `t3_get_diff`, `t3_apply_patch`
- `t3_reclaim_worktree` (removes a finished thread's T3-managed checkout while keeping its binding; refuses with reasons, `dryRun` reports only)
- `t3_create_branch`, `t3_commit_changes`
- `t3_create_pr` (draft by default)
- `t3_update_pr`, `t3_get_pr`, `t3_get_pr_checks`
- `t3_list_review_comments`, `t3_reply_review_comment`, `t3_apply_review_fixes`
- `t3_publish_pr` (requires explicit approval and destructive confirmation when applicable)

Return PR URL, repository identity, head/base refs, draft state, checks summary, and unresolved review count. Review comments map to file path, side, line, commit SHA, and comment ID. A comment remains unresolved until the corresponding fix is pushed and the review state is refreshed; never mark a comment resolved merely because a patch was generated or locally applied. If the head changed, stale comments are reported for remapping rather than guessed.

Default branch safety: create a draft PR from the fork, use least-privilege credentials, and require approval for push, force-push, publish, merge, and branch deletion. The gateway must reject any repository target outside the configured allowlist.

## 12. Discovery, health, and observability

Provide:

- `t3_list_environments` with connection route type, machine label, OS, T3 version, capabilities, and authorization summary.
- `t3_get_environment_health` with connection phase, last successful probe, provider/runtime readiness, event-stream readiness, artifact store readiness, and degraded reasons.
- `t3_get_gateway_health` with bridge, MCP transport, webhook queue, event retention, and clock status.
- `t3_get_operation_history` with bounded pagination/cursors.

Health must distinguish disconnected, connecting, connected-but-degraded, and healthy. Do not report cached data as live. Observability records correlation ID, request ID, environment/thread IDs, latency, retry count, result code, and actor while redacting text, secrets, tokens, and file contents by default. Metrics include command acceptance latency, event lag, webhook delivery/retry/failure, replay count, duplicate suppression, and approval wait duration.

## 13. Security and privacy requirements

- Keep the bridge loopback-only by default; require an explicit operator setting for any non-loopback bind.
- Preserve challenge/proof authentication and constant-time proof comparison; reject short tokens.
- Never put bearer credentials, bridge tokens, webhook secrets, or access tokens in URLs, event bodies, logs, or artifacts.
- Validate environment, project, thread, artifact, repository, and comment ownership server-side on every call.
- Use existing environment auth scopes and short-lived WebSocket tickets rather than inventing a parallel credential model.
- Sign webhooks with HMAC, require TLS, and support secret rotation without dropping the event cursor.
- Redact provider output and host paths unless the caller has the corresponding read scope.
- Bound payloads, artifact sizes, replay windows, webhook retries, and concurrent subscriptions.
- Audit all mutations, approval decisions, profile changes, access changes, pushes, and PR operations.

## 14. Compatibility and rollout

Phase 1: extend the existing bridge/runtime port with stable lifecycle, event, artifact, profile, approval, health, and PR contracts; retain existing read/create/send tool names and behavior. Add event delivery and replay before exposing voice-agent workflows.

Phase 2: add Settings UI for named profiles, provider/global defaults, permissions, webhook/subscription status, and event cursor/health. Keep MCP disabled by default and preserve the stock T3 path when disabled.

Phase 3: enable production fork PR workflows and real multi-machine acceptance testing over Tailscale. Draft PRs and approval gates remain default.

Every contract change is additive where possible, schema-versioned, tested against an older v1 MCP client, and documented in the package export. No migration may invalidate existing threads or mutate their resolved configuration.

## 15. Acceptance tests

The release is accepted only when all of these pass against production builds and real connected environments:

1. From a voice-capable MCP client, discover a second machine through an existing paired environment and create a thread using named profile `Andy`.
2. Verify the thread snapshots the selected human-readable provider/model, medium reasoning, full-access policy, and selected profile revision; change the profile and verify the running thread is unchanged.
3. Receive start, progress/milestone, waiting-input or waiting-approval, and completion events without polling.
4. Drop the connection, reconnect with the last acknowledged sequence, replay missing events in order, and verify duplicate event IDs are safely ignored.
5. Repeat a create/send/stop/approve request with the same request ID and verify exactly one side effect and the original receipt.
6. Pause/resume, stop/cancel, retry a failure, and restart an interrupted thread; verify canonical states and durable history.
7. Retrieve an image, screenshot, file, patch, log/document, and PR link from the owning remote environment with authorization enforced.
8. Approve one pending action, reject another, and verify destructive confirmation is separately required.
9. Create a draft PR on `jayleaton/t3code`, return URL/checks/unresolved count, apply a review fix, push it, and verify comments remain unresolved until refreshed against the pushed commit.
10. Exercise disconnected, degraded, webhook retry, cursor-expired, unauthorized, stale-plan, stale-comment, and artifact-failed paths with typed errors.
11. Disable MCP and verify no MCP socket/session/credential is created and ordinary T3 local/remote operation remains unaffected.
12. Run focused package tests, schema/type checks, and production packaging checks for the changed surfaces; do not claim voice-agent acceptance from mocks alone.
13. In Settings, verify `Select all` selects and clears only the visible machine rows, mixed state is indeterminate, new machines are not implicitly granted, individual rows use the compact dropdown, and Save/Cancel behavior is explicit.
14. Create/edit named profile `Andy`, verify the provider catalog and provider-filtered model dropdown contain display labels, and inspect persisted/profile-agent text to confirm it contains no provider instance ID or model ID.

## 16. Implementation handoff

The implementation task must begin from this specification and the approved sidecar commit. It must not add application code to this product-spec change, reopen the sidecar decision, merge a PR, or contact the upstream `pingdotgg` repository. Any capability that cannot be demonstrated on a real connected machine must remain explicitly marked incomplete rather than represented as a simulated success.
