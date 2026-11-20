import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypeSequence,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_TOOL_CALL_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2ToolCallOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  // OpenCode sends text.ended after tool starts; buffered text must retain its earlier position.
  assertTurnItemTypeSequence(projection, [
    "user_message",
    "assistant_message",
    "dynamic_tool",
    "command_execution",
    "assistant_message",
    "checkpoint",
  ]);
  assertUserMessagesInclude(projection, [OPENCODE2_TOOL_CALL_PROMPT]);
  assertAssistantTextIncludes(projection, "DONE");

  const read = projection.turnItems.find((item) => item.type === "dynamic_tool");
  assert.equal(read?.status, "completed");
  assert.equal(read?.title, "Read hello.txt");
  assert.include(read?.type === "dynamic_tool" ? read.output : "", "hello from the spike");

  const shell = projection.turnItems.find((item) => item.type === "command_execution");
  assert.equal(shell?.status, "completed");
  assert.deepInclude(shell, { input: "echo TOOL_OK", output: "TOOL_OK\n", exitCode: 0 });

  const [providerTurn] = projection.providerTurns;
  assert.deepInclude(providerTurn?.turnTokenUsage, {
    usageStatus: "complete",
    inputTokens: 8767 + 487 + 45 + 9311,
    outputTokens: 59 + 33,
  });
  assert.deepInclude(providerTurn?.tokenUsage, { usedTokens: 45 + 9311 + 33, maxTokens: 160000 });
}
