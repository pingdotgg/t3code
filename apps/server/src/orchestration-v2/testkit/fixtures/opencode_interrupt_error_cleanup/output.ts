import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypeSequence,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../shared.ts";

export function assertOpenCodeInterruptErrorCleanupOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypeSequence(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_MID_TOOL_PROMPT]);

  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(commandItem);
  if (commandItem.type !== "command_execution") throw new Error("expected command item");
  assert.equal(commandItem.status, "completed");
  assert.equal(commandItem.output, "authoritative cleanup result");
  assert.equal(commandItem.exitCode, 0);

  const interruptRequest = projection.turnItems.find(
    (item) => item.type === "run_interrupt_request",
  );
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.isDefined(interruptRequest);
  assert.isDefined(interruptResult);
  assert.equal(interruptRequest.status, "completed");
  assert.equal(interruptResult.status, "interrupted");
  assert.equal(interruptResult.parentItemId, interruptRequest.id);

  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
