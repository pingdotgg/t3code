import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  OPENCODE2_UNKNOWN_FINISH_IDLE_PROMPT,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2UnknownFinishIdleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [OPENCODE2_UNKNOWN_FINISH_IDLE_PROMPT]);
  const errorItem = projection.turnItems.find((item) => item.type === "error");
  assert.strictEqual(errorItem?.type, "error");
  if (errorItem?.type !== "error")
    throw new Error("OpenCode 2 unknown-finish idle item is missing");
  assert.strictEqual(errorItem.status, "failed");
  assert.strictEqual(errorItem.failure.code, "provider.invalid-output");
  assert.strictEqual(
    errorItem.failure.message,
    "OpenCode 2 ended a model step with an unknown finish reason.",
  );
  assert.strictEqual(errorItem.failure.retryable, true);
}
