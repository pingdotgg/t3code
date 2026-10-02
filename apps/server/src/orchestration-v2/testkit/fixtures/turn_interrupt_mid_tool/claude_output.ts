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
  return typeof frame === "object" && frame !== null && "type" in frame
    ? (frame as { readonly type?: string }).type
    : undefined;
}

function assistantHasToolUse(frame: unknown): boolean {
  if (frameType(frame) !== "assistant") {
    return false;
  }
  const message = (frame as { readonly message?: unknown }).message;
  const content =
    typeof message === "object" && message !== null && "content" in message
      ? (message as { readonly content?: unknown }).content
      : undefined;
  return (
    Array.isArray(content) &&
    content.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "type" in part &&
        (part as { readonly type?: string }).type === "tool_use",
    )
  );
}

function assertClaudeInterruptAfterToolUse(transcript: ProviderReplayTranscript) {
  const toolUseIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && assistantHasToolUse(entry.frame),
  );
  const interruptIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && frameType(entry.frame) === "query.interrupt",
  );
  assert.isAtLeast(toolUseIndex, 0, "Claude interrupt fixture must record a started tool use");
  assert.isAbove(
    interruptIndex,
    toolUseIndex,
    "Claude interrupt must be issued after the replayed tool use starts",
  );
}

export function assertTurnInterruptMidToolClaudeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "claudeAgent");
  assertClaudeInterruptAfterToolUse(transcript);
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
  assert.equal(commandItem.status, "failed");
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
