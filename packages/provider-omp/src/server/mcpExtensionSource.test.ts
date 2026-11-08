// @effect-diagnostics nodeBuiltinImport:off -- Execute the shipped extension at its native JavaScript boundary.
import { expect, it } from "@effect/vitest";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { OMP_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

it("registers MCP tools and blocks declined mutations through native confirmation", async () => {
  type Hook = (
    event: { toolName: string; input: unknown },
    ctx: { ui: { confirm: () => Promise<boolean> } },
  ) => Promise<unknown>;
  const hooks = new Map<string, Hook>();
  const registered: Array<{
    name: string;
    execute: (id: string, params: unknown) => Promise<unknown>;
  }> = [];
  const calls: string[] = [];
  const source = NodeModule.stripTypeScriptTypes(
    OMP_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(omp)`, {
    process: {
      env: {
        T3_MCP_URL: "https://fixture.invalid/mcp",
        T3_MCP_BEARER_TOKEN: "fixture",
        T3_OMP_RUNTIME_MODE: "approval-required",
      },
    },
    AbortSignal,
    Type: { Unsafe: (schema: unknown) => schema },
    omp: {
      on: (name: string, hook: Hook) => hooks.set(name, hook),
      registerTool: (tool: (typeof registered)[number]) => registered.push(tool),
    },
    fetch: async (_url: string, options: { body: string }) => {
      const request = JSON.parse(options.body) as { id: number; method: string };
      calls.push(request.method);
      return new Response(
        JSON.stringify({
          id: request.id,
          result:
            request.method === "tools/list"
              ? { tools: [{ name: "write_note", inputSchema: { type: "object", properties: {} } }] }
              : { content: [{ type: "text", text: "done" }] },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  expect(registered.map((tool) => tool.name)).toEqual(["mcp__t3-code__write_note"]);
  const hook = hooks.get("tool_call")!;
  expect(
    await hook({ toolName: "write", input: { path: "a" } }, { ui: { confirm: async () => false } }),
  ).toEqual({ block: true, reason: "write was declined in T3 Code." });
  expect(
    await hook({ toolName: "write", input: {} }, { ui: { confirm: async () => true } }),
  ).toBeUndefined();
  expect(await registered[0]!.execute("tool-1", {})).toMatchObject({
    content: [{ type: "text", text: "done" }],
  });
  expect(calls).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
});
