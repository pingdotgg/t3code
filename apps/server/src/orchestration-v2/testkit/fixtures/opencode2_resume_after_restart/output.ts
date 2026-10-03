import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_RESTART_PROMPT,
  OPENCODE2_RESTART_RECALL_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * The server stops mid-command and its event stream ends with no execution
 * end. T3 reconnects to the restarted server, finds the session idle with no
 * outcome, backfills the shell call the history shows cancelled, and ends the
 * turn as interrupted. The next turn runs on the same session.
 */
export function assertOpenCode2ResumeAfterRestartOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["interrupted", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [
    OPENCODE2_RESTART_PROMPT,
    OPENCODE2_RESTART_RECALL_PROMPT,
  ]);
  const [first, second] = projection.runs;
  // The orphaned shell call ends as the history recorded it, not left running.
  const shell = projection.turnItems.find(
    (item) => item.type === "command_execution" && item.runId === first?.id,
  );
  assert.deepInclude(shell, { status: "failed", input: "sleep 25 && echo RESUMED" });
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted", "completed"],
  );
  const reply = projection.turnItems.find(
    (item) => item.type === "assistant_message" && item.runId === second?.id,
  );
  assert.include(reply?.type === "assistant_message" ? reply.text : "", "sleep 25");
  assert.lengthOf(projection.providerThreads, 1);
}
