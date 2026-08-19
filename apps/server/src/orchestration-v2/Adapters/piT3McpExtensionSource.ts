/**
 * Source for the T3-owned Pi extension that consumes T3's HTTP MCP server.
 *
 * Pi core has no MCP client. This file is TypeScript that Pi itself loads via
 * `--extension`. It is written to a cache path at session open so packaged
 * AppImage builds do not need a sibling .ts file next to the bundled server.
 *
 * Do not import t3code modules from the string body. The Pi process resolves
 * `@earendil-works/pi-coding-agent` and `typebox` from the user's pi install.
 */
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "../../provider/T3OrchestrationInstructions.ts";

export const PI_T3_MCP_EXTENSION_FILENAME = "pi-t3-mcp-extension.ts";

export const T3_MCP_URL_ENV = "T3_MCP_URL";
export const T3_MCP_BEARER_ENV = "T3_MCP_BEARER_TOKEN";

export const PI_T3_MCP_EXTENSION_SOURCE = `\
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const URL_ENV = ${JSON.stringify(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${JSON.stringify(T3_MCP_BEARER_ENV)};
const ORCHESTRATION_INSTRUCTIONS = ${JSON.stringify(T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim())};
const PROTOCOL = "2025-06-18";

type JsonRpcResponse = {
  readonly id?: number | string;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
};

type McpTool = {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
};

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
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

function formatMcpContent(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result !== "object") return String(result);
  const record = result as {
    readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
    readonly structuredContent?: unknown;
    readonly isError?: boolean;
  };
  const texts: string[] = [];
  if (Array.isArray(record.content)) {
    for (const part of record.content) {
      if (part?.type === "text" && typeof part.text === "string") texts.push(part.text);
    }
  }
  if (record.structuredContent !== undefined) {
    texts.push(JSON.stringify(record.structuredContent));
  }
  if (texts.length > 0) return texts.join("\\n");
  return JSON.stringify(result);
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

  const client = createMcpClient(endpoint, token);
  let started: Promise<void> | undefined;

  const ensureStarted = () => {
    if (started !== undefined) return started;
    const attempt = (async () => {
      const signal = AbortSignal.timeout(10_000);
      await client.connect(signal);
      const tools = await client.listTools(signal);
      for (const tool of tools) {
        const name = tool.name;
        const description = tool.description ?? name;
        pi.registerTool({
          name,
          label: name,
          description,
          promptSnippet: description.split("\\n")[0] ?? name,
          promptGuidelines: [
            \`Use \${name} from the t3-code MCP server when the user asks for T3 orchestration that this tool covers.\`,
          ],
          parameters: jsonSchemaToTypebox(tool.inputSchema),
          async execute(_toolCallId, params, signal) {
            const result = await client.callTool(
              name,
              (params ?? {}) as Record<string, unknown>,
              signal,
            );
            const text = formatMcpContent(result);
            return {
              content: [{ type: "text", text }],
              details: { server: "t3-code", tool: name },
              ...(isMcpToolError(result) ? { isError: true } : {}),
            };
          },
        });
      }
    })();
    started = attempt;
    void attempt.catch(() => {
      if (started === attempt) started = undefined;
    });
    return attempt;
  };

  // Await here so tools exist before session_start and the first prompt.
  // session_start is a retry if the process later reloads the extension.
  // Best effort during extension load. A failed first connection is retried
  // below on session_start instead of pinning this process to the failure.
  await ensureStarted().catch(() => undefined);

  pi.on("session_start", async (_event, ctx) => {
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
