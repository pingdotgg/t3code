# Orchestrator MCP Server

## Purpose

T3 should ship an app-owned MCP server that lets provider agents ask the V2
orchestrator for orchestration work. The first tool family is delegated work:
a parent provider turn can request another provider/model/agent to run a task
as a child execution node, then receive a durable result back.

This is not a subagent-only design. The MCP server is the provider-neutral
bridge for future model-controlled orchestration actions. Subagents are just
the first action because MCP is the most common extension point across the
current provider harnesses.

## External Provider Wiring

### Codex

Codex supports MCP through Codex configuration. Official docs say MCP servers
are stored in `config.toml`, normally `~/.codex/config.toml`, and can also be
project-scoped through `.codex/config.toml` for trusted projects. Stdio servers
use `[mcp_servers.<server-name>]` with `command`, `args`, `env`, `env_vars`,
`cwd`, timeout, enabled, required, and tool allow/deny options.

Local fit:

- Current Codex sessions start `codex app-server` with `CODEX_HOME` supplied
  by `CodexSessionRuntimeOptions.homePath`.
- The generated app-server protocol already includes
  `config/mcpServer/reload`, `mcpServerStatus/list`,
  `mcpServer/resource/read`, `mcpServer/tool/call`, OAuth completion, and MCP
  startup status notifications.
- Current `CodexHomeLayout` can create shadow homes, but it currently symlinks
  `config.toml` from the shared home. V2 should add an app-managed MCP config
  projection instead of mutating arbitrary user TOML blindly.

Recommended projection:

```toml
[mcp_servers.t3_orchestrator]
command = "/path/to/t3"
args = ["mcp", "orchestrator", "--transport", "stdio"]
env = {
  T3_ORCH_MCP_TOKEN = "<short-lived capability token>",
  T3_ORCH_MCP_ENDPOINT = "http://127.0.0.1:<port>",
  T3_ORCH_MCP_CONTEXT = "<signed parent context id>"
}
enabled = true
required = false
tool_timeout_sec = 600
enabled_tools = [
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel"
]
```

Implementation note: prefer a structured TOML merge into an app-managed
session home. If we must touch a user-visible `config.toml`, own only the
`mcp_servers.t3_orchestrator` table, preserve all other tables, and call
`config/mcpServer/reload` after updating a running app-server.

### Claude Agent SDK

Claude Agent SDK exposes MCP directly in `query` options. Official docs show
`mcpServers` entries in the SDK options and require `allowedTools` for Claude
to use those tools without broad permission bypass. Tool names are granted as
`mcp__<serverName>__<toolName>` or with a server wildcard.

Local fit:

- `ClaudeAdapter` already builds a `ClaudeQueryOptions` object in
  `startSession`.
- Add `mcpServers.t3_orchestrator` and `allowedTools:
["mcp__t3_orchestrator__*"]` there.
- This is per Claude query/session startup. There is no hot reload path in our
  current Claude adapter, so changing the MCP projection should restart or
  recreate the Claude query runtime.

Recommended projection:

```ts
const queryOptions: ClaudeQueryOptions = {
  ...existing,
  mcpServers: {
    ...existing.mcpServers,
    t3_orchestrator: {
      command: t3BinaryPath,
      args: ["mcp", "orchestrator", "--transport", "stdio"],
      env: buildOrchestratorMcpEnv(parentContext),
    },
  },
  allowedTools: [...existingAllowedTools, "mcp__t3_orchestrator__*"],
};
```

### OpenCode

OpenCode supports local and remote MCP servers under the `mcp` config object.
Local servers use `type: "local"`, `command: string[]`, optional
`environment`, `enabled`, and timeout. Remote servers use `type: "remote"`,
`url`, headers, OAuth, and timeout. OpenCode tools are managed by glob-like
tool names, and MCP tools are prefixed by server name.

Local fit:

- Our local OpenCode server path spawns `opencode serve` and currently sets
  `OPENCODE_CONFIG_CONTENT` to `JSON.stringify({})`.
- When T3 owns the OpenCode server process, V2 can merge the orchestrator MCP
  config into that generated config content before process start.
- When `serverUrl` points at an external OpenCode server, T3 does not own the
  server config. Treat automatic MCP injection as unsupported unless OpenCode
  exposes a runtime config API we intentionally adopt.

Recommended projection for owned servers:

