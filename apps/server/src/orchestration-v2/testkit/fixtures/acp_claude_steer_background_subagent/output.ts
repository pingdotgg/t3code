import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

/** The messages and tool statuses of a subagent's child thread, in order. */
function childThreadLines(
  result: OrchestratorV2ScenarioResult,
  childThreadId: string | null | undefined,
) {
  const child = childThreadId == null ? undefined : result.projections.get(childThreadId as never);
  return child?.turnItems.flatMap((item) =>
    item.type === "assistant_message" || item.type === "user_message"
      ? [`${item.type}:${item.text}`]
      : item.type === "dynamic_tool"
        ? [`${item.type}:${item.status}`]
        : [],
  );
}

// The steer cancels the foreground and starts the next prompt in the same
// run; the background subagent keeps working, its output shows in its child
// thread, and its end clears the run's Waiting.
export function assertAcpClaudeSteerBackgroundSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    providerTurnCountAtLeast: 2,
    runStatuses: ["completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["completed"],
  );
  assert.deepEqual(childThreadLines(result, projection.subagents[0]?.childThreadId), [
    "user_message:Find the flaky test.",
    "assistant_message:Still looking.",
    "assistant_message:CHILD_AFTER_STEER",
  ]);
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
}
