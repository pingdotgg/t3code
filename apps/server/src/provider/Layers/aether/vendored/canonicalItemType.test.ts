import { describe, expect, it } from "vite-plus/test";

import { isToolLifecycleItemType } from "@t3tools/contracts";

import {
  AETHER_CANONICAL_ITEM_TYPES,
  toolLifecycleItemTypeFromAether,
  type AetherCanonicalItemType,
} from "./canonicalItemType.ts";

// One expectation per Aether canonical item type — exhaustive by
// construction: the Record type errors if a value of the vendored enum is
// missing here, and the loop below proves the enum has no extra members.
const EXPECTED: Record<AetherCanonicalItemType, string> = {
  user_message: "dynamic_tool_call",
  assistant_message: "dynamic_tool_call",
  reasoning: "dynamic_tool_call",
  plan: "dynamic_tool_call",
  command_execution: "command_execution",
  file_change: "file_change",
  // t3's ToolLifecycleItemType has no `file_read`; unmapped → dynamic_tool_call.
  file_read: "dynamic_tool_call",
  mcp_tool_call: "mcp_tool_call",
  dynamic_tool_call: "dynamic_tool_call",
  collab_agent_tool_call: "collab_agent_tool_call",
  web_search: "web_search",
  web_fetch: "dynamic_tool_call",
  image_view: "image_view",
  task_tracking: "dynamic_tool_call",
  subagent_invocation: "collab_agent_tool_call",
  review_entered: "dynamic_tool_call",
  review_exited: "dynamic_tool_call",
  context_compaction: "dynamic_tool_call",
  error: "dynamic_tool_call",
  unknown: "dynamic_tool_call",
};

describe("toolLifecycleItemTypeFromAether", () => {
  it("classifies every Aether canonical item type into t3's closed union", () => {
    for (const itemType of AETHER_CANONICAL_ITEM_TYPES) {
      const mapped = toolLifecycleItemTypeFromAether(itemType);
      expect(mapped).toBe(EXPECTED[itemType]);
      expect(isToolLifecycleItemType(mapped)).toBe(true);
    }
  });

  it("maps subagent_invocation to collab_agent_tool_call", () => {
    expect(toolLifecycleItemTypeFromAether("subagent_invocation")).toBe("collab_agent_tool_call");
  });

  it("never invents a new string for values outside the vendored enum", () => {
    expect(toolLifecycleItemTypeFromAether("some_future_type")).toBe("dynamic_tool_call");
    expect(toolLifecycleItemTypeFromAether("")).toBe("dynamic_tool_call");
  });
});
