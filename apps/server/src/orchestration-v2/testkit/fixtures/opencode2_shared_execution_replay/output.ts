import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

const SHARED_OUTPUT = "SHARED_EXECUTION_OUTPUT";

export function assertOpenCode2SharedExecutionReplayOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assertAssistantTextIncludes(projection, SHARED_OUTPUT);

  const sharedItems = projection.turnItems.filter(
    (item) => item.type === "assistant_message" && item.text.includes(SHARED_OUTPUT),
  );
  assert.lengthOf(sharedItems, 1);
  assert.equal(sharedItems[0]?.runId, projection.runs[1]?.id);
  assert.isFalse(
    projection.turnItems.some(
      (item) => item.runId === projection.runs[2]?.id && item.type === "assistant_message",
    ),
  );
}
