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

// The grandchild ends while the root is idle, but Claude reports that end to
// the child that started it. Only the child's end wakes the root, so it alone
// opens run 2 and names the wake.
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

  // The child starts the grandchild while the root is idle. Both its row and
  // its thread are stored then, not when the child's end wakes the root.
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
  assert.isBelow(
    grandchildRowIndex,
    wakeStartIndex,
    "the grandchild's row is stored before the root wakes",
  );
  const grandchildThreadIndex = result.domainEvents.findIndex(
    (event) => event.type === "thread.created" && event.payload.id === grandchild.childThreadId,
  );
  assert.isAtLeast(grandchildThreadIndex, 0, "the grandchild's thread is stored");
  assert.isBelow(
    grandchildThreadIndex,
    wakeStartIndex,
    "the grandchild's thread is stored before the root wakes",
  );
  assert.isBelow(
    result.domainEvents.findIndex(
      (event) =>
        event.type === "subagent.updated" &&
        event.payload.id === grandchild.id &&
        event.payload.status === "completed",
    ),
    wakeStartIndex,
    "the grandchild's end is stored before the root wakes",
  );

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
