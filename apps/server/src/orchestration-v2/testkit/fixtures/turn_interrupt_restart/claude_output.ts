import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_RECOVERY_PROMPT,
} from "../shared.ts";

function isReplayFrameWithType(
  frame: unknown,
  type: string,
): frame is { readonly type: string; readonly options?: Record<string, unknown> } {
  return (
    typeof frame === "object" &&
    frame !== null &&
    "type" in frame &&
    (frame as { readonly type?: unknown }).type === type
  );
}

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

export function assertTurnInterruptRestartClaudeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "claudeAgent");
  assertClaudeInterruptAfterToolUse(transcript);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["interrupted", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "user", "assistant"]);
  assertTurnItemTypes(projection, [
    "user_message",
    "command_execution",
    "run_interrupt_request",
    "run_interrupt_result",
    "assistant_message",
  ]);
  assertUserMessagesInclude(projection, [
    TURN_INTERRUPT_MID_TOOL_PROMPT,
    TURN_INTERRUPT_RECOVERY_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, "interrupt recovery fixture complete");
  assert.deepEqual(
    projection.attempts.map((attempt) => attempt.status),
    ["interrupted", "completed"],
  );
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted", "completed"],
  );
  assert.equal(projection.providerThreads[0]?.status, "idle");
  const commandItem = projection.turnItems.find((item) => item.type === "command_execution");
  assert.isDefined(commandItem);
  assert.equal(commandItem.status, "failed");
  assert.include(commandItem.input, "node -e");

  const outboundFrames = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  const queryOpenFrames = outboundFrames.filter((frame) =>
    isReplayFrameWithType(frame, "query.open"),
  );
  const interruptFrames = outboundFrames.filter((frame) =>
    isReplayFrameWithType(frame, "query.interrupt"),
  );
  assert.lengthOf(queryOpenFrames, 2);
  assert.isString(queryOpenFrames[1]?.options?.resume);
  assert.lengthOf(interruptFrames, 1);
}
