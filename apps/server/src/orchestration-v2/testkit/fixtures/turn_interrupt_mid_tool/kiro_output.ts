import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../shared.ts";
import { kiroFailedAfterCancel } from "../kiro_subagent_interrupt/output.ts";

/** Tool call ids Kiro reported `in_progress` before T3's `session/cancel`. */
function kiroRunningBeforeCancel(transcript: ProviderReplayTranscript): Set<string> {
  const cancelIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "notification:session/cancel",
  );
  return new Set(
    transcript.entries.slice(0, Math.max(cancelIndex, 0)).flatMap((entry) => {
      if (entry.type !== "emit_inbound") return [];
      const update = Reflect.get(Object(Reflect.get(Object(entry.frame), "params")), "update");
      return Reflect.get(Object(update), "status") === "in_progress"
        ? [String(Reflect.get(Object(update), "toolCallId"))]
        : [];
    }),
  );
}

/** Stop reaches Kiro while its command runs; Kiro fails it and T3 shows it interrupted. */
export function assertTurnInterruptMidToolKiroOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const running = kiroRunningBeforeCancel(transcript);
  assert.isTrue(
    kiroFailedAfterCancel(transcript).some((id) => running.has(id)),
    "Kiro must fail, after the cancel, a command that was already running",
  );
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
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
  assert.equal(commandItem.status, "interrupted");
  assert.isFalse(projection.turnItems.some((item) => item.status === "failed"));
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
}