```ts
const opencodeConfig = {
  ...existingGeneratedConfig,
  mcp: {
    ...existingGeneratedConfig.mcp,
    t3_orchestrator: {
      type: "local",
      command: [t3BinaryPath, "mcp", "orchestrator", "--transport", "stdio"],
      environment: buildOrchestratorMcpEnv(parentContext),
      enabled: true,
      timeout: 600_000,
    },
  },
  tools: {
    ...existingGeneratedConfig.tools,
    "t3_orchestrator_*": true,
  },
};
```

### Cursor SDK

Cursor's TypeScript SDK exposes Cursor agents as durable `Agent` objects and
per-prompt `Run` objects. It also exposes MCP through SDK options instead of
requiring us to mutate Cursor editor configuration. Local agents can receive
inline `mcpServers` at `Agent.create` time and at `agent.send` time. Cloud
agents can also receive inline MCP configuration, but stdio servers run inside
the cloud VM; use a reachable remote MCP transport for cloud agents rather
than a local T3 binary path.

Local fit:

- The V2 Cursor adapter should model a Cursor SDK `Agent` as the provider
  thread and a Cursor SDK `Run` as the provider turn.
- `Agent.resume(agentId, options)` can reattach to durable Cursor state, but
  inline MCP configuration is not persisted across resume. The adapter must
  rebuild and pass the current orchestrator MCP projection on resume and on
  each run that should expose T3 orchestration tools.
- `Run.stream()`, `Run.wait()`, and `Run.cancel()` map cleanly to V2 streaming,
  terminal turn state, and interrupt semantics.
- Cursor SDK stream messages include normalized message types such as
  assistant text, reasoning, tool calls, status, task, and request. Tool
  argument/result payloads should be treated as provider diagnostics until
  replay fixtures prove stable shapes for the V2 normalizer.
- Send-time inline `mcpServers` replaces the create-time inline server set for
  that run. When using send-time injection, always pass the full desired MCP
  server set, not only the delta.

Recommended projection for local SDK agents:

```ts
const agent = await Agent.create({
  local: { cwd },
  model,
  mcpServers: {
    t3_orchestrator: {
      command: t3BinaryPath,
      args: ["mcp", "orchestrator", "--transport", "stdio"],
      env: buildOrchestratorMcpEnv(parentContext),
    },
  },
});

const run = await agent.send(prompt, {
  model,
  mcpServers: {
    t3_orchestrator: {
      command: t3BinaryPath,
      args: ["mcp", "orchestrator", "--transport", "stdio"],
      env: buildOrchestratorMcpEnv(parentContext),
    },
  },
});
```

Recommended V2 posture:

- Prefer the Cursor SDK for the V2 adapter foundation. It gives V2 first-class
  provider-thread resumption, run lifecycle, streaming, cancellation, model
  selection, and MCP injection primitives.
- Do not silently write project/global Cursor config from a provider session.
  Project config mutation is user-visible and should be an explicit user
  setting or setup step.

## V2 Capability Additions

Extend provider capabilities instead of branching on provider kind:

```ts
type ToolCapabilities = {
  exposesToolItemIds: boolean;
  emitsToolStarted: boolean;
  emitsToolCompleted: boolean;
  emitsToolOutput: boolean;
  supportsMcpTools: boolean;
  supportsDynamicToolCallbacks: boolean;
  mcpInjection:
    | { type: "none" }
    | { type: "sdk_options"; reload: "per_run" | "restart_required" }
    | { type: "config_file"; reload: "hot_reload" | "restart_required" }
    | { type: "process_env_config"; reload: "restart_required" }
    | { type: "external_config_only" };
};

type SubagentCapabilities = {
  supportsSubagents: boolean;
  exposesSubagentThreadIds: boolean;
  emitsSubagentLifecycle: boolean;
  canWaitForSubagents: boolean;
  canCloseSubagents: boolean;
  canForkSubagentThread: boolean;
  supportsCrossProviderDelegationViaMcp: boolean;
};
```

Expected initial values:

```text
codex       mcpInjection=config_file/hot_reload, native subagents=yes
claudeAgent mcpInjection=sdk_options/restart_required
openCode    mcpInjection=process_env_config/restart_required for owned servers
cursor      mcpInjection=sdk_options/per_run for SDK, external_config_only for legacy ACP
```

## MCP Server Shape

The server should be named `t3_orchestrator` and should expose a small stable
tool surface. Tool names should stay generic because this server will outgrow
subagents.

Use Effect's MCP server module as the implementation baseline:

```ts
import { NodeRuntime, NodeStdio } from "@effect/platform-node";
import { Context, Effect, Layer, Logger, Schema } from "effect";
import { McpServer, Tool, Toolkit } from "effect/unstable/ai";
```

