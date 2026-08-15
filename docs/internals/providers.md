# Provider architecture

> For maintainers. Using T3 Code? See [docs/user](../user/).

A provider is the agent runtime that does the actual work. T3 Code supports several, and the
orchestration layer does not know which one is behind a thread.

## Built-in drivers

[`builtInDrivers.ts`][drivers] exports `BUILT_IN_DRIVERS` with six entries:

| Driver kind   | Driver source                                  |
| ------------- | ---------------------------------------------- |
| `codex`       | [`Drivers/CodexDriver.ts`][codex]              |
| `claudeAgent` | [`Drivers/ClaudeDriver.ts`][claude]            |
| `cursor`      | [`Drivers/CursorDriver.ts`][cursor]            |
| `grok`        | [`Drivers/GrokDriver.ts`][grok]                |
| `opencode`    | [`Drivers/OpenCodeDriver.ts`][opencode]        |
| `acpRegistry` | [`Drivers/AcpRegistryDriver.ts`][acp-registry] |

Each driver declares its `driverKind`, a `configSchema`, and a `create` function that builds an
adapter in a child scope. The active adapters live in `apps/server/src/orchestration-v2/Adapters/`
and conform to the V2 provider adapter contract. Read the driver plus its adapter to see how a
specific agent's transport, config, and event shapes are mapped.

### ACP Registry catalog

`acpRegistry` is one generic driver for agents published in the official ACP Registry. A shared,
server-scoped catalog owns registry fetch and validation, platform/distribution selection, status
inspection, and preparation. The settings search and runtime resolver use that same service so a
remote client cannot accidentally inspect or install for its own platform instead of the connected
environment.

Search is read-only. Preparation is an explicit user-authorized operation: compatible binaries are
downloaded into a versioned cache and checked against the registry's SHA-256 when one is declared;
version-pinned `npx` and `uvx` recipes validate their local runner without starting the agent. The
normal V2 ACP adapter starts the selected agent only when provider work begins and negotiates its
capabilities during `initialize`.

Catalog inspection never launches a third-party ACP process. It reports registry, platform, runner,
and managed-cache readiness. The driver's managed provider snapshot then uses a disposable
`session/new` for the same startup, background, and manual refresh lifecycle as other providers. A
successful session is the authentication-readiness proof and projects advertised model choices into
the snapshot without persisting discovered IDs into settings. The disposable probe captures a
bounded initial `available_commands_update`. Normal ACP sessions continue publishing later command
updates through a server-lifetime coordinator, so asynchronous advertisements are not limited by the
probe window. Regular command names populate `slashCommands`; names beginning with `$` populate
`skills` and therefore T3 Code's `$` composer menu. ACP has no separate generic installed-skills
inventory, so this exposes only skills the agent advertises as user-invocable commands. The same
coordinator interrupts or suppresses a disposable probe when foreground startup begins for that
registry agent. Authentication credentials remain owned by the agent and user.

Deleting the final configured instance for an agent removes only T3-owned binary files. Package
runner caches remain owned by `npx` and `uvx`. Registry icons are restricted to the official HTTPS
CDN and cached by the client after their first bounded fetch.

### ACP runtime boundary

`packages/effect-acp` carries the original JSON-RPC request ID and method beside every decoded core
or extension request. The generic V2 ACP adapter uses that identity for response admission and
acknowledgement. It never attempts to rediscover an ID by comparing decoded payloads with raw wire
payloads; schema defaults and provider extension fields make payload correlation inherently lossy.

All registry agents share the same client capabilities, stdio MCP bridge, session configuration,
T3 interaction instructions, permission policy, and response lifecycle. Agents that accept but
drop ACP's injected MCP servers can reach the same authenticated, thread-scoped tools through the
hidden `acp-mcp-call` terminal fallback. Provider-specific ACP code is limited to actual extensions
such as Grok's xAI background-task and user-input methods. Standard permission requests and
explicitly tagged MCP approval elicitations both resolve through the thread's runtime and sandbox
policy. Runtime generation checks quarantine late requests and responses after Stop or restart
without allowing them to mutate the replacement turn.

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
[acp-registry]: ../../apps/server/src/provider/Drivers/AcpRegistryDriver.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
