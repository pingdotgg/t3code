import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2SubagentBackgroundWakeOutput(
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
  assertRunOrdinals(projection, [1, 2]);
  assertAssistantTextIncludes(projection, "PARENT_RELEASED");
  assertAssistantTextIncludes(projection, "CHILD_BACKGROUND_OK");
  assert.notInclude(JSON.stringify(projection), "CHILD_CANCELLED_SHOULD_NOT_CONTINUE");

  const subagentItem = projection.turnItems.find((candidate) => candidate.type === "subagent");
  assert.strictEqual(subagentItem?.type, "subagent");
  if (subagentItem?.type !== "subagent") {
    throw new Error("OpenCode 2 background subagent item is missing");
  }
  assert.strictEqual(subagentItem.status, "completed");
  assert.isNotNull(subagentItem.childThreadId);
  const child = result.projections.get(subagentItem.childThreadId!);
  assert.isDefined(child);
  assertAssistantTextIncludes(child!, "CHILD_BACKGROUND_OK");

  const continuation = projection.runs[1];
  assert.isDefined(continuation);
  const continuationItems = projection.turnItems.filter(
    (item) => item.runId === continuation!.id && item.type === "assistant_message",
  );
  assert.lengthOf(continuationItems, 1);
}
