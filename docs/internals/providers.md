# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with six entries:

| Driver kind   | Driver source                                 |
| ------------- | --------------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]             |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]           |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]           |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]               |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode]       |
| `antigravity` | [`Drivers/AntigravityDriver.ts`][antigravity] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Codex async questions

Codex 0.153 exposes `request_user_input_async` through `item/started` and `item/completed`
notifications. The item has `type: "agentMessage"`, `delivery: "async"`, and a `questions` array.
Each question has a `title` and an optional `options` array of strings. The tool returns `{"accepted":true}`
without waiting. This is separate from the `item/tool/requestUserInput` server request.
See the [Codex tool handler](https://github.com/openai/codex/blob/d979df154cf60e13eafb5453e75b6d84f21c67bf/codex-rs/core/src/tools/handlers/request_user_input_async.rs).

The Codex adapter maps completed question items to `user-input.requested` with
`responseMode: "message"` and stable request and event IDs. Questions use the existing web,
desktop, and mobile panels. They stay pending while the turn runs and after it finishes.

The engine reads the request's latest stored activity before deciding a reply. This works after
startup, when the command snapshot has no activities, and after a resolution leaves the recent
activity window. The query returns one activity, not the full thread history.

For these requests, the decider saves the resolution and a user message in one transaction.
The standard turn path delivers the message, including session resume and active-turn input.
It does not send a JSON-RPC response to Codex. Other providers and blocking Codex questions
keep their existing response paths.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

`ProviderService.sendTurn` expands [assistant citations](./assistant-citations.md) into quoted
reference data before dispatching to any adapter. Bound user comments remain distinct from the quoted
assistant text. Persisted messages keep their serialized links.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

### Grok health check

`checkGrokProviderStatus` never opens an ACP session. It runs `grok --version`, then `grok models`
for login state and model slugs, then a single ACP `initialize` and reads models from
`_meta.modelState`. `authenticate` and `session/new` are skipped on purpose: `authenticate` can open
a browser login and `session/new` boots every configured MCP server, both of which made background
probes hang or surprise the user. A failed `initialize` degrades to `warning` with the CLI's model
list instead of persisting `error` over a working install. The built-in `grok-build` slug is the
CLI's product name, not an ACP model id. `applyGrokAcpModelSelection` treats it as "keep the
session's current model" and never sends it in `session/set_model`.

## Antigravity ownership and protocol

[`AntigravityDriver`][antigravity] uses Google's official ACP executable. The instance config
selects the ACP auth method: `oauth-personal` (default), `oauth-business`, `gemini-api-key`, or
`agent-platform`. The two OAuth methods share the loopback sign-in flow below. The API key
methods pass the configured key to the agent as `GEMINI_API_KEY` or `GOOGLE_API_KEY` and never
open a browser. A GCP project and location are written to the profile's `settings.json` on each
launch. The driver never reuses CLI credentials or ambient `GOOGLE_*` variables and never falls
back to another method. Antigravity is disabled by default and supports multiple provider
instances. The open driver and instance identifiers require no database migration.

### Runtime installation

[`AntigravityInstallation`][antigravity-installation] belongs to the environment, outside
WebSocket and provider-instance scopes. Instances share an explicit download operation and the
completed runtime. Client disconnects and instance rebuilds do not cancel installation.

The fixed [release table][antigravity-release] contains official Google URLs, SHA-256 hashes,
archive sizes, and the exact executable pair for each published host. Downloads stream to disk.
Lazy `yauzl` entry streams extract only that pair, with member names, types, duplicates, and
sizes checked. Validation runs ACP `initialize` in a temporary profile without authentication
or a session. Progress updates are bounded, not sent for every network chunk.

Complete releases live in immutable version directories under the T3 home
`tools/antigravity-acp/<platform>-<arch>/versions`. An atomic `active.json` change selects the
release for new processes. Each process holds a version lease until it exits. Updates do not
replace running executables. Removal refuses active leases or explicit binary paths that still
reference the managed files. Failure or cancellation removes owned partial files, not the
previous release or account data.

Resolution order is explicit `binaryPath`, active managed release, then the instance's `PATH`.
An invalid explicit path fails without fallback. Manual installations are never changed by the
installer. Every launch pins `ANTIGRAVITY_HARNESS_PATH` to the selected executable's sibling.

### Google profiles and sign-in

Each instance owns a stable profile at
`<stateDir>/providers/antigravity/<sha256(instanceId)>`.
[`antigravityAuthSupport.ts`][antigravity-auth-support] sets `GEMINI_HOME` to this directory and
`AGY_ACP_FORCE_FILE_STORAGE=1` after merging instance environment variables. File storage avoids
the official macOS keychain entry being shared across instances. Profile directories use mode
`0700` on POSIX. This is file storage, not an encrypted keychain. Windows uses the host profile's
filesystem permissions.

The launch environment removes API-key and cloud-billing variables, disables inherited
environment extension, sets `PYTHONUNBUFFERED=1`, and controls `BROWSER`. A tested Node or
Electron-as-Node helper prevents the official agent from opening a browser on the environment.
The same launch factory serves setup, health checks, chat, and text generation.

The official agent prints a non-JSON OAuth line on stderr in version 1.1.1. Earlier versions
print it on stdout. T3 accepts the exact native prefix on either stream and its browser-helper
marker on stderr. Fragmented lines are joined and bounded. Other malformed protocol output
remains fatal. Authorization URLs are validated before use. Other stderr is discarded because
it can contain OAuth data. Normal work rejects an interactive login request with a
sign-in-required error instead of waiting for consent. A rejected stderr callback fails pending
ACP requests and closes the owned process.

[`AntigravityAuth`][antigravity-auth] owns each sign-in process and deadline in the instance
scope. Only the initiating T3 auth session receives its URL and flow ID or can complete or
cancel it. Other clients receive busy state without those values. Subscriptions follow
controller replacement when settings rebuild an instance.

For remote completion, the client sends the full return URL through the typed setup RPC.
The server validates the pending loopback origin, port, root path, and single matching state
before forwarding once to the owned listener. It does not probe the listener or follow
redirects. Google's process owns PKCE, token exchange, refresh, and storage. Callback HTTP
success is not authentication success. The controller waits for authenticated session setup
and catalog discovery. Cancellation closes the process instead of sending a synthetic denial.

Auth RPCs `provider.auth.start`, `complete`, `cancel`, `logout`, and `subscribe` require
`orchestration:operate`. Install `start`, `cancel`, and `remove` use that scope too.
`provider.install.subscribe` and public provider snapshots require `orchestration:read`.
[`providerSetup.ts`][provider-setup] defines the operation IDs, states, and safe errors.

Sign-out closes process admission for the instance, stops provider bindings through
[`ProviderAuthService`][provider-auth-service], then stops owned startup and helper processes.
A fresh official process calls `initialize` and native `logout` without authenticating.
Only then does the provider clear auth, models, commands, skills, and workspace metadata.
Thread history and native session files remain. Settings sign-out and a text-only `/logout`
use this same path. The command is handled before model prompting or title generation.
Disabling an instance closes its processes but keeps credentials. Account replacement is
explicit sign-out followed by sign-in.

### Sessions, models, and client capabilities

[`AntigravityAdapter`][antigravity-adapter] owns one ACP process per active thread. It uses
native `session/resume` without transcript replay and reapplies the persisted model and
permission mode after new or resumed setup. An unavailable explicit model fails instead of
accepting the native default. Steering cancels the previous prompt, waits for its result and
event drain, then sends the replacement. Native background commands use T3's existing
background-task state.

The permission mapping is `approval-required` and `auto` to `default`, `auto-accept-edits` to
`auto_edit`, and `full-access` to `yolo`. Native requests still need replies in `yolo`.
`interaction_` requests are user questions, not approvals. T3 keeps opaque option IDs in
`UserInputQuestion.options[].value` and sets `allowCustomAnswer=false`. Both clients preserve
these values. Ordinary approval replies use only offered option IDs, including `allow_always`
only when present. Existing providers keep their prior behavior when the optional fields are
absent.

`showInteractionModeToggle=false` keeps native `/plan` separate from T3 Plan mode.
`supportsConversationRollback=false` hides unsupported client actions and makes checkpoint
revert fail before filesystem changes. Checkpoint capture and diffs remain supported.

Automatic status refreshes, reconnects, and workspace checks do not open catalog sessions.
Health probes use `initialize` only. Disabled instances do not run background probes.
An explicit `serverRefreshProviders` request with `refreshModels: true` calls the driver's
optional `refreshModels` operation. Antigravity opens a short-lived catalog session under the
instance's process admission guard, uses saved credentials, publishes models and commands,
then closes the process. An interactive login request fails with sign-in required. Web's
**Refresh provider status** and mobile's **Refresh models** actions request this operation.
Account access starts unknown and becomes authenticated after successful session setup,
including an explicit model refresh.
The [provider snapshot][antigravity-provider] takes models and commands from setup and native
updates. It preserves returned Gemini model IDs, labels, order, and thinking-level choices.
ACP `config_option_update` notifications and `session/set_config_option` responses replace
the instance's model catalog. Child session notifications do not change the root catalog.
The registry treats a successful empty catalog as authoritative and clears cached metadata
after sign-out. It must not retain a previous account's models. Cached models do not prove
current access. The auth response does not supply an email, plan tier, or reliable quota.

Some upstream failures arrive as assistant text followed by `end_turn`. Preserve that message
without treating model-written text as a structured error or successful task completion.

### Text generation

[`AntigravityTextGeneration`][antigravity-text] implements titles, branch names, commit text,
and PR text through the same instance and Google sign-in. Each helper uses a temporary empty
workspace, no injected MCP servers, native `default` mode, and explicit denial of tools and
questions. Output is bounded, parsed against the existing schemas, and sanitized. Cancellation,
timeout, and sign-out close the process. Cleanup removes only that helper's verified temporary
native session files.

The official agent has no verified hard no-tools setting. Global hooks and MCP configuration
can run before a prompt. Helpers check the profile's `config/hooks.json` and
`config/mcp_config.json` before launch and reject nonempty, malformed, or oversized
configuration. `supportsTextGeneration=false` keeps such an instance out of system-model
pickers. Empty managed profiles are supported. Do not describe prompt-time denial as a native
sandbox.

## OpenCode server ownership and catalog

Each OpenCode provider instance owns one lazy local server for catalog discovery and
text-generation helpers through [`OpenCodeServerOwner.ts`][opencode-server-owner]. Concurrent
borrowers share startup. The server closes 30 seconds after the last borrower releases it, or
when the provider instance closes. A failed or exited process can be started again on the next
use. An externally configured OpenCode server remains externally owned.

The local server and its SDK clients use one resolved password. An explicit provider password
overrides `OPENCODE_SERVER_PASSWORD` in the spawned environment. Without an explicit password,
the client uses the password from the environment that the process inherits. External servers use
only their explicit provider password and never inherit the host's local password.

Every server connection must pass the authenticated `/global/health` check before inventory or
session operations start. The response must contain a valid version at or above 1.14.19. Local
owners cache this result for the lifetime of the spawned process. External actions check once when
they create their server connection, not for each model or SDK request.

Chat adapters keep their own server per thread. They register a thread-specific `t3-code` MCP
connection, while OpenCode stores MCP connections by directory. Sharing these chat servers
without changing MCP routing would let two threads in one directory replace each other's
connection.

Chat adapters send the runtime mode as a session ruleset, but upstream OpenCode evaluates
doom-loop and subagent asks against the agent ruleset only. In full access the adapter answers
those asks itself so the user never sees an approval they already granted. It replies `once`
rather than `always` because OpenCode stores `always` grants per directory, and on a shared
external server that would widen what a supervised thread in the same directory may do.

OpenCode loads its catalog through the HTTP API when an enabled provider instance starts. The
provider registry keeps the snapshot in memory and persists it in the existing per-instance cache.
Each `subscribeServerConfig` connection refreshes all providers, so a client reconnect reloads the
OpenCode catalog from the current helper. The `serverRefreshProviders` request also refreshes it.
Periodic OpenCode probes remain disabled. OpenCode reads credentials for each inventory request,
but its native configuration files can remain cached for the lifetime of the helper process. The
helper closes 30 seconds after its last inventory or text-generation borrower releases it. A
refresh after that idle period starts a new helper and reads file changes. Repeated refreshes and
active text-generation work can extend process reuse. Changes to the provider configuration or
environment replace the instance and start a new discovery. Changes to unrelated settings only
update snapshot enrichment. Other providers retain their existing refresh policy.

T3 Code does not own an external OpenCode process. Native configuration changes there can require
an external reload or restart before T3 Code's next refresh sees them.

The shared server's idle shutdown does not clear the catalog. Failed discovery keeps the last
known models, slash commands, and skills through the registry's existing merge rules. A successful
empty inventory is authoritative. Existing threads keep their explicit model identifier and
options when catalog metadata is missing; the catalog is not permission to choose a different
model for a thread.

## Model manifest

The model picker's legacy section is driven by `apps/server/src/provider/model-manifest.json`, which
lists the current (non-legacy) model slugs per driver kind. The `ModelManifest` service
(`apps/server/src/provider/ModelManifest.ts`) refreshes that data from the same file on `main` via
raw.githubusercontent.com, so moving a model in or out of the legacy section is a commit, not a
release. Preference order is remote fetch, then the on-disk copy of the last successful fetch (in
the state directory), then the bundled copy. Fetches are TTL-gated, run concurrently with provider
probes, respect the `enableProviderUpdateChecks` setting, and never fail a provider check. The
Codex and Claude drivers apply the classification to every snapshot with `applyModelManifest`;
driver kinds absent from the manifest have no legacy concept.

## Attachment access

The server stores uploaded attachments in its attachment directory, outside the project workspace.
`ProviderService` adds the absolute path of each attachment to the turn text, then passes every
attachment to the provider adapter. Each adapter decides what its provider ingests natively:

- Codex, Claude, Cursor, and Grok send images as native image inputs and skip generic files. For
  these providers, generic files reach the agent only as file paths in the turn text.
- Antigravity sends BMP, JPEG, PNG, and WebP images and common audio formats as native blocks,
  text files as embedded resources, and PDFs as resource links. Other files are rejected with an
  error instead of being dropped. The session advertises the ACP client file system capability,
  so workspace reads and writes come back through `fs/read_text_file` and `fs/write_text_file`
  and are confined to the workspace and the attachments directory.
- OpenCode sends PNG/JPEG/GIF/WebP images, text files, and PDFs up to 20 MB as native file parts
  with their real mime type. Everything else (ZIP and other binaries, image formats model APIs
  reject, oversized files) falls back to the file path in the turn text, like the other providers.
- Antigravity sends BMP/JPEG/PNG/WebP images as native image blocks, UTF-8 text as embedded
  resources, and PDFs as local resource links. Text is limited to 1 MiB per file, images to
  10 MiB each, and all attachments to 50 MiB per turn. Unsupported formats or oversized inputs
  fail explicitly. Native path permissions still apply to PDFs.

Claude receives the attachment directory as an allowed additional directory. Codex keeps its
configured sandbox policy, so access depends on that policy and the selected runtime mode. OpenCode
allows all paths in full-access mode and requests approval for directories outside the workspace in
restricted modes. Cursor and Grok use their own provider permission rules.

The server does not copy attachments into a project or bypass provider approval rules. If an agent
cannot read an attachment, the user must approve the access or select a runtime mode that permits it.

Updated attachment schemas tolerate unknown attachment members, but old image-only clients still
cannot decode messages that contain file attachments. Client file-picking rollouts must account for
this limit.

Do not run an old image-only server against state that contains file attachments. Replay decodes
each persisted event before projection. A file-bearing event can make `ProjectionPipeline` bootstrap
and `OrchestrationEngine` startup fail for the entire environment, not only the affected thread.

## How provider work is requested

Clients never call a provider directly. They dispatch orchestration commands over the RPC method
`orchestration.dispatchCommand`, defined with the rest of the orchestration surface in
[`orchestration.ts`][contracts]. The client-dispatchable provider-facing commands are
`thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
`thread.user-input.respond`, `thread.checkpoint.revert`, and `thread.session.stop`, plus the mode
setters `thread.runtime-mode.set` and `thread.interaction-mode.set`.

The engine persists an event for the command, and a server-side reactor performs the provider call.
Provider output comes back as internal commands such as `thread.message.assistant.delta` and
`thread.session.set`, which clients observe through `orchestration.subscribeThread`. See
[overview.md](./overview.md) for the command/event loop.

## Server-side workers

Provider work flows through three queue-backed workers. All three are built with
`makeDrainableWorker` from [`DrainableWorker.ts`][worker] and expose `drain` for deterministic test
synchronization.

1. [`ProviderRuntimeIngestion`][ingest] consumes provider runtime streams and emits orchestration
   commands.
2. [`ProviderCommandReactor`][cmd] reacts to orchestration intent events and dispatches provider
   calls.
3. [`CheckpointReactor`][checkpoint] captures workspace checkpoints on turn start and completion, and
   performs reverts.

### Buffered assistant delivery

A thread in `buffered` assistant delivery mode accumulates assistant text instead of streaming each
delta. The buffer is not held until turn completion. In [`ProviderRuntimeIngestion`][ingest],
`MAX_BUFFERED_ASSISTANT_CHARS` is 24,000: the append that would exceed it invalidates the buffer and
spills the whole accumulated text as one delta. The buffer also flushes at interaction boundaries,
when a request opens (approval) or user input is requested, via
`flushBufferedAssistantMessagesForTurn`.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[antigravity]: ../../apps/server/src/provider/Drivers/AntigravityDriver.ts
[antigravity-adapter]: ../../apps/server/src/provider/Layers/AntigravityAdapter.ts
[antigravity-provider]: ../../apps/server/src/provider/Layers/AntigravityProvider.ts
[antigravity-installation]: ../../apps/server/src/provider/AntigravityInstallation.ts
[antigravity-release]: ../../apps/server/src/provider/antigravityRelease.ts
[antigravity-auth]: ../../apps/server/src/provider/AntigravityAuth.ts
[antigravity-auth-support]: ../../apps/server/src/provider/antigravityAuthSupport.ts
[antigravity-text]: ../../apps/server/src/textGeneration/AntigravityTextGeneration.ts
[provider-auth-service]: ../../apps/server/src/provider/Layers/ProviderAuthService.ts
[provider-setup]: ../../packages/contracts/src/providerSetup.ts
[opencode-server-owner]: ../../apps/server/src/provider/OpenCodeServerOwner.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
