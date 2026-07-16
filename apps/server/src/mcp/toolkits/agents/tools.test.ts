import { describe, expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { UnifiedSubAgentToolkit } from "../../../subagent/UnifiedSubAgentTool.ts";
import { SubAgentToolkit } from "./tools.ts";

/**
 * MCP requires tool inputSchema to be a JSON Schema object type at the top
 * level (`type: "object"`). Empty `Schema.Struct({})` previously emitted
 * anyOf without that property, which caused Claude Code's tools/list
 * validation to reject the entire toolkit.
 */
describe("sub-agent MCP tool inputSchema", () => {
  const tools = [
    ...Object.values(SubAgentToolkit.tools),
    ...Object.values(UnifiedSubAgentToolkit.tools),
  ];

  it("covers every tool in SubAgentToolkit and UnifiedSubAgentToolkit", () => {
    expect(Object.keys(SubAgentToolkit.tools).sort()).toEqual(
      ["agent_list", "agent_send", "agent_spawn", "agent_wait"].sort(),
    );
    expect(Object.keys(UnifiedSubAgentToolkit.tools)).toEqual(["subagent"]);
    expect(tools).toHaveLength(5);
  });

  for (const tool of tools) {
    it(`${tool.name} emits top-level type "object"`, () => {
      const schema = Tool.getJsonSchema(tool);
      expect(schema.type).toBe("object");
    });
  }
});
