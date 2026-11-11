import { MessageId, NodeId, type OrchestrationV2Run, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { delegatedFollowupRuns, subagentThreadTitle } from "./subagentProjection.ts";

describe("subagentThreadTitle", () => {
  it("clips a long prompt without splitting a surrogate pair", () => {
    const title = (prompt: string) =>
      subagentThreadTitle({ parentTitle: "Parent", prompt, ordinal: 1 });

    expect(title(`${"a".repeat(68)}😀 and more work.`)).toBe(`${"a".repeat(68)}...`);
    expect(title(`${"a".repeat(67)}😀 and more work.`)).toBe(`${"a".repeat(67)}😀...`);
  });
});

describe("delegatedFollowupRuns", () => {
  it("keeps a run that took the follow-up's subagent wake as a steer", () => {
    const taskId = NodeId.make("node:followup");
    const run = (id: string, ordinal: number, extra = {}) =>
      ({
        id: RunId.make(id),
        ordinal,
        status: "completed",
        userMessageId: MessageId.make(`message:${id}`),
        ...extra,
      }) as unknown as OrchestrationV2Run;
    const steeredWake = (runId: string) => ({
      id: MessageId.make(`message:steered-wake:${runId}`),
      runId: RunId.make(runId),
      delegatedCompletion: {
        parentRunId: RunId.make("run:followup"),
        generation: 1,
        taskIds: [NodeId.make("node:grandchild")],
      },
    });

    const runs = delegatedFollowupRuns(
      {
        runs: [
          run("run:original", 1),
          run("run:followup", 2, { delegatedTaskId: taskId }),
          run("run:user", 3),
          run("run:other-followup", 4, { delegatedTaskId: NodeId.make("node:other") }),
        ],
        messages: [steeredWake("run:user"), steeredWake("run:other-followup")],
      },
      taskId,
    );
    expect(runs.map((entry) => entry.id)).toEqual(["run:followup", "run:user"]);
  });
});