The relevant primitives are:

- `Tool.make` for typed MCP tool definitions.
- `Toolkit.make` and `Toolkit.toLayer` for tool handler registration.
- `McpServer.toolkit` for registering the toolkit with the MCP registry.
- `McpServer.layerStdio` for the provider-spawned stdio server.
- `McpServer.layerHttp` if we later need HTTP transport for internal tests or
  non-stdio clients.

### Tools

`orchestrator_capabilities`

Returns the providers, provider instances, models, runtime modes, and
delegation features currently available to the parent context.

```ts
type OrchestratorCapabilitiesResult = {
  providers: Array<{
    providerInstanceId: string;
    driverKind: string;
    displayName?: string;
    models: Array<{ id: string; label?: string }>;
    canRunChildTask: boolean;
    canRunSameProviderNativeSubagent: boolean;
    canRunCrossProviderChildTask: boolean;
    constraints: string[];
  }>;
};
```

`delegate_task`

Requests a child execution task. The orchestrator decides whether this becomes
a same-provider native subagent, a child app thread/run on another provider, or
a rejected request with a model-visible error.

```ts
type DelegateTaskInput = {
  task: string;
  target?: {
    providerInstanceId?: string;
    driverKind?: string;
    model?: string;
  };
  role?: "implementation" | "research" | "review" | "design" | "test" | "general";
  mode?: "async" | "wait";
  timeoutMs?: number;
  clientRequestId?: string;
  context?: {
    summary?: string;
    files?: string[];
    sourcePoint?: {
      threadId?: string;
      runId?: string;
      nodeId?: string;
      checkpointId?: string;
    };
  };
  runtimeMode?: "inherit" | "read_only" | "workspace_write" | "full_access";
};

type DelegateTaskResult = {
  taskId: string;
  childThreadId?: string;
  childRunId?: string;
  childNodeId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "rejected";
  providerInstanceId: string;
  model?: string;
  summary?: string;
  failure?: {
    code: string;
    message: string;
  };
  resultContextTransferId?: string;
};
```

`task_status`

Returns the latest durable state for a delegated task, including final summary,
artifact refs, child thread/run/node ids, failure reason, and whether the
parent can wait longer.

`task_cancel`

Cancels a delegated task through the V2 command layer. This should target app
ids and let the adapter translate to native interruption.

Future tools can use the same server:

- `context_read` for bounded, orchestrator-curated context resources.
- `handoff_request` for agent-initiated provider switching.
- `checkpoint_create` for explicit child scopes.
- `plan_review_request` for app-owned plan review flows.

### MCP Tool Result Rules

MCP clients call tools with `tools/call` and arguments. Effect's
`McpServer.toolkit` registers Effect `Tool` definitions as MCP tools, emits
JSON schemas from Effect Schema, and returns both model-visible text content
and `structuredContent` from encoded tool results. Handler failures are mapped
to MCP tool errors, while protocol failures stay JSON-RPC errors.

For expected orchestration denials, prefer typed tool failures or explicit
rejected statuses over defects. That keeps "provider unavailable", "permission
denied", and "runtime mode escalation denied" as model-actionable outcomes
instead of transport-level failures.

For long-running work, prefer:

```text
delegate_task(mode="async")
  -> returns taskId immediately
task_status(taskId)
  -> model polls when it needs result
```

`delegate_task(mode="wait")` may block until completion or timeout, but it
still creates the same durable child node and returns the same ids.

## Orchestrator Integration

The MCP server must not call provider adapters directly. It should be another
command ingress into V2 orchestration.

```text
provider model
  -> MCP tools/call delegate_task
  -> T3 MCP server validates token and input
  -> V2 command: delegated_task.request
  -> durable event: DelegatedTaskRequested
  -> execution graph: child ExecutionNode(parentNodeId=caller node)
  -> ContextTransfer(type=subagent_spawn, createdBy=agent)
  -> provider effect request starts/resumes selected child provider
  -> child provider events normalize into graph
  -> ContextTransfer(type=subagent_result) materializes result
  -> MCP result / task_status returns durable child state
```

Important boundaries:

- Authentication is through a short-lived capability token scoped to the
  parent session/thread/run/node and delivered through MCP server env.
- Authorization is app-owned. The tool input can ask for a provider, model,
  files, and runtime mode; policy decides what is allowed.
- Runtime mode can only stay the same or narrow without explicit user
  approval. A parent in read-only mode cannot create a full-access child.
