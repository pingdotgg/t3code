# MCP System

Status: draft product and architecture spec

## Summary

Add a server-owned MCP system to T3 Code.

Users can configure MCP servers globally from Settings, enable or override them per project, and
install app-shipped presets for common integrations. Providers receive an effective MCP projection
for the current project and provider instance. T3 Code also ships a first-party app-control MCP
server that lets an agent interact with T3 Code itself, starting with user-visible terminal
sessions.

The important boundary: T3 owns MCP intent and policy. Provider adapters only receive the effective
runtime projection they can support.

## Goals

- Configure MCP servers globally in Settings.
- Enable, disable, and override MCP servers per project.
- Ship preset integrations without hardcoding the storage model to those presets.
- Support custom MCP servers through the same model as presets.
- Keep secrets server-side and redact them everywhere else.
- Make effective MCP state inspectable and debuggable.
- Project MCP configuration into Codex, Claude, OpenCode, and future providers without binding the
  core model to any one provider.
- Provide a first-party T3 app-control MCP server for controlled interaction with the app.
- Let agents open user-visible terminals, run commands, stream output, detect local web servers, and
  let the user observe or interrupt those sessions.

## Non-Goals

- Browser-only MCP configuration state.
- Hidden command execution outside the existing terminal/runtime surfaces.
- Making all MCP servers trusted by default.
- Implementing a full standalone MCP marketplace in the first iteration.
- Supporting legacy HTTP+SSE as a first-class transport. It may be imported for compatibility later,
  but the initial model should target stdio and Streamable HTTP.
- Replacing provider-native MCP clients where they already exist and are reliable.

## References

- MCP transports: https://modelcontextprotocol.io/docs/concepts/transports
- MCP architecture: https://modelcontextprotocol.io/docs/learn/architecture
- Codex app-server MCP/config methods exist in `packages/effect-codex-app-server`.
- Current terminal contracts live in `packages/contracts/src/terminal.ts`.
- Current terminal server lifecycle lives in `apps/server/src/terminal/Services/Manager.ts`.

## Core Concepts

### MCP Server Definition

A reusable global server configuration.

```ts
type McpServerDefinition = {
  id: McpServerId;
  displayName: string;
  description?: string;
  enabled: boolean;
  source: "custom" | "preset" | "imported";
  presetId?: string;
  transport: McpTransportConfig;
  env?: Record<string, McpConfigValue>;
  headers?: Record<string, McpConfigValue>;
  capabilities?: McpDeclaredCapabilities;
  trust: McpTrustPolicy;
  createdAt: string;
  updatedAt: string;
};
```

### Transport Config

MCP uses JSON-RPC and currently standardizes stdio and Streamable HTTP. Model the transport as a
discriminated union so new transports can be added without rewriting the storage format.

```ts
type McpTransportConfig =
  | {
      type: "stdio";
      command: string;
      args: string[];
      cwd?: McpCwdConfig;
    }
  | {
      type: "streamableHttp";
      url: string;
      auth?: McpHttpAuthConfig;
    };
```

`stdio` is the default for local developer tools. `streamableHttp` is the default for hosted SaaS
integrations and OAuth-backed services.

### Config Values And Secrets

Never store or send raw sensitive values as ordinary strings after save.

```ts
type McpConfigValue =
  | { kind: "literal"; value: string }
  | { kind: "secretRef"; secretId: string; label?: string };
```

The web app receives redacted placeholders. The server materializes secret values only while
building provider runtime config or starting an MCP client.

### Preset

An app-shipped template that materializes into a normal `McpServerDefinition`.

```ts
type McpPreset = {
  id: string;
  displayName: string;
  description: string;
  category: "source-control" | "observability" | "browser" | "database" | "local" | "app";
  transportTemplate: McpTransportConfig;
  requiredInputs: McpPresetInput[];
  declaredCapabilities: McpDeclaredCapabilities;
  defaultTrust: McpTrustPolicy;
  recommendedProjectDefault: boolean;
};
```

Presets are not special at runtime. They only improve setup UX.

### Project Binding

Project-specific enablement and overrides.

```ts
type ProjectMcpBinding = {
  projectId: ProjectId;
  serverId: McpServerId;
  enabled: boolean;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  resourceAllowlist?: string[];
  promptAllowlist?: string[];
  envOverrides?: Record<string, McpConfigValue>;
  cwd?: McpCwdConfig;
  trustOverride?: Partial<McpTrustPolicy>;
  updatedAt: string;
};
```

Global definitions answer "what exists". Project bindings answer "what this project may use".

