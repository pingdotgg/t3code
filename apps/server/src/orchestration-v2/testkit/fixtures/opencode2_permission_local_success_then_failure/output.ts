import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2PermissionLocalSuccessThenFailureOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 0 });
  const request = projection.runtimeRequests[0];
  assert.equal(request?.status, "cancelled");
  assert.equal(projection.nodes.find((node) => node.id === request?.nodeId)?.status, "cancelled");
  assert.equal(
    projection.turnItems.find(
      (item) => item.type === "approval_request" && item.requestId === request?.id,
    )?.status,
    "cancelled",
  );
}
