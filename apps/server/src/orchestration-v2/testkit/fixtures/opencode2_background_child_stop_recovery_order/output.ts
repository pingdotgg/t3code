import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2BackgroundChildStopRecoveryOrderOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const recoveryAdmitted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "recovery.input.admitted",
  );
  const cancelledAdmitted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "cancelled.parent.wake",
  );
  const cancelledPromoted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "cancelled.input.promoted.first",
  );
  const cancelledStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "cancelled.root.execution.started",
  );
  const cancelledEnded = transcript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && entry.label === "cancelled.root.execution.succeeded",
  );
  const recoveryPromoted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "recovery.input.promoted",
  );
  const recoveryStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "recovery.execution.started",
  );
  assert.isAtLeast(recoveryAdmitted, 0);
  assert.isAtLeast(cancelledAdmitted, 0);
  assert.isAtLeast(cancelledPromoted, 0);
  assert.isAtLeast(cancelledStarted, 0);
  assert.isAtLeast(cancelledEnded, 0);
  assert.isAtLeast(recoveryPromoted, 0);
  assert.isAtLeast(recoveryStarted, 0);
  assert.isAbove(cancelledAdmitted, recoveryAdmitted);
  assert.isAbove(cancelledPromoted, cancelledAdmitted);
  assert.isAbove(cancelledStarted, cancelledPromoted);
  assert.isAbove(cancelledEnded, cancelledStarted);
  assert.isAbove(recoveryPromoted, cancelledEnded);
  assert.isAbove(recoveryStarted, recoveryPromoted);

  const projection = projectionFor(result, transcript.scenario);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assertAssistantTextIncludes(projection, "PARENT_RELEASED");
  assertAssistantTextIncludes(projection, "RECOVERY_OK");
  assert.notInclude(JSON.stringify(projection), "CANCELLED_ROOT_OUTPUT_MUST_NOT_APPEAR");

  const subagentItem = projection.turnItems.find((item) => item.type === "subagent");
  assert.strictEqual(subagentItem?.type, "subagent");
  if (subagentItem?.type !== "subagent") {
    throw new Error("OpenCode 2 recovery ordering fixture is missing its child item");
  }
  assert.equal(subagentItem.status, "interrupted");
  assert.isNotNull(subagentItem.childThreadId);
  const child = result.projections.get(subagentItem.childThreadId!);
  assert.isDefined(child);
  assert.equal(child!.providerTurns.at(-1)?.status, "interrupted");
  assert.notInclude(JSON.stringify(child), "CANCELLED_ROOT_OUTPUT_MUST_NOT_APPEAR");
}
