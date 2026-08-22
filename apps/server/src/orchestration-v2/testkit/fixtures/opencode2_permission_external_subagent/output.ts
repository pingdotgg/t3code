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

export function assertOpenCode2PermissionExternalSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const item = projection.turnItems.find((candidate) => candidate.type === "subagent");
  assert.strictEqual(item?.type, "subagent");
  if (item?.type !== "subagent") throw new Error("OpenCode 2 subagent item is missing");
  assert.strictEqual(item.status, "completed");
  assert.isNotNull(item.childThreadId);
  const child = result.projections.get(item.childThreadId!);
  assert.isDefined(child);
  assert.strictEqual(child!.thread.lineage.parentThreadId, projection.thread.id);
  assert.strictEqual(child!.thread.lineage.relationshipToParent, "subagent");
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertAllRuntimeRequestsResolved(projection);
  assertRuntimeRequestCounts(child!, { total: 0 });
  assertAssistantTextIncludes(child!, "CHILD_OK");
  assertAssistantTextIncludes(projection, "PARENT_OK");
  assert.strictEqual(projection.subagents[0]?.status, "completed");
}
