import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2BackgroundChildStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const cancellationStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "cancelled.root.execution.started",
  );
  const recoveryAdmitted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "recovery.input.admitted",
  );
  const cancellationEnded = transcript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && entry.label === "cancelled.root.execution.succeeded",
  );
  const recoveryStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "recovery.execution.started",
  );
  assert.isAtLeast(cancellationStarted, 0);
  assert.isAtLeast(recoveryAdmitted, 0);
  assert.isAtLeast(cancellationEnded, 0);
  assert.isAtLeast(recoveryStarted, 0);
  assert.isAbove(recoveryAdmitted, cancellationStarted);
  assert.isAbove(cancellationEnded, recoveryAdmitted);
  assert.isAbove(recoveryStarted, cancellationEnded);

  const sessionInterruptIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "child.session.interrupt",
  );
  const shellRemoveIndex = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "child.shell.remove",
  );
  assert.isAtLeast(sessionInterruptIndex, 0);
  assert.isAtLeast(shellRemoveIndex, 0);
  assert.isAbove(shellRemoveIndex, sessionInterruptIndex);

  const projection = projectionFor(result, transcript.scenario);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assert.equal(projection.runs.length, 2, "cancellation must not create an ordinary success wake");
  assertAssistantTextIncludes(projection, "RECOVERY_OK");
  assert.notInclude(
    projection.messages.map((message) => message.text).join("\n"),
    "CANCELLED_ROOT_OUTPUT_MUST_NOT_APPEAR",
  );
  assert.notInclude(JSON.stringify(projection), "CANCELLED_ROOT_OUTPUT_MUST_NOT_APPEAR");
  assert.notInclude(JSON.stringify(projection), "CHILD_PARTIAL_SECOND");
  const subagentItem = projection.turnItems.find((item) => item.type === "subagent");
  assert.strictEqual(subagentItem?.type, "subagent");
  if (subagentItem?.type !== "subagent") {
    throw new Error("OpenCode 2 background child stop item is missing");
  }
  assert.equal(subagentItem.status, "interrupted");
  assert.include(subagentItem.result ?? "", "CHILD_PARTIAL");
  assert.isNotNull(subagentItem.childThreadId);

  const child = result.projections.get(subagentItem.childThreadId!);
  assert.isDefined(child);
  assertAssistantTextIncludes(child!, "CHILD_PARTIAL");
  assert.equal(child!.providerTurns.at(-1)?.status, "interrupted");
  assert.equal(child!.providerThreads.at(-1)?.status, "idle");
}