### Trust Policy

MCP tools can read local context, call external systems, mutate data, and exfiltrate information.
Policy must be explicit.

```ts
type McpTrustPolicy = {
  localFileAccess: "none" | "project" | "workspace" | "unrestricted";
  networkAccess: "none" | "localhost" | "external";
  mutation: "none" | "project" | "external";
  requiresUserApproval: boolean;
  allowDuringPlanMode: boolean;
};
```

This policy is T3's policy layer. Provider-native permission systems may add stricter behavior, but
they must not silently widen this policy.

## Effective Config

Effective MCP config is computed at runtime from ordered layers:

1. Built-in preset defaults.
2. Global `McpServerDefinition`.
3. Provider instance compatibility overrides.
4. Project `ProjectMcpBinding`.
5. Optional thread/turn temporary overrides, if added later.

The server should expose:

```ts
mcp.listServers()
mcp.getServer({ serverId })
mcp.updateServers({ servers })
mcp.listPresets()
mcp.installPreset({ presetId, input })
mcp.listProjectBindings({ projectId })
mcp.updateProjectBindings({ projectId, bindings })
mcp.getEffectiveConfig({ projectId, providerInstanceId })
mcp.refreshStatus({ projectId?, providerInstanceId? })
```

Effective config must include both raw provider-applicable config server-side and a redacted
debuggable view for the web app.

## Persistence

### Global Settings

Add MCP server definitions to server-authoritative settings.

```ts
type ServerSettings = {
  // existing fields...
  mcpServers: Record<McpServerId, McpServerDefinition>;
};
```

This belongs in `packages/contracts/src/settings.ts` and is owned by `ServerSettingsService`.

### Project State

Per-project bindings should be project metadata, not global settings.

Add orchestration commands/events:

```ts
type ProjectMcpUpdateCommand = {
  type: "project.mcp.update";
  commandId: CommandId;
  projectId: ProjectId;
  bindings: ProjectMcpBinding[];
};

type ProjectMcpUpdatedEvent = {
  type: "project.mcp-updated";
  payload: {
    projectId: ProjectId;
    bindings: ProjectMcpBinding[];
  };
};
```

Projection storage should keep project MCP bindings queryable by `projectId`. This keeps project MCP
state in the same event/projection lifecycle as title, workspace root, scripts, threads, and future
project metadata.

## Runtime Architecture

```text
apps/web
  Settings UI / Project UI
        |
        v
packages/contracts
  MCP schemas, RPC contracts, domain events
        |
        v
apps/server
  McpRegistryService
  - persists global definitions
  - reads project bindings
  - redacts secrets
  - computes effective config
  - tracks status and discovery
  - projects config to providers
        |
        v
Provider adapters
  Codex / Claude / OpenCode / future providers
```

### McpRegistryService

Server service responsibilities:

- Validate global definitions.
- Validate project bindings against known server IDs.
- Materialize secret refs only inside server-side runtime code.
- Compute effective config for a project/provider.
- Discover server status where supported.
- Cache status with explicit refresh and invalidation.
- Emit settings/domain events that let the web app update without polling.
- Provide provider-specific config materializers.

### Provider Adapters

Provider adapters should not own the generic MCP storage model.

- Codex: use Codex app-server config/MCP methods where practical, including status list, reload,
  OAuth login, resource read, and tool call surfaces. Avoid implementing a parallel Codex MCP client
  unless native support is insufficient.
- Claude: materialize to Claude-compatible MCP config.
- OpenCode: materialize to OpenCode-compatible MCP config.
- Unsupported provider: surface a clear "configured but unsupported by this provider" status.

Hot reload should be best-effort. If a provider cannot reload MCP config safely, mark sessions as
requiring restart and show that state in the UI.

## First-Party T3 App-Control MCP Server

T3 Code should ship a local MCP server named `t3-app`.

This is not a user-installed external MCP process. It is a first-party server surface provided by
`apps/server`, exposed to provider sessions as an internal MCP server. It gives agents controlled
access to T3 app capabilities that are already user-visible and server-authoritative.

Initial capabilities:

- user-visible terminal sessions
- terminal output reading
- terminal command input
- terminal close/interrupt/restart
- terminal web-server detection
- selected app navigation/focus actions later

Do not expose arbitrary server internals through this MCP server. Each tool should map to a narrow
server capability with existing permissions, audit logs, and UI state.

### Terminal Principle

Agent-triggered commands must be visible to the user.

