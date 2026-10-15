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

// The subagent's own idle comes while the subagent it started in the
// background still works. The subagent stays running until that work ended,
// so its run keeps showing the nested tool and reply; then it completes.
export function assertAcpClaudeNestedBackgroundSubagentOutput(
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
    ["completed"],
  );
  assert.deepEqual(childThreadLines(result, projection.subagents[0]?.childThreadId), [
    "user_message:Review the change.",
    "assistant_message:Starting a helper.",
    "dynamic_tool:completed",
    "assistant_message:Review done.",
    "dynamic_tool:completed",
    "assistant_message:NESTED_DOCS_OK",
  ]);
  assert.isFalse(projection.messages.some((message) => message.text.includes("NESTED_DOCS_OK")));
}
