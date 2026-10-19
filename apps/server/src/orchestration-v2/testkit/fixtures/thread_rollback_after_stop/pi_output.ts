import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertVisibleUserMessagesExclude,
  assertVisibleUserMessagesInclude,
  projectionFor,
  THREAD_ROLLBACK_AFTER_PROMPT,
  THREAD_ROLLBACK_FIRST_PROMPT,
  THREAD_ROLLBACK_SECOND_PROMPT,
  TURN_INTERRUPT_MID_TOOL_PROMPT,
} from "../shared.ts";

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function outboundOfType(transcript: ProviderReplayTranscript, type: string) {
  return transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" && field(entry.frame, "type") === type ? [entry.frame] : [],
  );
}

/**
 * Stop terminates Pi (Stop-with-restart), so the stopped turn's session-tree
 * user entry has to be read before the kill.
 */
export function assertPiThreadRollbackAfterStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 4 });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1, 2, 3, 4]);
  const runStatus = (ordinal: number) =>
    projection.runs.find((run) => run.ordinal === ordinal)?.status;
  assert.equal(runStatus(1), "completed");
  assert.equal(runStatus(2), "rolled_back");
  assert.equal(runStatus(3), "rolled_back");
  assert.equal(runStatus(4), "completed");

  const stoppedTurn = projection.providerTurns.find((providerTurn) => providerTurn.ordinal === 2);
  assert.equal(stoppedTurn?.status, "interrupted");
  assert.equal(stoppedTurn?.nativeTurnRef?.strength, "strong");

  const stopIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && field(entry.frame, "type") === "abort",
  );
  const captureIndex = transcript.entries.findIndex(
    (entry, index) =>
      index > stopIndex &&
      entry.type === "expect_outbound" &&
      field(entry.frame, "type") === "get_entries",
  );
  assert.isAbove(captureIndex, stopIndex, "Stop must read the session tree before terminating Pi");

  const forks = outboundOfType(transcript, "fork");
  assert.lengthOf(forks, 1, "rollback must fork the Pi session tree exactly once");
  assert.equal(field(forks[0], "entryId"), stoppedTurn?.nativeTurnRef?.nativeId);

  assertVisibleUserMessagesInclude(projection, [
    THREAD_ROLLBACK_FIRST_PROMPT,
    THREAD_ROLLBACK_AFTER_PROMPT,
  ]);
  assertVisibleUserMessagesExclude(projection, [
    TURN_INTERRUPT_MID_TOOL_PROMPT,
    THREAD_ROLLBACK_SECOND_PROMPT,
  ]);

  const finalAnswer = projection.turnItems.findLast((item) => item.type === "assistant_message");
  assert.include(finalAnswer?.text, "rollback fixture first turn complete");
  assert.notInclude(finalAnswer?.text, "second turn");
  assert.notInclude(finalAnswer?.text, "interrupt fixture");
}
