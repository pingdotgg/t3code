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

function eventType(frame: unknown): string | undefined {
  if (frameType(frame) !== "sdk.event") return undefined;
  const event = Reflect.get(frame as object, "event");
  return typeof event === "object" && event !== null
    ? (Reflect.get(event, "type") as string | undefined)
    : undefined;
}

/**
 * OpenCode reports no final state for a tool aborted mid-flight, so the adapter
 * has to close it itself when the turn ends underneath it. Without that sweep
 * the `command_execution` item keeps its last observed `running` status forever
 * and the row spins in the UI on a run the user deliberately stopped.
 *
 * The transcript reproduces the ordering seen in a real run: `session.error`
 * and idle arrive first, and OpenCode's cleanup emits its own tool part update
 * afterwards. That late update lands on an already-finalized turn, so it is
 * ignored; the item's status must come from the sweep, not from it.
 */
export function assertTurnInterruptMidToolOpenCodeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const toolRunningIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "message.part.updated.tool.running",
  );
  const abortIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && frameType(entry.frame) === "session.abort",
  );
  const lateToolIndex = transcript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && entry.label === "message.part.updated.tool.cleanup.late",
  );
  const errorIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && eventType(entry.frame) === "session.error",
  );

  // The shape this fixture exists to pin: tool running, abort, error, and only
  // then the provider's own late word on the tool.
  assert.isAtLeast(toolRunningIndex, 0);
  assert.isAbove(abortIndex, toolRunningIndex);
  assert.isAbove(errorIndex, abortIndex);
  assert.isAbove(lateToolIndex, errorIndex);

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
  assert.isDefined(commandItem);
  assert.include(commandItem.input, "node -e");

  // The regression: without the sweep this stays `running`.
  assert.equal(commandItem.status, "interrupted");
  assert.isNotNull(commandItem.completedAt);

  const interruptRequest = projection.turnItems.find(
    (item) => item.type === "run_interrupt_request",
  );
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.isDefined(interruptRequest);
  assert.isDefined(interruptResult);
  assert.equal(interruptRequest.status, "completed");
  assert.equal(interruptResult.status, "interrupted");
  assert.equal(interruptResult.parentItemId, interruptRequest.id);

  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted"],
  );
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
