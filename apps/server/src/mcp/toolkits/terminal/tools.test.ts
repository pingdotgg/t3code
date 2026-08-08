import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { TerminalToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

const SESSION_SCOPED_TOOLS = new Set([
  "terminal_write",
  "terminal_read",
  "terminal_wait",
  "terminal_close",
]);

it("registers the whole terminal toolkit", () => {
  expect(Object.keys(TerminalToolkit.tools).sort()).toEqual([
    "terminal_close",
    "terminal_list",
    "terminal_open",
    "terminal_read",
    "terminal_wait",
    "terminal_write",
  ]);
});

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(TerminalToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("never lets the agent name the thread it operates on", () => {
  for (const tool of Object.values(TerminalToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly properties?: Readonly<Record<string, unknown>>;
    };
    expect(
      schema.properties?.threadId,
      `${tool.name} must take its thread from the MCP invocation scope`,
    ).toBeUndefined();
    if (SESSION_SCOPED_TOOLS.has(tool.name)) {
      expect(
        schema.properties?.terminalId,
        `${tool.name} must target an explicit terminal`,
      ).toBeDefined();
    }
  }
});
