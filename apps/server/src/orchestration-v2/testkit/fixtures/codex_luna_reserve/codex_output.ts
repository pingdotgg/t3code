import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { LUNA_RESERVE_MODEL_SELECTION, LUNA_RESERVE_PROMPTS } from "./input.ts";

export function assertCodexLunaReserveOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  // The replay itself pins the wire models: gpt-6-luna, gpt-6-luna, gpt-reserve, gpt-6-luna.
  assertBaseProjection({
    result,
    transcript,
    runCount: 4,
    runStatuses: ["completed", "failed", "completed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, LUNA_RESERVE_PROMPTS);
  assertAssistantTextIncludes(projection, "luna reserve turn complete");
  assertAssistantTextIncludes(projection, "recovered quota turn complete");
  assert.equal(
    projection.turnItems.find((item) => item.type === "error")?.failure.class,
    "usage_limit",
  );
  // Reserve is a wire detail: the thread and every run keep the user's Luna selection.
  assert.deepEqual(projection.thread.modelSelection, LUNA_RESERVE_MODEL_SELECTION);
  for (const run of projection.runs) {
    assert.deepEqual(run.modelSelection, LUNA_RESERVE_MODEL_SELECTION);
  }
}
