import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { GROK_PROMPT_ERROR_FOLLOW_UP, GROK_PROMPT_ERROR_PROMPT } from "./input.ts";

const GROK_PROMPT_ERROR_TEXT =
  "API error (status 400 Bad Request): invalid_request_error: grok prompt error fixture";

export function assertGrokPromptErrorOutput(
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
  assertUserMessagesInclude(projection, [GROK_PROMPT_ERROR_PROMPT, GROK_PROMPT_ERROR_FOLLOW_UP]);

  // The failed run shows Grok's own API error instead of an empty completion.
  const failedRun = projection.runs.find((run) => run.ordinal === 1);
  const errorItem = projection.turnItems.find(
    (item) => item.runId === failedRun?.id && item.type === "error",
  );
  if (errorItem?.type !== "error") throw new Error("expected an error item on the failed run");
  assert.equal(errorItem.failure.message, GROK_PROMPT_ERROR_TEXT);
  assert.equal(errorItem.failure.class, "provider_error");

  // The error does not poison the session: the follow-up reaches the model.
  const recoveredRun = projection.runs.find((run) => run.ordinal === 2);
  const recoveredTexts = projection.turnItems.flatMap((item) =>
    item.runId === recoveredRun?.id && item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(recoveredTexts, ["grok prompt error fixture recovered"]);
}
