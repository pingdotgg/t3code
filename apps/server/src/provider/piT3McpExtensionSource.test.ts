import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

type AgentStartHook = (event: { systemPrompt: string }) => { systemPrompt: string };

type McpToolContent = (result: unknown) => unknown;

type RegisteredMcpTool = {
  readonly name: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
};

// The shipped extension as a plain script. The paths under test need no Typebox.
const runnableSource = NodeModule.stripTypeScriptTypes(
  PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
    "export default async function",
    "async function",
  ),
);

async function loadHandlers(env: Record<string, string> = {}): Promise<Map<string, unknown>> {
  const handlers = new Map<string, unknown>();
  // Execute the shipped extension with MCP disabled.
  await NodeVM.runInNewContext(`${runnableSource}\nt3McpExtension(pi)`, {
    process: { env },
    pi: { on: (name: string, handler: unknown) => handlers.set(name, handler) },
  });
  return handlers;
}

async function loadMcpTools(
  tools: ReadonlyArray<{ readonly name: string; readonly description?: string }>,
): Promise<Map<string, RegisteredMcpTool>> {
  const registered = new Map<string, RegisteredMcpTool>();
  const fetchMcp = async (_url: string, init: { readonly body: string }) => {
    const request = JSON.parse(init.body) as { readonly id?: number; readonly method: string };
    const result =
      request.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "t3-code" } }
        : request.method === "tools/list"
          ? { tools }
          : undefined;
    return {
      ok: true,
      status: 200,
      headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
      text: async () =>
        result === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id: request.id, result }),
    };
  };

  await NodeVM.runInNewContext(`${runnableSource}\nt3McpExtension(pi)`, {
    AbortSignal,
    Type: { Unsafe: (schema: unknown) => schema },
    fetch: fetchMcp,
    process: { env: { T3_MCP_URL: "http://t3.test/mcp", T3_MCP_BEARER_TOKEN: "test-token" } },
    pi: {
      on: () => undefined,
      registerTool: (tool: RegisteredMcpTool) => registered.set(tool.name, tool),
    },
  });
  return registered;
}

async function loadRequestHook(): Promise<RequestHook> {
  const hook = (await loadHandlers()).get("before_provider_request");
  assert.isDefined(hook);
  return hook as RequestHook;
}

describe("Pi upstream output-budget workaround", () => {
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    it(`caps ${key} without changing the conversation or tools`, async () => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key], 231_969);
    });
  }

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

describe("Pi runtime instructions", () => {
  it("appends T3 runtime guidance to Pi's system prompt even without MCP", async () => {
    const hook = (await loadHandlers()).get("before_agent_start") as AgentStartHook | undefined;
    assert.isDefined(hook);
    const { systemPrompt } = hook!({ systemPrompt: "Base prompt" });
    assert.isTrue(systemPrompt.startsWith("Base prompt\n\n<runtime_info>"));
    assert.include(systemPrompt, "through the Pi harness");
    assert.include(systemPrompt, "<pull_request_linking>");
  });
});

describe("Pi MCP tool results", () => {
  const mcpToolContent = NodeVM.runInNewContext(
    `${runnableSource}\nmcpToolContent`,
    {},
  ) as McpToolContent;
  const image = { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" };

  it("sends mirrored structured content once and keeps image blocks", () => {
    const text = '{"url":"https://t3.codes"}';
    assert.deepEqual(
      mcpToolContent({
        structuredContent: { url: "https://t3.codes" },
        content: [{ type: "text", text }, image],
      }),
      [{ type: "text", text }, image],
    );
  });

  it("falls back to structured content when a result has no text", () => {
    assert.deepEqual(mcpToolContent({ structuredContent: { ok: true }, content: [image] }), [
      { type: "text", text: '{"ok":true}' },
      image,
    ]);
  });
});

describe("Pi T3 delegation guidance", () => {
  it("distinguishes T3 child threads from Pi-local subagents", async () => {
    const tools = await loadMcpTools([
      { name: "delegate_work", description: "Create helper threads." },
      { name: "send_to_thread", description: "Send a message to a thread." },
    ]);
    const delegate = tools.get("mcp__t3-code__delegate_work");

    assert.isDefined(delegate);
    assert.isTrue(
      delegate.promptGuidelines?.some(
        (guideline) =>
          guideline.includes("T3 child thread") && guideline.includes("local subagent tool"),
      ),
    );
    assert.equal(tools.get("mcp__t3-code__send_to_thread")?.promptGuidelines?.length, 1);
  });
});

type ToolCallHook = (
  event: { toolName: string; input: unknown },
  ctx: { ui: { confirm: (title: string, message: string) => Promise<boolean> } },
) => Promise<unknown>;

describe("Pi tool input schemas", () => {
  const normalizeToolInputSchema = NodeVM.runInNewContext(
    `${runnableSource}\nnormalizeToolInputSchema`,
    {},
  ) as (schema: Record<string, unknown> | undefined) => Record<string, unknown>;

  it("gives property-less object schemas strict-compatible properties", () => {
    assert.deepEqual(normalizeToolInputSchema({ type: "object", additionalProperties: false }), {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: [],
    });
  });

  it("leaves well-formed schemas untouched", () => {
    const schema = {
      type: "object",
      properties: { terminalId: { type: "string" } },
      required: ["terminalId"],
      additionalProperties: false,
    };
    assert.deepEqual(normalizeToolInputSchema(schema), schema);
  });

  it("fills a missing required list from declared properties", () => {
    assert.deepEqual(
      normalizeToolInputSchema({ type: "object", properties: { q: { type: "string" } } }),
      {
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      },
    );
  });

  it("falls back to an empty object schema for missing input", () => {
    assert.deepEqual(normalizeToolInputSchema(undefined), {
      type: "object",
      properties: {},
      required: [],
    });
  });
});

describe("Pi approval summaries", () => {
  const confirmMessage = async (toolName: string, input: unknown) => {
    const hook = (await loadHandlers({ T3_PI_RUNTIME_MODE: "approval-required" })).get(
      "tool_call",
    ) as ToolCallHook;
    let message: string | undefined;
    await hook(
      { toolName, input },
      { ui: { confirm: async (_title, text) => ((message = text), true) } },
    );
    return message;
  };

  it("shows the shell command and edited path instead of raw JSON", async () => {
    assert.equal(await confirmMessage("bash", { command: "ls src", timeout: 10 }), "ls src");
    assert.equal(await confirmMessage("write", { path: "a.txt", content: "x" }), "a.txt");
  });

  it("falls back to JSON for tools without a command or path", async () => {
    assert.equal(await confirmMessage("custom", { query: "q" }), '{\n  "query": "q"\n}');
  });
});
