import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  SIMPLE_PROMPT,
  TURN_INTERRUPT_PROMPT,
} from "../shared.ts";

export function assertFxEarlyStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["interrupted", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_PROMPT, SIMPLE_PROMPT]);
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted", "completed"],
  );
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.equal(projection.providerThreads.length, 1, "the follow-up must not open a second thread");
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
  assert.equal(projection.providerTurns[1]?.status, "completed");
  assert.equal(
    projection.providerTurns[0]?.providerThreadId,
    projection.providerTurns[1]?.providerThreadId,
    "the follow-up must reuse the fx session",
  );
}
