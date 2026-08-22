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

export function assertOpenCode2PermissionReplyFailureAfterTerminalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

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
  assert.isTrue(projection.providerSessions.every((session) => session.status === "ready"));
  assertAssistantTextIncludes(projection, "fixture simple ok");
}
