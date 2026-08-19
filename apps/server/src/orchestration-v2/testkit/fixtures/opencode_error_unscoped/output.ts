import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypeSequence,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE_ERROR_CLEANUP_DRAIN_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCodeErrorUnscopedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypeSequence(projection, ["user_message", "command_execution", "error"]);
  assertUserMessagesInclude(projection, [OPENCODE_ERROR_CLEANUP_DRAIN_PROMPT]);

  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(commandItem);
  assert.equal(commandItem.status, "failed");

  const errorItem = projection.turnItems.find((item) => item.type === "error");
  assert.isDefined(errorItem);
  if (errorItem.type !== "error") throw new Error("expected error item");
  assert.equal(errorItem.failure.message, "fixture unscoped failure");
  assert.equal(errorItem.failure.code, "FixtureTransportError");
}
