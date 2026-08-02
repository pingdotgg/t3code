import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2RetiredSuppressWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  const recoveryOneStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "recovery.one.execution.started",
  );
  const wakeBPromoted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "retired.bravo.input.promoted",
  );
  const wakeBStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "retired.bravo.execution.started",
  );
  const recoveryTwoStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "recovery.two.execution.started",
  );
  const recoveryTwoAdmitted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "recovery.two.input.admitted",
  );
  assert.isAtLeast(recoveryOneStarted, 0);
  assert.isAtLeast(wakeBPromoted, 0);
  assert.isAtLeast(wakeBStarted, 0);
  assert.isAtLeast(recoveryTwoStarted, 0);
  assert.isAtLeast(recoveryTwoAdmitted, 0);
  assert.isAbove(wakeBStarted, recoveryOneStarted);
  assert.isAbove(wakeBPromoted, wakeBStarted);
  assert.isAbove(recoveryTwoStarted, wakeBPromoted);
  assert.isAbove(recoveryTwoAdmitted, recoveryTwoStarted);

  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assertAssistantTextIncludes(projection, "PARENT_RELEASED");
  assertAssistantTextIncludes(projection, "RECOVERY_ONE");
  assertAssistantTextIncludes(projection, "RECOVERY_TWO");
  assert.notInclude(JSON.stringify(projection), "ALPHA_CANCELLED");
  assert.notInclude(JSON.stringify(projection), "CANCELLED_OUTPUT_MUST_NOT_APPEAR");
}
