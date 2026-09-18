import { describe, expect, it } from "vite-plus/test";

import { openCode2ToolTitle, toOpenCode2ToolItemType } from "./OpenCode2Adapter.ts";

/**
 * Both clients derive a tool row's group from its canonical item type and, for
 * reads, from the "Read file" title. `file_change` is the edit bucket, so a
 * read typed as one renders "Changed N files" for calls that only read.
 */
describe("OpenCode2 tool mapping", () => {
  it.each(["read", "glob", "grep", "READ"])("does not type %s as a file change", (toolName) => {
    expect(toOpenCode2ToolItemType(toolName)).toBe("dynamic_tool_call");
  });

  it.each(["read", "glob", "grep"])("titles %s as a read", (toolName) => {
    expect(openCode2ToolTitle(toolName)).toEqual({ title: "Read file" });
  });

  it.each([
    ["shell", "command_execution"],
    ["edit", "file_change"],
    ["write", "file_change"],
    ["multiedit", "file_change"],
    ["webfetch", "web_search"],
    ["subagent", "collab_agent_tool_call"],
  ] as const)("keeps %s as %s", (toolName, itemType) => {
    expect(toOpenCode2ToolItemType(toolName)).toBe(itemType);
    expect(openCode2ToolTitle(toolName)).toEqual({ title: toolName });
  });

  it("omits the title when the tool is unknown", () => {
    expect(openCode2ToolTitle(undefined)).toEqual({});
  });
});
