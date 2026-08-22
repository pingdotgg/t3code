import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2SubagentSupervisedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const item = projection.turnItems.find(
    (candidate) =>
      candidate.type === "subagent" &&
      candidate.nativeItemRef?.nativeId === "tool:call_opencode2_subagent_supervised",
  );
  assert.strictEqual(item?.type, "subagent");
  if (item?.type !== "subagent") throw new Error("OpenCode 2 subagent item is missing");
  assert.strictEqual(
    projection.turnItems.filter((candidate) => candidate.type === "subagent").length,
    4,
  );
  assert.strictEqual(item.status, "completed");
  assert.isNotNull(item.childThreadId);
  for (const staleNativeId of [
    "call_opencode2_subagent_supervised_stale_completed",
    "call_opencode2_subagent_supervised_stale_failed",
    "call_opencode2_subagent_supervised_competing",
  ]) {
    const stale = projection.turnItems.find(
      (candidate) =>
        candidate.type === "subagent" &&
        candidate.nativeItemRef?.nativeId === `tool:${staleNativeId}`,
    );
    assert.strictEqual(stale?.type, "subagent");
    if (stale?.type !== "subagent") throw new Error(`Stale subagent ${staleNativeId} is missing`);
    assert.isNull(stale.childThreadId);
  }
  const child = result.projections.get(item.childThreadId!);
  assert.isDefined(child);
  assert.strictEqual(child!.thread.lineage.parentThreadId, projection.thread.id);
  assert.strictEqual(child!.thread.lineage.relationshipToParent, "subagent");
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertAllRuntimeRequestsResolved(projection);
  assertRuntimeRequestCounts(child!, { total: 0 });
  assertAssistantTextIncludes(child!, "CHILD_OK");
  assertAssistantTextIncludes(projection, "PARENT_OK");
  const currentSubagent = projection.subagents.find(
    (candidate) => candidate.nativeTaskRef?.nativeId === "tool:call_opencode2_subagent_supervised",
  );
  assert.strictEqual(currentSubagent?.status, "completed");
  assert.isNotNull(currentSubagent?.childThreadId);
}
