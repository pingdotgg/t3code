import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertBaseProjection, projectionFor } from "../shared.ts";
import { ACTIVE_RUN_SHELL_SNAPSHOT_KEY } from "./input.ts";

export function assertQueuedCancelledWhileActiveOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "cancelled"],
    providerTurnCountAtLeast: 1,
  });

  const projection = projectionFor(result, transcript.scenario);
  const activeRun = projection.runs[0];
  const cancelledRun = projection.runs[1];
  assert.isDefined(activeRun);
  assert.isDefined(cancelledRun);
  assert.isNull(cancelledRun.startedAt);
  const cancelledMessage = projection.messages.find(
    (message) => message.id === cancelledRun.userMessageId,
  );
  assert.isDefined(cancelledMessage);
  assert.equal(cancelledMessage.createdBy, "agent");
  assert.equal(cancelledMessage.creationSource, "server");

  const capturedShell = result.capturedShellSnapshots
    .get(ACTIVE_RUN_SHELL_SNAPSHOT_KEY)
    ?.threads.find((thread) => thread.id === projection.thread.id);
  assert.isDefined(capturedShell);
  // The cancelled queued run never started, so the active run presents as the latest.
  assert.equal(capturedShell.latestRunId, activeRun.id);
  assert.equal(capturedShell.status, "running");
  assert.equal(capturedShell.activeRunId, activeRun.id);
  assert.equal(capturedShell.activityRunStatus, "running");
  assert.deepEqual(
    capturedShell.activityRunStartedAt,
    activeRun.startedAt ?? activeRun.requestedAt,
  );
  assert.deepEqual(capturedShell.pendingBackgroundTasks, []);
}
