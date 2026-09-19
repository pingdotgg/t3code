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

function frameParams(frame: unknown): Record<string, unknown> | undefined {
  if (typeof frame !== "object" || frame === null || !("params" in frame)) {
    return undefined;
  }
  const params = (frame as { readonly params?: unknown }).params;
  return typeof params === "object" && params !== null
    ? (params as Record<string, unknown>)
    : undefined;
}

function assertCodexInterruptAfterCommandExecution(transcript: ProviderReplayTranscript) {
  const commandIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && isCommandExecutionStartedFrame(entry.frame),
  );
  const interruptIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && protocolMethod(entry.frame) === "turn/interrupt",
  );
  const completedIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && protocolMethod(entry.frame) === "turn/completed",
  );
  const terminateIndex = transcript.entries.findIndex(
    (entry) =>
      entry.type === "expect_outbound" &&
      protocolMethod(entry.frame) === "thread/backgroundTerminals/terminate",
  );
  assert.isAtLeast(commandIndex, 0, "Codex interrupt fixture must record command execution start");
  assert.isAbove(
    interruptIndex,
    commandIndex,
    "Codex interrupt must be issued after command execution starts in replay",
  );
  assert.isAtLeast(
    completedIndex,
    0,
    "Codex interrupt fixture must record turn/completed before terminal cleanup",
  );
  assert.isAtLeast(
    terminateIndex,
    0,
    "Codex interrupt fixture must record background terminal terminate",
  );
  assert.isAbove(
    terminateIndex,
    completedIndex,
    "This recorded Codex interrupt fixture terminates background terminals after turn/completed",
  );
  const terminateEntry = transcript.entries[terminateIndex];
  const terminateParams =
    terminateEntry?.type === "expect_outbound" ? frameParams(terminateEntry.frame) : undefined;
  assert.equal(terminateParams?.threadId, "019e03b8-9e5c-7b32-88ab-f742a29b75b8");
  assert.equal(terminateParams?.processId, "4275");
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
  // Interrupted Codex turns must terminalize mid-flight commandExecution items so
  // the projected card is never left running forever after turn.terminal.
  assert.equal(commandItem.status, "interrupted");
  assert.isNotNull(commandItem.completedAt);
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

  const runningCommands = projection.turnItems.filter(
    (item) => item.type === "command_execution" && item.status === "running",
  );
  assert.lengthOf(runningCommands, 0, "interrupted turn must not leave running command items");

  const toolNodes = projection.nodes.filter((node) => node.kind === "tool_call");
  for (const node of toolNodes) {
    assert.notEqual(node.status, "running", "interrupted turn tool nodes must be terminal");
    assert.isNotNull(node.completedAt);
  }
}
