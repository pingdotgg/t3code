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

function acpFrame(entry: ProviderReplayTranscript["entries"][number]) {
  return entry.type === "runtime_exit"
    ? undefined
    : (entry.frame as {
        readonly method?: string;
        readonly params?: { readonly update?: { sessionUpdate?: string; status?: string } };
      });
}

/** fx 0.0.15 answers Stop by failing the running command itself; T3 still shows it interrupted. */
export function assertTurnInterruptMidToolFxOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const cancelIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && acpFrame(entry)?.method === "session/cancel",
  );
  const failedAfterCancel = transcript.entries.findIndex(
    (entry, index) =>
      index > cancelIndex &&
      entry.type === "emit_inbound" &&
      acpFrame(entry)?.params?.update?.sessionUpdate === "tool_call_update" &&
      acpFrame(entry)?.params?.update?.status === "failed",
  );
  assert.isAtLeast(cancelIndex, 0);
  assert.isAbove(failedAfterCancel, cancelIndex, "fx fails the cut-off command after Stop");
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
  assert.equal(commandItem.status, "interrupted");
  assert.equal(
    projection.turnItems.find((item) => item.type === "run_interrupt_result")?.status,
    "interrupted",
  );
  assert.equal(projection.providerTurns[0]?.status, "interrupted");
  assert.equal(projection.providerThreads[0]?.status, "idle");
}
