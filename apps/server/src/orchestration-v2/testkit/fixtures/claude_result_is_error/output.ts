import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  CLAUDE_RESULT_IS_ERROR_FOLLOW_UP,
  CLAUDE_RESULT_IS_ERROR_PROMPT,
  projectionFor,
} from "../shared.ts";

const AUTH_ERROR_TEXT = "Failed to authenticate. API Error: 401 Invalid authentication credentials";

export function assertClaudeResultIsErrorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["failed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    CLAUDE_RESULT_IS_ERROR_PROMPT,
    CLAUDE_RESULT_IS_ERROR_FOLLOW_UP,
  ]);

  // Run 1 ended with subtype "success" + is_error: the run and its provider
  // turn must be failed, and the failure must preserve the API error verbatim
  // (message + status code), not a generic wrapper string.
  const failedRun = projection.runs.find((run) => run.ordinal === 1);
  assert.isDefined(failedRun);
  assert.equal(failedRun?.status, "failed");
  const failedTurn = projection.providerTurns.find(
    (turn) => turn.status !== "completed" && turn.status !== "running",
  );
  assert.equal(failedTurn?.status, "failed");

  const errorItem = projection.turnItems.find(
    (item) => item.runId === failedRun?.id && item.type === "error",
  );
  assert.isDefined(errorItem);
  if (errorItem?.type !== "error") throw new Error("expected error item");
  assert.equal(errorItem.failure.message, AUTH_ERROR_TEXT);
  assert.equal(errorItem.failure.code, "api_error_401");
  assert.equal(errorItem.failure.class, "provider_error");

  // The SDK's synthetic assistant message still surfaces as ordinary
  // assistant text (that is what the stream contained), but the error text
  // must not be duplicated a second time via the result-text fallback.
  const run1AssistantTexts = projection.turnItems.flatMap((item) =>
    item.runId === failedRun?.id && item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(run1AssistantTexts, [AUTH_ERROR_TEXT]);

  // The failed turn must not poison the thread: the follow-up run reuses the
  // same open query and completes.
  const recoveredRun = projection.runs.find((run) => run.ordinal === 2);
  assert.isDefined(recoveredRun);
  assert.equal(recoveredRun?.status, "completed");
  const recoveredTexts = projection.turnItems.flatMap((item) =>
    item.runId === recoveredRun?.id && item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(recoveredTexts, ["claude result is_error fixture recovered"]);
}
