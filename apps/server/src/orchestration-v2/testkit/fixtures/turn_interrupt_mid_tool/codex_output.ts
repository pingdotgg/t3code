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

function protocolMethod(frame: unknown): string | undefined {
  return typeof frame === "object" && frame !== null && "method" in frame
    ? (frame as { readonly method?: string }).method
    : undefined;
}

function isCommandExecutionStartedFrame(frame: unknown): boolean {
  if (protocolMethod(frame) !== "item/started") {
    return false;
  }
  const params =
    typeof frame === "object" && frame !== null && "params" in frame
      ? (frame as { readonly params?: unknown }).params
      : undefined;
  const item =
    typeof params === "object" && params !== null && "item" in params
      ? (params as { readonly item?: unknown }).item
      : undefined;
  return (
    typeof item === "object" &&
    item !== null &&
    "type" in item &&
    (item as { readonly type?: string }).type === "commandExecution"
  );
}

function assertCodexInterruptAfterCommandExecution(transcript: ProviderReplayTranscript) {
  const commandIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && isCommandExecutionStartedFrame(entry.frame),
  );
  const interruptIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && protocolMethod(entry.frame) === "turn/interrupt",
  );
  assert.isAtLeast(commandIndex, 0, "Codex interrupt fixture must record command execution start");
  assert.isAbove(
    interruptIndex,
    commandIndex,
    "Codex interrupt must be issued after command execution starts in replay",
  );
}

export function assertTurnInterruptMidToolCodexOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "codex");
  assertCodexInterruptAfterCommandExecution(transcript);
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
  assert.include(["running", "completed", "failed"], commandItem.status);
  assert.include(commandItem.input, "node -e");
  assert.equal(interruptRequest.status, "completed");
  assert.equal(interruptResult.status, "interrupted");
  assert.equal(interruptResult.parentItemId, interruptRequest.id);
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted"],
  );
  assert.equal(projection.providerThreads[0]?.status, "idle");
  assert.include(["interrupted", "cancelled"], projection.providerTurns[0]?.status);
}
