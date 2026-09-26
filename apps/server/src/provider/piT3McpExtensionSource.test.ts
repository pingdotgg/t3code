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

// The shipped extension as a plain script. The paths under test need no Typebox.
const runnableSource = NodeModule.stripTypeScriptTypes(
  PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
    "export default async function",
    "async function",
  ),
);

async function loadHandlers(): Promise<Map<string, unknown>> {
  const handlers = new Map<string, unknown>();
  // Execute the shipped extension with MCP disabled.
  await NodeVM.runInNewContext(`${runnableSource}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: unknown) => handlers.set(name, handler) },
  });
  return handlers;
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
