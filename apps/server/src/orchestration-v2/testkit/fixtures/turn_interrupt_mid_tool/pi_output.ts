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

function frameType(frame: unknown): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, "type") : undefined;
}

/**
 * User Stop while Pi runs a bash tool. The adapter aborts first, so Pi ends
 * the tool as an error and settles, then the adapter terminates the process
 * (Stop-with-restart) because it cannot trust abort to have landed.
 */
export function assertTurnInterruptMidToolPiOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const toolStartIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && frameType(entry.frame) === "tool_execution_start",
  );
  const abortIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && frameType(entry.frame) === "abort",
  );
  assert.isAtLeast(toolStartIndex, 0, "Pi must record the bash tool starting");
  assert.isAbove(abortIndex, toolStartIndex, "Stop must abort after the tool started");

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
  // Pi reports the aborted tool as an error; a Stop presents it as interrupted.
  assert.equal(commandItem.status, "interrupted");
  const interruptResult = projection.turnItems.find((item) => item.type === "run_interrupt_result");
  assert.equal(interruptResult?.status, "interrupted");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted"],
  );
  assert.deepEqual(
    projection.providerSessions.map((session) => [session.status, session.lastError]),
    [["stopped", null]],
    "Stop-with-restart retires the Pi process without reporting an error",
  );
}
