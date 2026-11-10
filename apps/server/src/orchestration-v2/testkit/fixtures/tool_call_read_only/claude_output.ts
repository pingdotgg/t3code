import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertReplayLabelPrefixCount,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_READ_ONLY_PROMPT,
} from "../shared.ts";

export function assertToolCallReadOnlyClaudeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "dynamic_tool", "assistant_message"]);
  assertUserMessagesInclude(projection, [TOOL_CALL_READ_ONLY_PROMPT]);
  assertAssistantTextIncludes(projection, "read only tool fixture complete");
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertReplayLabelPrefixCount(transcript, "permission.request:", 0);
  assertReplayLabelPrefixCount(transcript, "permission.response:", 0);
  assert.notInclude(JSON.stringify(transcript.entries), '"is_error":true');
  assert.notInclude(JSON.stringify(transcript.entries), "File does not exist");

  const dynamicTools = projection.turnItems.filter((item) => item.type === "dynamic_tool");
  assert.lengthOf(dynamicTools, 2);
  assert.lengthOf(
    dynamicTools.filter((item) => item.toolName === "Glob"),
    0,
    "Claude should not need discovery errors for this deterministic read-only fixture",
  );
  assert.lengthOf(
    dynamicTools.filter((item) => item.toolName === "Read"),
    2,
    "Claude must project Read file tool calls",
  );
  assert.isTrue(
    dynamicTools.some((item) =>
      JSON.stringify(item.output ?? null).includes("claude-read-only-fixture"),
    ),
    "Claude must read package.json contents",
  );
  assert.isTrue(
    dynamicTools.some((item) => JSON.stringify(item.output ?? null).includes("ESNext")),
    "Claude must read tsconfig.json contents",
  );
  assert.lengthOf(
    projection.turnItems.filter((item) => item.type === "approval_request"),
    0,
  );
}
