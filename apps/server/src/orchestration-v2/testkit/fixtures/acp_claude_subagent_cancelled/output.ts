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

// The child is cancelled with a tool still open: the tool ends with it.
export function assertAcpClaudeSubagentCancelledOutput(
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
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["cancelled"],
  );
  assert.deepEqual(childThreadLines(result, projection.subagents[0]?.childThreadId), [
    "user_message:Sleep for a second, then reply SUBAGENT_DONE.",
    "assistant_message:Sleeping before I report.",
    "dynamic_tool:completed",
    "dynamic_tool:interrupted",
    "assistant_message:SUBAGENT_DONE",
  ]);
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
}
