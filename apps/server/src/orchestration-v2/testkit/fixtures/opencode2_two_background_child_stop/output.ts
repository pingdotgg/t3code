import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2TwoBackgroundChildStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const alphaSettled = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "wake.alpha.execution.succeeded",
  );
  const cancelStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "wake.cancel.execution.started",
  );
  const continuationPendingList = transcript.entries.findIndex(
    (entry) => entry.type === "expect_outbound" && entry.label === "root.pending.list.continuation",
  );
  const cancelTextStarted = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "wake.cancel.text.started",
  );
  const cancelSettled = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "wake.cancel.execution.succeeded",
  );
  assert.isAtLeast(alphaSettled, 0);
  assert.isAtLeast(cancelStarted, 0);
  assert.isAtLeast(continuationPendingList, 0);
  assert.isAtLeast(cancelTextStarted, 0);
  assert.isAtLeast(cancelSettled, 0);
  assert.isAbove(cancelStarted, alphaSettled);
  assert.isAbove(continuationPendingList, cancelStarted);
  assert.isAbove(cancelTextStarted, continuationPendingList);
  assert.isAbove(cancelSettled, cancelTextStarted);

  const projection = projectionFor(result, transcript.scenario);
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  assertSemanticProjectionIntegrity(projection);
  assertAssistantTextIncludes(projection, "PARENT_RELEASED");
  assertAssistantTextIncludes(projection, "ALPHA_BACKGROUND_OK");
  assert.notInclude(JSON.stringify(projection), "CANCELLED_WAKE_OUTPUT_MUST_NOT_APPEAR");

  const subagentItems = projection.turnItems.filter((item) => item.type === "subagent");
  assert.lengthOf(subagentItems, 2);
  const alphaItem = subagentItems.find(
    (item) => item.type === "subagent" && item.title?.includes("alpha"),
  );
  const cancelItem = subagentItems.find(
    (item) => item.type === "subagent" && item.title?.includes("cancel"),
  );
  assert.strictEqual(alphaItem?.type, "subagent");
  assert.strictEqual(cancelItem?.type, "subagent");
  if (alphaItem?.type !== "subagent" || cancelItem?.type !== "subagent") {
    throw new Error("OpenCode 2 two-child background Stop items are missing");
  }
  assert.equal(alphaItem.status, "completed");
  assert.equal(cancelItem.status, "interrupted");
  assert.include(cancelItem.result ?? "", "CANCEL_PARTIAL");

  const alphaProjection = result.projections.get(alphaItem.childThreadId!);
  const cancelProjection = result.projections.get(cancelItem.childThreadId!);
  assert.isDefined(alphaProjection);
  assert.isDefined(cancelProjection);
  assertAssistantTextIncludes(alphaProjection!, "ALPHA_BACKGROUND_OK");
  assertAssistantTextIncludes(cancelProjection!, "CANCEL_PARTIAL");
  assert.notInclude(JSON.stringify(cancelProjection), "CANCELLED_WAKE_OUTPUT_MUST_NOT_APPEAR");
}
