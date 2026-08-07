import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2QuestionLegacyOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertAllRuntimeRequestsResolved(projection);
  const requestItem = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.strictEqual(requestItem?.type, "user_input_request");
  if (requestItem?.type !== "user_input_request") {
    throw new Error("OpenCode 2 question request item is missing");
  }
  assert.strictEqual(requestItem.questions[0]?.id, "question-0-schema-vs-flexibility");
  assert.strictEqual(requestItem.status, "completed");
  assertAssistantTextIncludes(projection, "plan questions fixture complete");
}
