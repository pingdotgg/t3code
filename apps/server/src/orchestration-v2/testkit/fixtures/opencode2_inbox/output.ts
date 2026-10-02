import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_CANCELLED_PROMPT,
  OPENCODE2_QUEUED_PROMPT,
  OPENCODE2_STEER_PROMPT,
  OPENCODE2_STEER_TEXT,
  projectionFor,
} from "../shared.ts";

/**
 * The steer goes out as `delivery: "steer"` into the running turn, which the
 * shell call's step boundary delivers: one provider turn answers both, and it
 * ends with its execution. T3 keeps the queue, so the queued message is a
 * second turn and the cancelled one never reaches OpenCode.
 */
export function assertOpenCode2InboxOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    // The cancelled run never started a provider turn.
    providerTurnCountAtLeast: 2,
    runStatuses: ["completed", "completed", "cancelled"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [
    OPENCODE2_STEER_PROMPT,
    OPENCODE2_STEER_TEXT,
    OPENCODE2_QUEUED_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer", "queued_turn"]);
  assertAssistantTextIncludes(projection, "STEERED");
  assertAssistantTextIncludes(projection, "QUEUED_B");
  assert.notInclude(
    projection.turnItems.flatMap((item) => (item.type === "user_message" ? [item.text] : [])),
    OPENCODE2_CANCELLED_PROMPT,
  );

  // The steer joined the first run's turn; the queued message got its own.
  const [first, queued] = projection.runs.toSorted((left, right) => left.ordinal - right.ordinal);
  const turnOf = (run: typeof first) =>
    projection.providerTurns.filter((turn) => turn.runAttemptId === run?.activeAttemptId);
  assert.deepEqual(
    [turnOf(first).map((turn) => turn.status), turnOf(queued).map((turn) => turn.status)],
    [["completed"], ["completed"]],
  );
  const steered = projection.turnItems.find(
    (item) => item.type === "assistant_message" && item.text.includes("STEERED"),
  );
  assert.equal(steered?.runId, first?.id);
  const shell = projection.turnItems.find((item) => item.type === "command_execution");
  assert.deepEqual([shell?.status, shell?.runId], ["completed", first?.id]);

  // Each turn remembers the user message it prompted with: fork and rollback cut there.
  for (const turn of [...turnOf(first), ...turnOf(queued)]) {
    assert.match(turn.nativeTurnRef?.nativeId ?? "", /^msg_t3_turn_/);
  }
}
