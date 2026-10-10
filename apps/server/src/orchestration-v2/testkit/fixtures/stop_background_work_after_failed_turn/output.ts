import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT } from "./input.ts";

// The adapter has no per-thread pending-work probe, so Stop used to stop at
// the control service and the thread kept showing the command forever.
export function assertStopBackgroundWorkAfterFailedTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [STOP_BACKGROUND_WORK_AFTER_FAILED_TURN_PROMPT]);

  const before = result.capturedShellSnapshots
    .get("before-stop")
    ?.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(
    before?.pendingBackgroundTasks?.map((task) => task.kind),
    ["command"],
    "the failed turn leaves its command on the Waiting strip",
  );

  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.equal(command?.status, "interrupted");
  assert.isNotNull(command?.completedAt);
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
  // Stop records the request, and never rewrites how the turn itself ended.
  assert.include(
    projection.turnItems.map((item) => item.type),
    "run_interrupt_request",
  );
  assert.equal(projection.runs[0]?.status, "failed");
}
