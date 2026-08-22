import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2PermissionDeclineOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  const request = projection.runtimeRequests[0];
  assert.equal(request?.status, "resolved");
  assert.equal(projection.nodes.find((node) => node.id === request?.nodeId)?.status, "cancelled");
  assert.equal(
    projection.turnItems.find(
      (item) => item.type === "approval_request" && item.requestId === request?.id,
    )?.status,
    "cancelled",
  );
  assertAssistantTextIncludes(projection, "fixture simple ok");
  assertAssistantTextIncludes(projection, "fixture duplicate ok");
}
