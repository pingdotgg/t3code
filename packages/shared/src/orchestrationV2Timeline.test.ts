import { NodeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isOrchestrationV2TurnItemVisible } from "./orchestrationV2Timeline.ts";

const runId = RunId.make("run:timeline-visibility");
const nodeId = NodeId.make("node:timeline-visibility");

describe("isOrchestrationV2TurnItemVisible", () => {
  it("hides interruption results from superseded attempts", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
      }),
    ).toBe(false);
  });

  it("keeps interruption results from terminal attempts", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
      }),
    ).toBe(true);
  });

  it("does not hide an interruption because another attempt was superseded", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [
          {
            runId,
            rootNodeId: NodeId.make("node:timeline-visibility:older"),
            status: "superseded",
          },
          { runId, rootNodeId: nodeId, status: "interrupted" },
        ],
      }),
    ).toBe(true);
  });
});
