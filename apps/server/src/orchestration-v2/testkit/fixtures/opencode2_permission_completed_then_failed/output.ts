import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2PermissionCompletedThenFailedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 0 });
  assert.equal(projection.runtimeRequests[0]?.status, "cancelled");
  assert.isTrue(projection.providerSessions.every((session) => session.status === "error"));
}
