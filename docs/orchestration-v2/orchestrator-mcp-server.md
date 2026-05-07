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

### Cursor ACP

Cursor CLI supports MCP, but the current T3 harness uses Cursor through ACP.
The local ACP session creation sends `mcpServers: []`, and there is no current
adapter hook that projects a T3 MCP server into Cursor through ACP. Cursor CLI
docs indicate the agent discovers MCP from the same editor `mcp.json`
configuration and has `cursor-agent mcp` commands for listing servers,
listing tools, login, and disabling.

Recommended V2 posture:

- Mark Cursor's app-injected MCP support as `external_config_only` until ACP
  exposes a reliable config input or we decide to manage `.cursor/mcp.json`.
- Do not silently write project/global Cursor config from a provider session.
  Project config mutation is user-visible and should be an explicit user
  setting or setup step.
- Preserve the ACP `mcpServers` field in our capability model as provider
  evidence, but do not treat the current empty array as an injection path.

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
    | { type: "sdk_options"; reload: "restart_required" }
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
cursor      mcpInjection=external_config_only
```

## MCP Server Shape

The server should be named `t3_orchestrator` and should expose a small stable
tool surface. Tool names should stay generic because this server will outgrow
subagents.

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
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  providerInstanceId: string;
  model?: string;
  summary?: string;
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

MCP clients call tools with `tools/call` and arguments. Results should include
both `content` and `structuredContent` so weaker clients still see text while
T3-aware clients can validate typed output. Tool execution errors that the
model can act on should return `isError: true` in the result rather than a
protocol-level JSON-RPC error. Unknown tools, malformed requests, and protocol
failures should remain JSON-RPC errors.

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

MCP server entrypoint:

```ts
async function startOrchestratorMcpServer(env: NodeJS.ProcessEnv) {
  const auth = await verifyCapabilityToken(env.T3_ORCH_MCP_TOKEN);
  const transport = new StdioServerTransport();
  const server = new McpServer({
    name: "t3_orchestrator",
    version: APP_VERSION,
  });

  server.tool("orchestrator_capabilities", capabilitiesSchema, async () => {
    const result = await orchestration.readDelegationCapabilities(auth.scope);
    return toolResult(result);
  });

  server.tool("delegate_task", delegateTaskSchema, async (input) => {
    const commandId = stableCommandId(auth.mcpSessionId, input.clientRequestId);
    const receipt = await orchestration.dispatch({
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
      return toolResult(toDelegateTaskResult(receipt));
    }

    const finalState = await orchestration.waitForDelegatedTask(
      receipt.taskId,
      input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    );
    return toolResult(toDelegateTaskResult(finalState));
  });

  server.tool("task_status", taskStatusSchema, async (input) => {
    return toolResult(await orchestration.readDelegatedTask(auth.scope, input.taskId));
  });

  server.tool("task_cancel", taskCancelSchema, async (input) => {
    return toolResult(await orchestration.cancelDelegatedTask(auth.scope, input.taskId));
  });

  await server.connect(transport);
}
```

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
```

## Testing Plan

- Unit test provider projection builders for Codex TOML, Claude query options,
  OpenCode JSON config, and Cursor unsupported/external-only behavior.
- Unit test MCP schemas and error mapping: validation errors return
  `isError: true` when actionable, protocol errors stay JSON-RPC errors.
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
- Cursor CLI MCP behavior:
  https://docs.cursor.com/cli/mcp
- MCP tool call and result schema:
  https://modelcontextprotocol.io/specification/2025-06-18/schema
