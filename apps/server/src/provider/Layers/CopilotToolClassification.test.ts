import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import {
  classifyCopilotToolItemType,
  isReadOnlyCopilotToolName,
} from "./CopilotToolClassification.ts";

describe("CopilotToolClassification", () => {
  it("classifies Copilot tool lifecycle items consistently", () => {
    assert.equal(classifyCopilotToolItemType({ toolName: "bash" }), "command_execution");
    assert.equal(
      classifyCopilotToolItemType({ toolName: "Task_complete" }),
      "collab_agent_tool_call",
    );
    assert.equal(
      classifyCopilotToolItemType({
        toolName: "update",
        arguments: {
          path: "README.md",
          content: "new content",
        },
      }),
      "file_change",
    );
    assert.equal(
      classifyCopilotToolItemType({
        toolName: "run_in_terminal",
        arguments: {
          command: "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: README.md\nPATCH",
        },
      }),
      "file_change",
    );
    assert.equal(
      classifyCopilotToolItemType({
        toolName: "execute",
        arguments: {
          filePath: "README.md",
          newString: "updated",
        },
      }),
      "file_change",
    );
    assert.equal(classifyCopilotToolItemType({ toolName: "Read" }), "dynamic_tool_call");
    assert.equal(classifyCopilotToolItemType({ toolName: "web_fetch" }), "web_search");
    assert.equal(classifyCopilotToolItemType({ toolName: "screenshot" }), "image_view");
    assert.equal(
      classifyCopilotToolItemType({ toolName: "call_tool", mcpServerName: "github" }),
      "mcp_tool_call",
    );
  });

  it("detects read-only Copilot tools", () => {
    assert.equal(isReadOnlyCopilotToolName("Read"), true);
    assert.equal(isReadOnlyCopilotToolName("read_file"), true);
    assert.equal(isReadOnlyCopilotToolName("grep"), true);
    assert.equal(isReadOnlyCopilotToolName("edit_file"), false);
    assert.equal(isReadOnlyCopilotToolName("bash"), false);
  });
});
