import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import {
  classifyProviderToolItemType,
  classifyProviderToolRequestType,
} from "./providerToolClassification.ts";

describe("providerToolClassification", () => {
  it("classifies common provider tools consistently", () => {
    assert.equal(classifyProviderToolItemType({ toolName: "bash" }), "command_execution");
    assert.equal(classifyProviderToolItemType({ toolName: "Task_complete" }), "collab_agent_tool_call");
    assert.equal(
      classifyProviderToolItemType({
        toolName: "update",
        arguments: {
          path: "README.md",
          content: "new content",
        },
      }),
      "file_change",
    );
    assert.equal(classifyProviderToolItemType({ toolName: "Read" }), "dynamic_tool_call");
    assert.equal(classifyProviderToolItemType({ toolName: "web_fetch" }), "web_search");
    assert.equal(classifyProviderToolItemType({ toolName: "screenshot" }), "image_view");
    assert.equal(
      classifyProviderToolItemType({ toolName: "call_tool", mcpServerName: "github" }),
      "mcp_tool_call",
    );
  });

  it("classifies approval requests from the same rules", () => {
    assert.equal(classifyProviderToolRequestType("Read"), "file_read_approval");
    assert.equal(classifyProviderToolRequestType("bash"), "command_execution_approval");
    assert.equal(classifyProviderToolRequestType("edit_file"), "file_change_approval");
    assert.equal(classifyProviderToolRequestType("Task"), "dynamic_tool_call");
  });
});
