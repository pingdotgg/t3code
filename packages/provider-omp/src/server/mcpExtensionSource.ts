// No T3 imports inside the string; resolve Omp and typebox from the user's Omp install.
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

export const OMP_T3_MCP_EXTENSION_FILENAME = "omp-t3-mcp-extension.ts";

export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";
export const T3_OMP_RUNTIME_MODE_ENV = "T3_OMP_RUNTIME_MODE";
export const T3_OMP_MCP_EXTENSION_PATH_ENV = "T3_OMP_MCP_EXTENSION_PATH";

// These tools trigger file-change approvals, bypassed by Auto-accept edits.
export const OMP_FILE_CHANGE_TOOLS = ["edit", "write"] as const;

export const OMP_T3_MCP_EXTENSION_SOURCE = `\
import { type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as NodeFSP from "node:fs/promises";
import { Type } from "@sinclair/typebox";

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const RUNTIME_MODE_ENV = ${JSON.stringify(T3_OMP_RUNTIME_MODE_ENV)};
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim())};
const PROTOCOL = "2025-06-18";
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_CHANGE_TOOLS = new Set(${JSON.stringify(OMP_FILE_CHANGE_TOOLS)});

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
  readonly annotations?: { readonly readOnlyHint?: boolean };
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
    // Zero-argument MCP tools may omit "properties", which some OpenAI-compatible
    // servers reject. Declare it, as Omp does for its own MCP tools.
    return unsafe({
      ...schema,
      type: schema.type ?? "object",
      ...(schema.properties === undefined ? { properties: {} } : {}),
    });
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
  // the server supplied no model-facing blocks, matching Omp's native MCP tools.
  if (content.length === 0) {
    content.push({ type: "text", text: JSON.stringify(record.structuredContent ?? result) });
  }
  return content;
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
          clientInfo: { name: "t3-omp-mcp", version: "1.0.0" },
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

export default async function t3McpExtension(omp: ExtensionAPI) {
  omp.on("input", async (event) => {
    if (!event.text.includes("$")) return;
    const commands = omp.getCommands().filter((command) => command.source === "skill");
    const blocks: string[] = [];
    const seen = new Set<string>();
    for (const match of event.text.matchAll(/(^|\\s)\\$([^\\s]+)(?=\\s|$)/g)) {
      const name = match[2];
      if (!name || seen.has(name)) continue;
      const command = commands.find((candidate) => candidate.name === "skill:" + name || candidate.name === name);
      const path = command?.sourceInfo?.path ?? command?.path;
      if (!path) continue;
      seen.add(name);
      const body = await NodeFSP.readFile(path, "utf8");
      blocks.push(\`<skill name="\${name}" location="\${path}">\\n\${body}\\n</skill>\`);
    }
    if (blocks.length > 0) return { action: "transform", text: event.text + "\\n\\n" + blocks.join("\\n\\n"), images: event.images };
  });
  const readOnlyMcpTools = new Set<string>();
  omp.on("tool_call", async (event, ctx) => {
    const mode = runtimeMode();
    if (mode === "full-access" || READ_ONLY_TOOLS.has(event.toolName) || readOnlyMcpTools.has(event.toolName)) return;
    if (mode === "auto-accept-edits" && FILE_CHANGE_TOOLS.has(event.toolName)) return;
    const approved = await ctx.ui.confirm(
      \`Allow \${event.toolName}?\`, toolInputSummary(event.input), { signal: ctx.signal },
    );
    if (!approved) return { block: true, reason: \`\${event.toolName} was declined in T3 Code.\` };
  });
  const endpoint = env(URL_ENV);
  const token = env(TOKEN_ENV);
  if (endpoint === undefined || token === undefined) return;
  const client = createMcpClient(endpoint, token);
  await client.connect(AbortSignal.timeout(10_000));
  const catalog = await client.listTools(AbortSignal.timeout(10_000));
  for (const tool of catalog) {
    const name = "mcp__t3-code__" + tool.name;
    if (tool.annotations?.readOnlyHint === true) readOnlyMcpTools.add(name);
    omp.registerTool({
      name, label: tool.name, description: tool.description ?? tool.name,
      parameters: jsonSchemaToTypebox(tool.inputSchema),
      loadMode: ["orchestrator_capabilities", "delegate_task", "task_status"].includes(tool.name) ? "essential" : "discoverable",
      approval: tool.annotations?.readOnlyHint === true ? "read" : "exec",
      async execute(_toolCallId, params, signal) {
        const result = await client.callTool(tool.name, (params ?? {}) as Record<string, unknown>, signal);
        return {
          content: mcpModelContent(result), details: { server: "t3-code", tool: tool.name },
          ...(isMcpToolError(result) ? { isError: true } : {}),
        };
      },
    });
  }
  omp.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + "\\n\\n" + ORCHESTRATION_INSTRUCTIONS,
  }));
}
`;
