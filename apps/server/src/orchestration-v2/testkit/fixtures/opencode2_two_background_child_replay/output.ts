import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2TwoBackgroundChildReplayOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const alphaSettled = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "wake.alpha.execution.succeeded",
  );
  const bravoStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "wake.bravo.execution.started",
  );
  const firstContinuation = transcript.entries.findIndex(
    (entry) =>
      entry.type === "expect_outbound" && entry.label === "root.pending.list.first.continuation",
  );
  assert.isAtLeast(alphaSettled, 0);
  assert.isAtLeast(bravoStarted, 0);
  assert.isAtLeast(firstContinuation, 0);
  assert.isAbove(bravoStarted, alphaSettled);
  assert.isAbove(firstContinuation, bravoStarted);

  const projection = projectionFor(result, transcript.scenario);
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assertAssistantTextIncludes(projection, "PARENT_RELEASED");
  assertAssistantTextIncludes(projection, "ALPHA_COMPLETED_OK");
  assertAssistantTextIncludes(projection, "BRAVO_COMPLETED_OK");
  assert.notInclude(JSON.stringify(projection), "CANCELLED_OUTPUT_MUST_NOT_APPEAR");

  const subagentItems = projection.turnItems.filter((item) => item.type === "subagent");
  assert.lengthOf(subagentItems, 2);
  for (const item of subagentItems) {
    assert.equal(item.status, "completed");
    const child = result.projections.get(item.childThreadId!);
    assert.isDefined(child);
  }
}