- Child tasks use app ids. Native provider ids are refs and are scoped through
  normal V2 identity bindings.
- `clientRequestId` makes MCP retries idempotent within the parent MCP session.
- The parent tool call item should be linked to the child `ExecutionNode` so
  the UI can show progress under the parent turn.
- The child result should flow back through `ContextTransfer`, not hidden prompt
  concatenation.

## Pseudo-Code

Typed tool declarations:

Assume the `*Schema` constants mirror the TypeScript shapes above.

```ts
const DelegationFailure = Schema.Struct({
  code: Schema.Literals([
    "provider_unavailable",
    "model_unavailable",
    "permission_denied",
    "runtime_mode_escalation_denied",
    "timeout",
    "internal_error",
  ]),
  message: Schema.String,
});

const OrchestratorCapabilities = Tool.make("orchestrator_capabilities", {
  description: "List providers and models available for delegated work.",
  success: OrchestratorCapabilitiesResultSchema,
}).annotate(Tool.Readonly, true);

const DelegateTask = Tool.make("delegate_task", {
  description: "Request a child orchestration task from T3.",
  parameters: DelegateTaskInputSchema,
  success: DelegateTaskResultSchema,
  failure: DelegationFailure,
  failureMode: "return",
}).annotate(Tool.Idempotent, true);

const TaskStatus = Tool.make("task_status", {
  description: "Read the latest durable state for a delegated task.",
  parameters: Schema.Struct({
    taskId: Schema.String,
  }),
  success: DelegateTaskResultSchema,
}).annotate(Tool.Readonly, true);

const TaskCancel = Tool.make("task_cancel", {
  description: "Cancel a delegated task.",
  parameters: Schema.Struct({
    taskId: Schema.String,
    reason: Schema.optionalKey(Schema.String),
  }),
  success: Schema.Struct({
    taskId: Schema.String,
    status: Schema.Literal("cancel_requested"),
  }),
  failure: DelegationFailure,
  failureMode: "return",
}).annotate(Tool.Idempotent, true);

const OrchestratorToolkit = Toolkit.make(
  OrchestratorCapabilities,
  DelegateTask,
  TaskStatus,
  TaskCancel,
);
```

Provider projection contract:

```ts
type OrchestratorMcpProjection = {
  serverName: "t3_orchestrator";
  command: string;
  args: string[];
  env: Record<string, string>;
  allowedToolNames: string[];
};

type ProviderMcpProjector = {
  support: ToolCapabilities["mcpInjection"];
  buildProjection(input: {
    parentThreadId: string;
    parentRunId?: string;
    parentNodeId?: string;
    providerInstanceId: string;
    cwd: string;
  }): OrchestratorMcpProjection;
};
```

MCP server entrypoint using Effect layers:

```ts
class OrchestratorMcpAuth extends Context.Service<OrchestratorMcpAuth, OrchestratorMcpAuthShape>()(
  "t3/orchestrator-mcp/Auth",
) {}

const OrchestratorMcpHandlers = OrchestratorToolkit.toLayer({
  orchestrator_capabilities: () =>
    Effect.gen(function* () {
      const auth = yield* OrchestratorMcpAuth;
      const orchestration = yield* OrchestrationV2;
      return yield* orchestration.readDelegationCapabilities(auth.scope);
    }),

  delegate_task: (input) =>
    Effect.gen(function* () {
      const auth = yield* OrchestratorMcpAuth;
      const orchestration = yield* OrchestrationV2;
      const commandId = stableCommandId(auth.mcpSessionId, input.clientRequestId);
      const receipt = yield* orchestration.dispatch({
        type: "delegated_task.request",
        commandId,
        causation: {
          source: "mcp",
          providerInstanceId: auth.providerInstanceId,
          parentThreadId: auth.parentThreadId,
          parentRunId: auth.parentRunId,
          parentNodeId: auth.parentNodeId,
        },
        input,
      });

      if (input.mode !== "wait") {
        return toDelegateTaskResult(receipt);
      }

      const finalState = yield* orchestration.waitForDelegatedTask(
        receipt.taskId,
        input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
      );
      return toDelegateTaskResult(finalState);
    }),

  task_status: ({ taskId }) =>
    Effect.gen(function* () {
      const auth = yield* OrchestratorMcpAuth;
      const orchestration = yield* OrchestrationV2;
      return yield* orchestration.readDelegatedTask(auth.scope, taskId);
    }),

  task_cancel: ({ taskId, reason }) =>
    Effect.gen(function* () {
      const auth = yield* OrchestratorMcpAuth;
      const orchestration = yield* OrchestrationV2;
      return yield* orchestration.cancelDelegatedTask(auth.scope, {
        taskId,
        reason,
      });
    }),
});

const ServerLayer = McpServer.toolkit(OrchestratorToolkit).pipe(
  Layer.provide(OrchestratorMcpHandlers),
  Layer.provide(OrchestrationMcpServicesLive),
  Layer.provide(
    McpServer.layerStdio({
      name: "t3_orchestrator",
      version: APP_VERSION,
    }),
  ),
  Layer.provide(NodeStdio.layer),
  Layer.provide(Layer.succeed(Logger.LogToStderr)(true)),
);

Layer.launch(ServerLayer).pipe(NodeRuntime.runMain);
```

