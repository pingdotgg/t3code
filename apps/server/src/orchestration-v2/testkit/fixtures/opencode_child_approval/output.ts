import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  OPENCODE_SUBAGENT_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCodeChildApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [OPENCODE_SUBAGENT_PROMPT]);
  assertAssistantTextIncludes(projection, "PARENT_OK");

  // The child session's permission ask lands on the ROOT turn as an approval
  // request instead of being dropped, and the reply resolves it.
  const approvalItems = projection.turnItems.filter((item) => item.type === "approval_request");
  assert.lengthOf(approvalItems, 1);
  const approval = approvalItems[0];
  assert.isDefined(approval);
  assert.equal(approval.status, "completed");
  assert.equal(approval.runId, projection.runs[0]?.id ?? null);

  const requests = projection.runtimeRequests;
  assert.lengthOf(requests, 1);
  assert.equal(requests[0]?.kind, "command");
  assert.equal(requests[0]?.status, "resolved");

  // The delegation itself still completes.
  assert.lengthOf(projection.subagents, 1);
  assert.equal(projection.subagents[0]?.status, "completed");
  assert.include(projection.subagents[0]?.result ?? "", "CHILD_OK");
}
