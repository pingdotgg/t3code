import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

/** A child-thread tool item's native tool call id (`<row>:tool:<id>`). */
const toolCallId = (nativeId: string | null | undefined) => nativeId?.split(":tool:")[1];

// A subagent's two background helpers each have a tool open when the first
// ends failed (or cancelled). Only that helper's tool ends with it: the
// second's tool runs on and completes, and so does the subagent.
export function assertAcpClaudeNestedSubagentFailedOutput(
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
  const childThreadId = projection.subagents[0]?.childThreadId;
  const child = childThreadId == null ? undefined : result.projections.get(childThreadId);
  assert.deepEqual(
    child?.turnItems.flatMap((item) =>
      item.type === "assistant_message" || item.type === "user_message"
        ? [`${item.type}:${item.text}`]
        : item.type === "dynamic_tool"
          ? [`${toolCallId(item.nativeItemRef?.nativeId)}:${item.status}`]
          : [],
    ),
    [
      "user_message:Review the change.",
      "assistant_message:Starting a helper.",
      "toolu_nested_1:completed",
      "toolu_nested_2:completed",
      "assistant_message:Review done.",
      "toolu_gc_read:interrupted",
      "toolu_gc_grep:completed",
      "assistant_message:SIBLING_TESTS_OK",
    ],
  );
  // The second helper's tool was never interrupted on the way.
  assert.deepEqual(
    result.domainEvents.flatMap((event) =>
      event.type === "turn-item.updated" &&
      event.payload.type === "dynamic_tool" &&
      toolCallId(event.payload.nativeItemRef?.nativeId) === "toolu_gc_grep"
        ? [event.payload.status]
        : [],
    ),
    ["running", "completed"],
  );
}