The handler layer should translate expected orchestration denials into typed
tool failures or explicit rejected statuses. Defects, malformed inputs, and
protocol problems can remain Effect failures so `McpServer.toolkit` maps them
to MCP tool errors.

Provider hooks:

```ts
function applyCodexProjection(home: CodexHome, projection: OrchestratorMcpProjection) {
  mergeTomlTable(home.configToml, "mcp_servers.t3_orchestrator", {
    command: projection.command,
    args: projection.args,
    env: projection.env,
    enabled_tools: projection.allowedToolNames,
    enabled: true,
    required: false,
  });
  codexRpc.request("config/mcpServer/reload");
}

function applyClaudeProjection(options: ClaudeQueryOptions, projection: OrchestratorMcpProjection) {
  options.mcpServers = {
    ...options.mcpServers,
    [projection.serverName]: {
      command: projection.command,
      args: projection.args,
      env: projection.env,
    },
  };
  options.allowedTools = [...(options.allowedTools ?? []), `mcp__${projection.serverName}__*`];
}

function buildOpenCodeConfig(projection: OrchestratorMcpProjection) {
  return {
    mcp: {
      [projection.serverName]: {
        type: "local",
        command: [projection.command, ...projection.args],
        environment: projection.env,
        enabled: true,
      },
    },
    tools: {
      [`${projection.serverName}_*`]: true,
    },
  };
}

function applyCursorSdkProjection<T extends { mcpServers?: Record<string, unknown> }>(
  options: T,
  projection: OrchestratorMcpProjection,
): T {
  return {
    ...options,
    mcpServers: {
      ...(options.mcpServers ?? {}),
      [projection.serverName]: {
        command: projection.command,
        args: projection.args,
        env: projection.env,
      },
    },
  };
}
```

## Testing Plan

- Unit test provider projection builders for Codex TOML, Claude query options,
  OpenCode JSON config, and Cursor SDK create/send options.
- Cursor SDK replay tests should assert that the adapter re-supplies the
  orchestrator MCP projection after `Agent.resume` and on each `agent.send`
  that exposes orchestration tools.
- Unit test MCP schemas and error mapping: expected denials return typed tool
  outcomes, handler failures become MCP tool errors, and protocol errors stay
  JSON-RPC errors.
- Replay-backed integration test: a synthetic parent MCP `delegate_task` call
  creates `DelegatedTaskRequested`, a child execution node, a child provider
  effect, child runtime events, and a result context transfer.
- Failure tests: provider unavailable, missing model, runtime mode escalation,
  duplicate `clientRequestId`, child timeout, child cancellation, and parent
  session restart.
- Provider-specific tests should mock only external harness/process layers,
  not orchestration business logic.

## Sources Checked

- OpenAI Codex MCP configuration:
  https://developers.openai.com/codex/mcp
- OpenAI Codex app-server lifecycle and MCP app-server methods observed in
  generated local protocol:
  https://developers.openai.com/codex/app-server
- Claude Agent SDK MCP options and `allowedTools`:
  https://code.claude.com/docs/en/agent-sdk/mcp
- OpenCode MCP configuration:
  https://opencode.ai/docs/mcp-servers
- Cursor TypeScript SDK agents, runs, resume, MCP, and cloud behavior:
  https://cursor.com/docs/sdk/typescript
- Cursor CLI MCP behavior for legacy ACP fallback and external configuration:
  https://cursor.com/docs/cli/mcp
- Cursor CLI ACP behavior for legacy adapter context:
  https://cursor.com/docs/cli/acp
- Effect MCP server module:
  https://github.com/Effect-TS/effect-smol/blob/main/packages/effect/src/unstable/ai/McpServer.ts
- MCP tool call and result schema:
  https://modelcontextprotocol.io/specification/2025-06-18/schema
