import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../shared.ts";

function frameType(frame: unknown): string | undefined {
  return typeof frame === "object" && frame !== null
    ? (Reflect.get(frame, "type") as string | undefined)
    : undefined;
}

function cursorUpdateType(frame: unknown): string | undefined {
  if (frameType(frame) !== "interaction.update") {
    return undefined;
  }
  const update = Reflect.get(frame as object, "update");
  return typeof update === "object" && update !== null
    ? (Reflect.get(update, "type") as string | undefined)
    : undefined;
}

export function assertTurnInterruptMidToolCursorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const toolStartedIndex = transcript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && cursorUpdateType(entry.frame) === "tool-call-started",
  );
  const cancelIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && frameType(entry.frame) === "run.cancel",
  );
  assert.isAtLeast(toolStartedIndex, 0);
  assert.isAbove(cancelIndex, toolStartedIndex);
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
  ]);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_MID_TOOL_PROMPT]);

  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  const interruptRequest = projection.turnItems.find(
    (item) => item.type === "run_interrupt_request",
  );
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.isDefined(commandItem);
  assert.isDefined(interruptRequest);
  assert.isDefined(interruptResult);
  assert.include(commandItem.input, "node -e");
  assert.equal(interruptRequest.status, "completed");
  assert.equal(interruptResult.status, "interrupted");
  assert.equal(interruptResult.parentItemId, interruptRequest.id);
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted"],
  );
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
