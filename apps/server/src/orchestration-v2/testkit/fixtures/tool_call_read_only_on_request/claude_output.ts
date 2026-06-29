import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertBaseProjection,
  assertReplayLabelPrefixCount,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

export function assertToolCallReadOnlyOnRequestClaudeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["command"]);
  assertAllRuntimeRequestsResolved(projection);
  assertReplayLabelPrefixCount(transcript, "permission.request:", 1);
  assertReplayLabelPrefixCount(transcript, "permission.response:", 1);

  assert.isAtLeast(
    projection.turnItems.filter((i) => i.type === "command_execution" || i.type === "file_change")
      .length,
    1,
    "Claude must project at least one concrete tool item",
  );
  assert.isAtLeast(
    projection.turnItems.filter((item) => item.type === "approval_request").length,
    1,
    "Claude must project a V2 approval request for the permission callback",
  );
  assert.isAtLeast(
    projection.turnItems.filter((item) => item.type === "assistant_message").length,
    1,
    "Claude must project the final assistant message",
  );
}
