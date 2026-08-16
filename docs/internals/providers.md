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

## Provider skills (`$` picker)

Provider status probes discover skills for every registered project root and active worktree so
project skills are not limited to the server process cwd. Each project skill is tagged with
`sourceCwd` on `ServerProviderSkill` in `packages/contracts`; user/global skills omit it.
Stamps are absolute and passed through `normalizeProviderSkillWorkspacePath` so they match client
path forms (trailing separators, `.` / `..`, mixed slashes).

Grok prefers the harness over a filesystem reimplementation. `grok inspect --json` is the
inventory Grok itself would load (bundled, user, project, plugin) and is the `$` picker
authority when the report includes a `skills` array. ACP `available_commands_update` on
session start is the live `/` menu: built-in features such as `compact` and `deep-research`,
plus user-invocable skills. Filesystem scanning of `.grok/skills`, `.claude/skills`, and
`.agents/skills` fills in when inspect is missing, including project skills from a workspace
whose inspect probe failed.

OpenCode follows the same harness-first rule for the `/` picker. Local installs resolve
commands through `opencode debug config` per workspace cwd — the exact `.opencode/command(s)`,
`~/.config/opencode/command(s)`, and `opencode.json` entries the harness would load — while
configured external servers are queried through the SDK `command.list` per directory, which
also sees MCP- and plugin-contributed commands. A command the harness reports for every
queried workspace is global; one reported for a subset keeps that workspace's `sourceCwd` on
`ServerProviderSlashCommand`. Built-ins (`init`, `review`) are registered in harness code, not
config, so they merge from a constant in `Drivers/OpenCodeCommands.ts`. The `$` picker stays
filesystem-based (`Drivers/OpenCodeSkills.ts`, covering `.opencode/skill(s)` plus compat
roots) because the status probe deliberately avoids spawning a server and skills need their
on-disk paths.

Slash-command _execution_ differs per harness. Claude and Grok parse leading-slash prompt text
themselves, so the composer only inserts `/name `; OpenCode's server never parses prompt text
(the TUI routes commands to a dedicated endpoint), so `OpenCodeAdapter.sendTurn` detects a
leading `/name args`, checks it against the session's cached `command.list`, and invokes
`session.command` in a session-scoped fiber (the endpoint blocks until the command turn
completes; turn progress still streams through the event pump). Unknown names and steers fall
back to plain prompt text.

Clients must not show the raw union in the `$` or `/` pickers. They filter with
`filterProviderSkillsForWorkspace` / `filterProviderSlashCommandsForWorkspace`
(`@t3tools/shared/providerSkills`) using the active chat's
`worktreePath ?? project.workspaceRoot`, and may pass `projectRoot` so worktree chats still see
project-root-tagged entries before a re-probe re-tags under the worktree path. Timeline skill chips
may keep the full inventory so historical mentions still label correctly when the user switches
projects.

**Payload cost (accepted interim):** multi-workspace inventories grow with the number of open
project/worktree bags and ride provider snapshots over the websocket. Prefer a later scoped
`listSkills(cwd)` RPC if multi-project environments show measurable bloat; do not re-flatten by
name across workspaces.

See [project-scoped-skills.html](./project-scoped-skills.html).

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
[adapter]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[instances]: ../../apps/server/src/provider/Services/ProviderInstanceRegistry.ts
[registry]: ../../apps/server/src/provider/Services/ProviderAdapterRegistry.ts
[service]: ../../apps/server/src/provider/Layers/ProviderService.ts
[contracts]: ../../packages/contracts/src/orchestration.ts
[worker]: ../../packages/shared/src/DrainableWorker.ts
[ingest]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[cmd]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[checkpoint]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
