// @effect-diagnostics nodeBuiltinImport:off -- Executes the shipped Pi extension at its native JavaScript boundary.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly outputSchema?: unknown;
  readonly exposure?: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
  readonly prepareLoadout?: (loadout: {
    readonly declared: ReadonlyArray<RegisteredTool>;
    readonly callable: ReadonlyArray<RegisteredTool>;
    readonly registered: ReadonlyArray<RegisteredTool>;
    readonly getExposure: (name: string) => string;
  }) => { readonly hiddenDeclarations?: ReadonlyArray<string> } | undefined;
  readonly execute: (
    id: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<{
      readonly type: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  }>;
}

type AgentStartHook = (
  event: {
    systemPrompt: string;
    systemPromptOptions?: { sections?: Record<string, string> | null; forceSystemPrompt?: string };
  },
  ctx: {
    model?: { api: string };
    ui: { notify: (message: string, severity: string) => void };
  },
) => Promise<{ systemPrompt: string } | undefined>;

function activatesOnRegistration(tool: RegisteredTool) {
  return (
    tool.exposure === undefined || tool.exposure === "direct" || tool.exposure === "model-only"
  );
}

export async function loadMcpBridge(
  options: {
    readonly modern?: boolean;
    readonly result?: unknown;
    readonly toolSearchAvailable?: boolean;
    readonly toolSearchDisabled?: boolean;
    // Pi activates direct and model-only tools when they are registered.
    readonly activatesOnRegistration?: boolean;
    readonly allowsTool?: (name: string) => boolean;
    readonly runtimeMode?: string;
    readonly inputSchema?: Record<string, unknown>;
  } = {},
) {
  const handlers = new Map<string, AgentStartHook>();
  const tools: RegisteredTool[] = [];
  const requests: Array<{ readonly method: string; readonly params?: unknown }> = [];
  let activeTools = ["read"];
  let bridgeSourcePath = "/fixture/pi-t3-extension.ts";
  const transports: Array<{
    readonly url: string;
    readonly authorization: string;
    readonly signal: AbortSignal | undefined;
  }> = [];
  const servers: Array<{ readonly name: string; readonly config: Record<string, unknown> }> = [];
  const catalog = [
    {
      name: "orchestrator_capabilities",
      description: "Discover available providers and models.",
      annotations: { readOnlyHint: true },
    },
    { name: "delegate_task", description: "Delegate work to another agent." },
    {
      name: "task_status",
      description: "Check delegated work.",
      annotations: { readOnlyHint: false },
    },
    { name: "preview_snapshot", description: "Inspect the collaborative browser." },
  ].map((tool) => ({
    ...tool,
    inputSchema: options.inputSchema ?? { type: "object", properties: {} },
    outputSchema: { type: "object", properties: { count: { type: "number" } } },
  }));
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: {
      env: {
        T3_MCP_URL: "http://fixture.invalid/mcp",
        T3_MCP_BEARER_TOKEN: "fixture-token",
        T3_PI_MCP_EXTENSION_PATH: "/fixture/pi-t3-extension.ts",
        T3_PI_RUNTIME_MODE: options.runtimeMode,
      },
    },
    AbortSignal,
    NodePath,
    Type: { Unsafe: (schema: unknown) => schema },
    fetch: async (
      url: string,
      transport: { body: string; headers: Record<string, string>; signal?: AbortSignal },
    ) => {
      transport.signal?.throwIfAborted();
      transports.push({
        url,
        authorization: transport.headers.authorization!,
        signal: transport.signal,
      });
      const request = JSON.parse(transport.body) as {
        id: number;
        method: string;
        params?: unknown;
      };
      requests.push(request);
      const result =
        request.method === "tools/list"
          ? { tools: catalog }
          : request.method === "tools/call"
            ? (options.result ?? { content: [{ type: "text", text: "browser snapshot" }] })
            : {};
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
        headers: { "content-type": "application/json" },
      });
    },
    pi: {
      on: (name: string, handler: AgentStartHook) => handlers.set(name, handler),
      registerTool: (tool: RegisteredTool) => {
        if (options.allowsTool && !options.allowsTool(tool.name)) return;
        const index = tools.findIndex((current) => current.name === tool.name);
        const previous = index === -1 ? undefined : tools[index];
        if (index === -1) tools.push(tool);
        else tools[index] = tool;
        if (
          options.activatesOnRegistration &&
          activatesOnRegistration(tool) &&
          (previous === undefined || !activatesOnRegistration(previous)) &&
          !activeTools.includes(tool.name)
        ) {
          activeTools = [...activeTools, tool.name];
        }
      },
      getActiveTools: () => activeTools,
      setActiveTools: (names: string[]) => {
        activeTools = names.filter((name) => options.allowsTool?.(name) ?? true);
      },
      getAllTools: () => [
        ...tools.map((tool) => ({ name: tool.name, sourceInfo: { path: bridgeSourcePath } })),
        ...(options.toolSearchAvailable &&
        !options.toolSearchDisabled &&
        (options.allowsTool?.("tool_search") ?? true)
          ? [{ name: "tool_search", sourceInfo: { path: "builtin:tool-search" } }]
          : []),
      ],
      ...(options.modern
        ? {
            registerMcpServer: (name: string, config: Record<string, unknown>) =>
              servers.push({ name, config }),
            unregisterMcpServer: () => servers.splice(0),
          }
        : {}),
    },
  });
  const exposureOf = (name: string) =>
    tools.find((tool) => tool.name === name)?.exposure ?? "direct";
  // Pi resolves model tool calls against the active, non-hidden tools only.
  const modelTools = () =>
    tools.filter((tool) => activeTools.includes(tool.name) && exposureOf(tool.name) !== "hidden");
  // Pi's ctx.executeTool() catalog, which codemode scripts search and list.
  const callableTools = () =>
    tools.filter(
      (tool) =>
        ["codemode", "deferred"].includes(exposureOf(tool.name)) ||
        (exposureOf(tool.name) === "direct" && activeTools.includes(tool.name)),
    );
  const declaredTools = () => {
    const active = modelTools();
    const loadout = {
      declared: active,
      callable: callableTools(),
      registered: tools,
      getExposure: exposureOf,
    };
    const hidden = new Set(
      active.flatMap((tool) => tool.prepareLoadout?.(loadout)?.hiddenDeclarations ?? []),
    );
    return active.map((tool) => tool.name).filter((name) => !hidden.has(name));
  };
  return {
    handlers,
    tools,
    declaredTools,
    callableTools: () => callableTools().map((tool) => tool.name),
    callModelTool: async (name: string, args: Record<string, unknown>) => {
      const tool = modelTools().find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return { content: [{ type: "text", text: `Tool ${name} not found` }], isError: true };
      }
      return tool.execute("model-call", args);
    },
    setBridgeSourcePath: (path: string) => {
      bridgeSourcePath = path;
    },
    requests,
    servers,
    transports,
    getActiveTools: () => activeTools,
    restoreActiveTools: (names: string[]) => {
      activeTools = names;
    },
  };
}
