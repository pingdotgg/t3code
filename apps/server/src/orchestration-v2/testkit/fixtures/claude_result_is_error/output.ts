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
const AUTH_FAILURE_TEXT =
  "Claude could not authenticate. For subscription login, run `claude auth login` on this environment's machine, then send the message again. For API-key authentication, check this instance's configured credentials.";

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
  assert.equal(errorItem.failure.message, AUTH_FAILURE_TEXT);
  assert.equal(errorItem.failure.code, "api_error_401");
  assert.equal(errorItem.failure.class, "provider_error");

  const run1AssistantTexts = projection.turnItems.flatMap((item) =>
    item.runId === failedRun?.id && item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(run1AssistantTexts, [AUTH_ERROR_TEXT]);

  const recoveredRun = projection.runs.find((run) => run.ordinal === 2);
  assert.isDefined(recoveredRun);
  assert.equal(recoveredRun?.status, "completed");
  const recoveredTexts = projection.turnItems.flatMap((item) =>
    item.runId === recoveredRun?.id && item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(recoveredTexts, ["claude result is_error fixture recovered"]);
}
