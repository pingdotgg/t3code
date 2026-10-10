/**
 * Source for the T3-owned Pi extension that consumes T3's HTTP MCP server.
 *
 * Pi 0.99+ discovers optional HTTP bridge tools on demand. Older versions
 * keep them directly available. Pi loads this TypeScript via `--extension`; the
 * server writes it to a cache so packaged builds need no sibling .ts file.
 *
 * Do not import t3code modules from the string body. The Pi process resolves
 * `@earendil-works/pi-coding-agent` and `typebox` from the user's pi install.
 */
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

export const PI_T3_MCP_EXTENSION_FILENAME = "pi-t3-mcp-extension.ts";

export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";
export const T3_PI_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE";

/**
 * Pi tools whose confirmations the bridge raises as file-change approvals.
 * Auto-accept edits skips them; the adapter keys the approval kind off them.
 */
export const PI_FILE_CHANGE_TOOLS = ["edit", "write"] as const;

export const PI_T3_MCP_EXTENSION_SOURCE = `\
import { stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Type } from "typebox";

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(T3_PI_RUNTIME_MODE_ENV)};
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim())};
const PROTOCOL = "2025-06-18";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(PI_FILE_CHANGE_TOOLS)});

type RuntimeMode = "approval-required" | "auto-accept-edits" | "auto" | "full-access";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: JsonValue;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function runtimeMode(): RuntimeMode {
  const value = env(RUNTIME_MODE_ENV);
  return value === "approval-required" ||
    value === "auto-accept-edits" ||
    value === "auto" ||
    value === "full-access"
    ? value
    : "full-access";
}

function toolInputSummary(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2).slice(0, 4_000);
  } catch {
    return String(input).slice(0, 4_000);
  }
}

function parseSseOrJson(body: string, contentType: string): JsonRpcResponse {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split("\\n")) {
      const trimmed = line.startsWith("data:") ? line.slice(5).trim() : "";
      if (trimmed.length === 0) continue;
      const parsed = JSON.parse(trimmed) as JsonRpcResponse;
      if (parsed.id !== undefined || parsed.result !== undefined || parsed.error !== undefined) {
        return parsed;
      }
    }
    throw new Error("MCP SSE response had no JSON-RPC payload.");
  }
  return JSON.parse(body) as JsonRpcResponse;
}

function jsonSchemaToTypebox(schema: Record<string, unknown> | undefined) {
  const unsafe = (Type as { Unsafe?: (value: unknown) => unknown }).Unsafe;
  if (typeof unsafe === "function" && schema !== undefined) {
    return unsafe(schema);
  }
  return Type.Object({}, { additionalProperties: true });
}

type ModelContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

function mcpModelContent(result: unknown): ModelContent[] {
  if (result === null || result === undefined) return [];
  if (typeof result !== "object") return [{ type: "text", text: String(result) }];
  const record = result as {
    readonly content?: ReadonlyArray<{
      readonly type?: string;
      readonly text?: string;
      readonly data?: string;
      readonly mimeType?: string;
    }>;
    readonly structuredContent?: unknown;
  };
  const content: ModelContent[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
      } else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
      }
    }
  }
  // Structured output belongs to scripts. Only use it as model text when
  // the server supplied no model-facing blocks, matching Pi's native MCP tools.
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? result) });
  }
  return content;
}

function mcpScriptResult(result: JsonValue | undefined) {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return result;
  const { _meta: _ignored, ...scriptResult } = result;
  return scriptResult;
}

function mcpOutputSchema(tool: McpTool) {
  return jsonSchemaToTypebox({
    type: "object",
    properties: {
      content: { type: "array", items: { type: "object" } },
      ...(tool.outputSchema === undefined ? {} : { structuredContent: tool.outputSchema }),
      isError: { type: "boolean" },
      _meta: { type: "object" },
    },
    required: ["content"],
  });
}

function isMcpToolError(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    result.isError === true
  );
}

function createMcpClient(endpoint: string, token: string) {
  let nextId = 1;
  let sessionId: string | undefined;

  const headers = (): Record<string, string> => {
    const next: Record<string, string> = {
      accept: "application/json, text/event-stream",
      authorization: token.startsWith("Bearer ") ? token : \`Bearer \${token}\`,
      "content-type": "application/json",
      // Effect's HTTP MCP rejects post-initialize requests without this
      // (400). The worktree client in McpHttpServer tests sends the same
      // header; initialize itself does not require it.
      "mcp-protocol-version": PROTOCOL,
    };
    if (sessionId !== undefined) next["mcp-session-id"] = sessionId;
    return next;
  };

  const request = async (method: string, params?: unknown, signal?: AbortSignal) => {
    const id = nextId++;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    const nextSession = response.headers.get("mcp-session-id");
    if (nextSession) sessionId = nextSession;
    const body = await response.text();
    if (!response.ok) {
      throw new Error(\`MCP \${method} failed (\${response.status}): \${body.slice(0, 400)}\`);
    }
    if (body.length === 0) return undefined;
    const parsed = parseSseOrJson(body, response.headers.get("content-type") ?? "");
    if (parsed.error) {
      throw new Error(parsed.error.message ?? \`MCP \${method} returned an error\`);
    }
    return parsed.result;
  };

  const notify = async (method: string, params?: unknown, signal?: AbortSignal) => {
    await fetch(endpoint, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      signal,
    });
  };

  return {
    async connect(signal?: AbortSignal) {
      await request(
        "initialize",
        {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: "t3-pi-mcp", version: "1.0.0" },
        },
        signal,
      );
      await notify("notifications/initialized", {}, signal).catch(() => undefined);
    },
    async listTools(signal?: AbortSignal) {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const result = (await request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          signal,
        )) as { tools?: McpTool[]; nextCursor?: string } | undefined;
        tools.push(...(result?.tools ?? []));
        cursor = result?.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
      return request("tools/call", { name, arguments: args }, signal);
    },
  };
}

export default async function t3McpExtension(pi: ExtensionAPI) {
  // Keep skill chips in the request. Pi expands only one leading /skill:
  // command, so use its own frontmatter loader for every selected chip here.
  pi.on("input", async (event, ctx) => {
    if (!event.text.includes("$")) return;
    const commands = pi.getCommands().filter((command) => command.source === "skill");
    const nativeSkill = /^\\/skill:([^ ]+)(?: |$)/.exec(event.text)?.[1];
    const seen = new Set<string>(nativeSkill === undefined ? [] : [nativeSkill]);
    const blocks: string[] = [];
    for (const match of event.text.matchAll(/(^|\\s)\\$([^\\s]+)(?=\\s|$)/g)) {
      const name = match[2];
      if (name === undefined || seen.has(name)) continue;
      const command = commands.find((candidate) => candidate.name === "skill:" + name);
      if (command === undefined) continue;
      seen.add(name);
      const path = command.sourceInfo.path;
      try {
        const body = stripFrontmatter(await NodeFSP.readFile(path, "utf8")).trim();
        blocks.push(
          \`<skill name="\${name}" location="\${path}">\\nReferences are relative to \${NodePath.dirname(path)}.\\n\\n\${body}\\n</skill>\`,
        );
      } catch {
        ctx.ui.notify(\`Could not load skill \${name} from \${path}.\`, "error");
      }
    }
    if (blocks.length === 0) return;
    return {
      action: "transform",
      text: event.text + "\\n\\n" + blocks.join("\\n\\n"),
      images: event.images,
    };
  });

  // Workaround for an upstream Pi context-budgeting bug: pi-ai reuses the
  // previous response's usage even when a fork's instructions/tools differ,
  // then reserves almost all remaining context for output. OpenRouter can
  // reject even a short conversation. Remove this cap when Pi accounts for
  // the current request prefix reliably (api/simple-options + utils/estimate).
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.provider !== "openrouter") return;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return;
    const replacement = { ...payload } as Record<string, unknown>;
    let changed = false;
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const limit = replacement[key];
      if (typeof limit === "number" && Number.isFinite(limit) && limit > 32_768) {
        replacement[key] = 32_768;
        changed = true;
      }
    }
    if (changed) return replacement;
  });

  // Pi deliberately leaves permission policy to extensions. T3's injected
  // bridge uses Pi's public blocking tool hook so the shared runtime modes
  // keep their normal meaning without replacing or shadowing Pi's runtime.
  // Only Pi's own search is known to be read-only. An extension that replaces
  // it keeps the name, and cannot discover deferred tools either.
  const hasBuiltinToolSearch = () =>
    typeof pi.getAllTools === "function" &&
    pi.getAllTools().some((tool) => tool.name === "tool_search" && tool.sourceInfo?.path === "builtin:tool-search");

  pi.on("tool_call", async (event, ctx) => {
    const mode = runtimeMode();
    if (mode === "full-access") return;
    if (event.toolName === "tool_search" ? hasBuiltinToolSearch() : READ_ONLY_TOOLS.has(event.toolName)) {
      return;
    }
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) {
      return;
    }
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`,
      toolInputSummary(event.input),
      { signal: ctx.signal },
    );
    if (!approved) {
      return { block: true, reason: \`\${event.toolName} was declined in T3 Code.\` };
    }
  });

  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  if (endpoint === undefined || token === undefined) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "t3-code MCP unavailable: T3_MCP_URL or T3_MCP_BEARER_TOKEN is missing.",
        "warning",
      );
    });
    return;
  }

  // Tool exposure arrived with registerMcpServer in Pi 0.99. Keep the HTTP
  // bridge as the credential owner: mcp.json overrides native registrations.
  const supportsExposure = "registerMcpServer" in pi && typeof pi.registerMcpServer === "function";
  const directTools = new Set(["orchestrator_capabilities", "delegate_task", "task_status"]);
  let deferOptionalTools = supportsExposure;
  let catalog: ReadonlyArray<McpTool> = [];

  const client = createMcpClient(endpoint, token);
  let started: Promise<void> | undefined;

  const registerTools = () => {
    // Preserve public names for saved loadouts and tool selectors. Hidden
    // canonical names reserve ownership against Pi's configured MCP servers.
    const prefixes = supportsExposure ? ["mcp__t3-code__", "mcp__t3_code__"] : ["mcp__t3-code__"];
    for (const tool of catalog) {
      const name = tool.name;
      for (const prefix of prefixes) {
        const exposure = prefix === "mcp__t3_code__" ? "hidden" :
          deferOptionalTools && !directTools.has(name) ? "deferred" : "direct";
        pi.registerTool({
          name: \`\${prefix}\${name}\`,
          label: name,
          description: tool.description ?? name,
          parameters: jsonSchemaToTypebox(tool.inputSchema),
          ...(supportsExposure ? { outputSchema: mcpOutputSchema(tool) } : {}),
          ...(supportsExposure ? { exposure } : {}),
          async execute(_toolCallId, params, signal) {
            const result = await client.callTool(
              name,
              (params ?? {}) as Record<string, unknown>,
              signal,
            );
            const content = mcpModelContent(result);
            if (isMcpToolError(result) && !content.some((part) => part.type === "text" && part.text.length > 0)) {
              content.push({ type: "text", text: "MCP tool t3-code/" + name + " returned an error" });
            }
            return {
              content,
              structuredContent: mcpScriptResult(result),
              details: { server: "t3-code", tool: name },
              ...(isMcpToolError(result) ? { isError: true } : {}),
            };
          },
        });
      }
    }
  };

  const ensureStarted = () => {
    if (started !== undefined) return started;
    const attempt = (async () => {
      const signal = AbortSignal.timeout(10_000);
      await client.connect(signal);
      catalog = await client.listTools(signal);
      registerTools();
    })();
    started = attempt;
    void attempt.catch(() => {
      if (started === attempt) started = undefined;
    });
    return attempt;
  };

  // CLI extensions load before builtins, and Pi keeps the first registration
  // of a tool name. Register now so the bridge owns the T3 namespace even when
  // mcp.json configures it; retry a failed connection at session_start.
  await ensureStarted().catch(() => undefined);

  const reconcileDiscovery = () => {
    if (!supportsExposure) return;
    // A disabled or replaced search builtin cannot discover deferred tools.
    const hasToolSearch = hasBuiltinToolSearch();
    const exposureChanged = deferOptionalTools !== hasToolSearch;
    deferOptionalTools = hasToolSearch;
    if (exposureChanged) registerTools();
    if (hasToolSearch) {
      const active = pi.getActiveTools();
      if (!active.includes("tool_search")) pi.setActiveTools([...active, "tool_search"]);
    }
  };

  // Tree navigation restores its saved loadout after session_start.
  pi.on("session_tree", reconcileDiscovery);
  pi.on("session_start", async (_event, ctx) => {
    reconcileDiscovery();
    try {
      await ensureStarted();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(\`t3-code MCP unavailable: \${message}\`, "warning");
    }
  });

  // Deliver orchestration guidance through pi's real system-prompt channel.
  // Wrapping the first user message instead would stop it from starting
  // with "/" and silently break slash-command expansion.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\\n\\n" + ORCHESTRATION_INSTRUCTIONS,
  }));
}
`;
