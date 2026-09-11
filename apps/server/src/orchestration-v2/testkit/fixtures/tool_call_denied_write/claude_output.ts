import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertReplayLabelPrefixCount,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";

export function assertToolCallDeniedWriteClaudeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["file-change"]);
  assertAllRuntimeRequestsResolved(projection);
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.decision),
    ["decline"],
  );
  assertReplayLabelPrefixCount(transcript, "permission.request:", 1);
  assertReplayLabelPrefixCount(transcript, "permission.response:", 1);
  assertAssistantTextIncludes(projection, "write permission denied");
  const writes = projection.turnItems.filter((item) => item.type === "file_change");
  assert.lengthOf(writes, 1);
  assert.equal(writes[0]?.status, "failed");
}
