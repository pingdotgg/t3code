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

/** OpenCode 2's renamed `read` and `shell` tools, run in one step, then a second step. */
export function assertOpenCode2ToolCallOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  // Buffered delivery keeps streaming text out of the read model until
  // `text.ended`, which OpenCode sends after both tool calls started.
  assertTurnItemTypeSequence(projection, [
    "user_message",
    "dynamic_tool",
    "command_execution",
    "assistant_message",
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
}
