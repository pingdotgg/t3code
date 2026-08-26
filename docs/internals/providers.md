# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with five entries:

| Driver kind   | Driver source                           |
| ------------- | --------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]       |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]     |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]     |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]         |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. Adapter implementations live beside them in
`apps/server/src/provider/Layers/` (`CodexAdapter.ts`, `ClaudeAdapter.ts`, and so on) and conform to
[`ProviderAdapter.ts`][adapter]. Read the driver plus its adapter to see how a specific agent's
transport, config, and event shapes are mapped.

## Registry and routing

Two registries separate configuration from live processes:

- [`ProviderInstanceRegistry`][instances] keys configured instances by `ProviderInstanceId`. Creating
  one looks up the driver by `driverKind`, decodes `entry.config` with that driver's schema, opens a
  child scope, and calls `driver.create`.
- [`ProviderAdapterRegistry`][registry] resolves an instance ID to its live adapter via
  `getByInstance`.

[`ProviderService`][service] sits on top. It combines the adapter registry with the provider session
directory to route session and turn operations for a thread, so callers name a thread, not an agent.

Adding a driver means writing the driver plus adapter and adding it to `BUILT_IN_DRIVERS`. No
orchestration, contract, or client change is required for the common case.

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

## Grok Build ACP mapping

The Grok driver runs `grok agent stdio`. The shared ACP runtime owns protocol negotiation, session
setup, replay, configuration state, and standard session updates. The Grok adapter adds the xAI
extensions that have stable wire shapes and a direct canonical T3 meaning.

| Grok Build input                   | T3 behavior                                                    |
| ---------------------------------- | -------------------------------------------------------------- |
| ACP model state and model metadata | Provider models, context windows, and reasoning choices        |
| `session/set_model`                | Atomic model plus `_meta.reasoningEffort` selection            |
| `agent_thought_chunk`              | Canonical reasoning item and delta events                      |
| `session_info_update`              | Thread title update                                            |
| `usage_update`                     | Context-window update                                          |
| Prompt response `usage`            | Turn completion usage                                          |
| Prompt response xAI `_meta`        | Context usage, last-call tokens, model usage, and trusted cost |
| xAI `model_changed`                | Live model and reasoning synchronization                       |
| xAI `ask_user_question`            | Structured T3 user-input request and response                  |
| xAI prompt-complete notification   | Fallback settlement when the standard prompt RPC hangs         |

`grok-build` is a compatibility sentinel in T3, not a model forced onto the CLI. When selected, the
adapter retains the model reported by session setup. A concrete model or reasoning change uses
`session/set_model`; changing effort on the same model still sends the request.

### Deliberate boundaries

Several Grok Build notifications do not yet have a truthful adapter-only mapping:

- ACP `available_commands_update` is session and workspace scoped, while provider slash commands in
  T3 are currently instance-wide. This needs a per-session command contract before it can be shown.
- xAI model-catalog update notifications arrive on a live adapter session, while provider snapshots
  are owned by the driver. Dynamic refresh needs an explicit adapter-to-driver invalidation channel.
- Grok Build 1.0.5 does not advertise ACP modes. Newer source accepts `session/set_mode`, but its
  `x.ai/exit_plan_mode` approval request needs a dedicated T3 plan-approval flow. The Plan control
  stays hidden until both mode switching and exit approval can be represented truthfully.
- Private xAI hooks, MCP status, queue, subagent, and workflow notifications need pinned schemas and
  canonical lifecycle semantics before ingestion. Unknown extension notifications remain available
  in native provider logs.
- ACP reasoning deltas are canonical runtime events, but provider-runtime ingestion currently
  materializes only assistant text as conversation messages. Rendering stored reasoning is a shared
  cross-provider change, not a Grok-only adapter rule.
- Prompt `_meta` fields for structured output, cancellation categories, cancel triggers, and tool
  overrides have no corresponding provider completion contract yet. The adapter keeps the raw
  response in its thread snapshot without projecting invented fields.
- Per-model xAI `response_completed` notifications describe model calls inside a tool loop. T3 uses
  the prompt response as the authoritative turn boundary to avoid duplicate turn completion.

[drivers]: ../../apps/server/src/provider/builtInDrivers.ts
[codex]: ../../apps/server/src/provider/Drivers/CodexDriver.ts
[claude]: ../../apps/server/src/provider/Drivers/ClaudeDriver.ts
[cursor]: ../../apps/server/src/provider/Drivers/CursorDriver.ts
[grok]: ../../apps/server/src/provider/Drivers/GrokDriver.ts
[opencode]: ../../apps/server/src/provider/Drivers/OpenCodeDriver.ts
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
