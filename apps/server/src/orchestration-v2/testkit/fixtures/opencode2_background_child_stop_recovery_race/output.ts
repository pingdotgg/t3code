import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

function transcriptIndex(transcript: ProviderReplayTranscript, label: string): number {
  return transcript.entries.findIndex(
    (entry) => entry.type !== "runtime_exit" && entry.label === label,
  );
}

export function assertOpenCode2BackgroundChildStopRecoveryRaceOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const recoveryAdmitted = transcriptIndex(transcript, "recovery.input.admitted");
  const lateCancellationAdmitted = transcriptIndex(transcript, "cancelled.parent.wake.late");
  const recoveryStarted = transcriptIndex(transcript, "recovery.execution.started");
  assert.isAtLeast(recoveryAdmitted, 0);
  assert.isAtLeast(lateCancellationAdmitted, 0);
  assert.isAtLeast(recoveryStarted, 0);
  assert.isAbove(lateCancellationAdmitted, recoveryAdmitted);
  assert.isAbove(recoveryStarted, lateCancellationAdmitted);

  const projection = projectionFor(result, transcript.scenario);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assertAssistantTextIncludes(projection, "RECOVERY_OK");
  assert.notInclude(
    projection.messages.map((message) => message.text).join("\n"),
    "CANCELLED_CONTINUATION_MUST_NOT_APPEAR",
  );
  assert.notInclude(JSON.stringify(projection), "CANCELLED_CONTINUATION_MUST_NOT_APPEAR");
  assert.notInclude(JSON.stringify(projection), "CHILD_PARTIAL_SECOND");
}
