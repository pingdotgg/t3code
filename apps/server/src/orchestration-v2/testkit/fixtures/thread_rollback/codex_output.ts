import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";

export function assertThreadRollbackOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "rolled_back", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2, 3]);
  assertTurnItemTypes(projection, ["user_message", "assistant_message", "checkpoint"]);
  assertUserMessagesInclude(projection, [
    "Respond with exactly: rollback fixture first turn complete",
    "Respond with exactly: rollback fixture second turn complete",
    "Repeat the conversation verbatim.",
  ]);
  assert.isAtLeast(projection.checkpoints.length, 2);
  assert.isTrue(
    projection.runs.some((run) => run.status === "rolled_back"),
    "rollback must be visible in run state",
  );
}