The app-control MCP server must use the existing `TerminalManager` rather than spawning hidden child
processes. A terminal opened by the agent appears in the app's terminal UI, has normal terminal
metadata, streams output through existing terminal subscriptions, and can be closed or interrupted
by the user.

### Terminal Identity

Agent-created terminals should use deterministic, recognizable IDs.

```ts
type AppControlTerminalRef = {
  threadId: ThreadId;
  terminalId: string; // example: "agent-1", "agent-dev-server"
};
```

Recommended terminal labels:

- `Agent Terminal`
- `Agent: npm run dev`
- `Agent: tests`

The label is display metadata only. The terminal remains an ordinary T3 terminal session.

### App-Control MCP Tools

#### `t3_terminal_open`

Open or attach to a user-visible terminal for the current thread/project.

```ts
type T3TerminalOpenInput = {
  terminalId?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  purpose?: string;
};

type T3TerminalOpenResult = {
  threadId: string;
  terminalId: string;
  status: "starting" | "running" | "exited" | "error";
  label: string;
};
```

If `cwd` is omitted, use the active project workspace root or thread worktree path according to the
same rules as the existing terminal UI.

#### `t3_terminal_run`

Open or reuse a terminal and write a command followed by a newline.

```ts
type T3TerminalRunInput = {
  terminalId?: string;
  command: string;
  cwd?: string;
  purpose?: string;
  waitForExit?: boolean;
  timeoutMs?: number;
};

type T3TerminalRunResult = {
  threadId: string;
  terminalId: string;
  accepted: boolean;
  outputPreview?: string;
  exitCode?: number | null;
  timedOut?: boolean;
};
```

This is intentionally a terminal input tool, not a hidden exec tool. The user sees the command in the
terminal, sees live output, and can interrupt it.

#### `t3_terminal_write`

Write bytes to an existing terminal.

```ts
type T3TerminalWriteInput = {
  terminalId: string;
  data: string;
};
```

Useful for interactive prompts, cancellation keys, or continuing a shell session.

#### `t3_terminal_snapshot`

Read the current terminal buffer and metadata.

```ts
type T3TerminalSnapshotInput = {
  terminalId: string;
  maxBytes?: number;
};

type T3TerminalSnapshotResult = {
  threadId: string;
  terminalId: string;
  status: string;
  label: string;
  buffer: string;
  hasRunningSubprocess: boolean;
};
```

The server should cap output to prevent large MCP payloads. Full output remains in normal terminal
history.

#### `t3_terminal_interrupt`

Send an interrupt to the running terminal process.

Initial implementation can write `\u0003` to the PTY. A later implementation can add platform-aware
process-tree termination if needed.

#### `t3_terminal_close`

Close an agent-created terminal.

By default, this should not delete history. Deleting history should require an explicit input flag
and should not be the default agent behavior.

#### `t3_terminal_detect_web_servers`

Call the existing terminal web-server detection for a terminal.

```ts
type T3TerminalDetectWebServersResult = {
  servers: Array<{
    url: string;
    host: string;
    port: number;
    pid: number;
    verified: boolean;
  }>;
};
```

This gives the agent a clean path from "run dev server" to "tell the user which URL to open" and can
later compose with browser-agent preview flows.

### App-Control MCP Resources

Expose read-only resources only where they are useful and safe:

- `t3://project/current` - current project metadata.
- `t3://thread/current` - current thread metadata.
- `t3://terminal/{terminalId}/summary` - terminal status and label.

Avoid exposing complete app state as one resource. Prefer narrow resources with stable schemas.

### App-Control Permissions

App-control MCP is powerful and should have its own policy.

```ts
type T3AppControlPolicy = {
  enabled: boolean;
  terminals: {
    enabled: boolean;
    requireApprovalForFirstRun: boolean;
    allowedCwd: "project" | "worktree";
    maxAgentTerminalsPerThread: number;
    maxCommandLength: number;
  };
};
```

Recommended defaults:

- enabled for Codex-capable local provider sessions
- terminal tools enabled
- first command visible in approval/event flow where provider supports approval
- cwd limited to project/worktree
- no hidden environment secret injection
- max command length aligned with existing `TerminalWriteInput` limits

### App-Control Auditing

Every app-control tool call should emit provider runtime events and server trace spans:

- tool name
- provider instance
- project ID
- thread ID
- terminal ID
- command preview for `t3_terminal_run`
- result status
- elapsed time

The command preview should be capped and should redact obvious secret refs when possible, but the
terminal itself remains user-visible.

## UI

### Settings: Connections / MCP Servers

The global UI should manage server definitions:

