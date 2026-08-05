import { NodeId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isInternalSubagentThread } from "./threadVisibility";

const rootId = ThreadId.make("thread:visibility:root");
const rootLineage = {
  rootThreadId: rootId,
  parentThreadId: null,
  relationshipToParent: null,
} as const;

describe("thread visibility", () => {
  it("keeps roots and user forks visible", () => {
    expect(isInternalSubagentThread({ lineage: rootLineage, forkedFrom: null })).toBe(false);
    expect(
      isInternalSubagentThread({
        lineage: {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "fork",
        },
        forkedFrom: {
          type: "run",
          threadId: rootId,
          runId: RunId.make("run:visibility:fork"),
        },
      }),
    ).toBe(false);
  });

  it("hides explicit and node-owned subagent children", () => {
    expect(
      isInternalSubagentThread({
        lineage: {
          rootThreadId: rootId,
          parentThreadId: rootId,
          relationshipToParent: "subagent",
        },
        forkedFrom: null,
      }),
    ).toBe(true);
    expect(
      isInternalSubagentThread({
        lineage: rootLineage,
        forkedFrom: {
          type: "node",
          nodeId: NodeId.make("node:visibility:subagent"),
        },
      }),
    ).toBe(true);
  });
});
