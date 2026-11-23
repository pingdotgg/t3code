import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";

const CHILD_TASK_ID = "a5d7d869cbb05c754";
const GRANDCHILD_TASK_ID = "a412f30077dfd84dd";

// Grandchild completion notifies its owning child; only that child's completion wakes the root.
export function assertClaudeNestedBackgroundSubagentWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 2 });

  const byTask = (taskId: string) => {
    const subagent = projection.subagents.find((agent) => agent.nativeTaskRef?.nativeId === taskId);
    assert.isDefined(subagent, `missing subagent for task ${taskId}`);
    assert.equal(subagent.status, "completed");
    return subagent;
  };
  const child = byTask(CHILD_TASK_ID);
  const grandchild = byTask(GRANDCHILD_TASK_ID);
  assert.equal(child.parentNodeId, projection.runs[0]?.rootNodeId);
  assert.equal(grandchild.parentNodeId, child.id, "the grandchild hangs off the child");
  assert.equal(grandchild.runId, child.runId, "the grandchild stays in the child's run");

  const wakeStartIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "run.updated" &&
      event.payload.id === projection.runs[1]?.id &&
      event.payload.status === "starting",
  );
  assert.isAtLeast(wakeStartIndex, 0);
  const grandchildRowIndex = result.domainEvents.findIndex(
    (event) => event.type === "subagent.updated" && event.payload.id === grandchild.id,
  );
  const grandchildThreadIndex = result.domainEvents.findIndex(
    (event) => event.type === "thread.created" && event.payload.id === grandchild.childThreadId,
  );
  const grandchildEndIndex = result.domainEvents.findIndex(
    (event) =>
      event.type === "subagent.updated" &&
      event.payload.id === grandchild.id &&
      event.payload.status === "completed",
  );
  for (const [label, index] of [
    ["row", grandchildRowIndex],
    ["thread", grandchildThreadIndex],
    ["completion", grandchildEndIndex],
  ] as const) {
    assert.isAtLeast(index, 0, `the grandchild's ${label} is stored`);
    assert.isBelow(
      index,
      wakeStartIndex,
      `the grandchild's ${label} is stored before the root wakes`,
    );
  }

  const wakeMessage = projection.messages.find(
    (message) => message.id === projection.runs[1]?.userMessageId,
  );
  assert.equal(wakeMessage?.text, "CHILD_DONE", "the child's end opens the wake");
  if (child.childThreadId === null) {
    throw new Error("The child subagent is missing its child thread.");
  }
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: `Subagent "${child.title}" finished`,
      outcome: "completed",
      source: { kind: "subagent", childThreadId: child.childThreadId },
    },
  ]);
}