- list configured MCP servers
- show enabled/disabled state
- show transport type
- show current status
- install preset
- add custom stdio server
- add custom Streamable HTTP server
- edit env/header values with sensitive-field support
- inspect discovered tools/resources/prompts
- refresh status
- delete server

This can live under the existing Connections settings area, but the UI should visually separate
MCP servers from remote app connections.

### Project MCP Panel

Project-level UI should manage bindings:

- enable/disable global servers for this project
- show effective status for active provider
- configure project env/cwd overrides
- allow/deny individual tools
- show provider support state
- show "requires session restart" when hot reload is unavailable

### Terminal UX For Agent-Created Terminals

Agent-created terminals should look like normal terminals with extra metadata:

- clear label that an agent opened it
- command label when a foreground subprocess is detected
- visible output
- close and interrupt controls
- web-server detection affordance

The user should never have to inspect hidden logs to know that an agent is running a command.

## Error Model

Errors should be first-class and structured:

- invalid transport config
- command not found
- stdio server exited
- HTTP endpoint unreachable
- auth/OAuth required
- secret missing
- project binding references unknown server
- provider does not support MCP
- provider requires restart
- tool denied by project policy
- app-control terminal limit reached
- app-control cwd outside allowed project/worktree
- terminal not running

Do not collapse these into generic toast strings. The server should return typed errors; the web UI
can render concise messages.

## Security Notes

- Redact secrets in settings responses and status snapshots.
- Keep Streamable HTTP auth server-side.
- Default local HTTP MCP endpoints to loopback recommendations.
- Require explicit enablement for external mutation tools.
- Let users inspect discovered tools before enabling a server per project.
- Treat tool names as untrusted display strings; identify tools by server ID plus tool name.
- Do not allow an MCP server to silently replace the built-in `t3-app` server ID.
- Do not pass app-control MCP to remote/untrusted provider sessions unless the user explicitly
  enables it for that provider/environment.

## Implementation Plan

### Phase 1: Contracts And Storage

- Add MCP IDs, transport schemas, server definitions, project bindings, status schemas, and errors
  to `packages/contracts`.
- Add `mcpServers` to `ServerSettings` and `ServerSettingsPatch`.
- Add `project.mcp.update` / `project.mcp-updated` commands and events.
- Add projection storage/query support for project MCP bindings.
- Add shared redaction and effective-config helpers to `packages/shared`.

### Phase 2: Registry And RPC

- Add `McpRegistryService` in `apps/server`.
- Add WS RPC methods for global servers, presets, project bindings, effective config, and status.
- Add server-side validation, secret materialization, and redacted responses.
- Add tests for merge precedence, redaction, unknown server references, and status errors.

### Phase 3: Codex Projection

- Materialize effective MCP config for Codex sessions.
- Use Codex app-server MCP/config methods for reload/status/OAuth where available.
- Show provider support and restart-required state in the UI.
- Keep provider event ingestion for MCP status, OAuth completion, and MCP tool call progress wired
  into existing runtime events.

### Phase 4: Settings UI

- Build global MCP server list and editor in Connections settings.
- Build custom stdio and Streamable HTTP forms.
- Build preset install flow.
- Show discovered tools/resources/prompts and status.
- Keep forms dense and operational; this is a settings surface, not a landing page.

### Phase 5: Project Bindings UI

- Add project MCP binding panel.
- Support enable/disable, tool allow/deny, env/cwd overrides, and effective status.
- Make project config changes flow through orchestration events.

### Phase 6: T3 App-Control MCP Server

- Add internal `t3-app` MCP server implementation in `apps/server`.
- Implement terminal tools using `TerminalManager`.
- Add app-control policy to settings.
- Add audit events and trace spans.
- Surface agent-created terminals in existing terminal UI.
- Add focused tests around terminal open/run/write/snapshot/close behavior and policy denial.

### Phase 7: More Providers And Presets

- Add Claude/OpenCode materializers.
- Add first preset catalog: GitHub, Sentry, Linear, filesystem, Playwright/browser, and `t3-app`.
- Add importers from common MCP config files when safe.

## Open Questions

- Should `t3-app` be always available to local Codex sessions, or should it be a visible installed
  preset that can be disabled like any other MCP server?
- Should project bindings live in the existing project metadata projection table or a dedicated
  projection table keyed by project/server?
- How much app navigation should `t3-app` expose beyond terminals in v1?
- Should terminal command approval be enforced by T3 policy even when the provider considers the MCP
  tool call approved?
- What is the correct compatibility layer for providers that support MCP config files but not
  runtime reload?
