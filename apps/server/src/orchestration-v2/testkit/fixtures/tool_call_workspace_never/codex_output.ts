import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

export function assertToolCallWorkspaceNeverOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message", "command_execution", "assistant_message"]);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assert.equal(projection.turnItems.filter((item) => item.type === "approval_request").length, 0);
}
