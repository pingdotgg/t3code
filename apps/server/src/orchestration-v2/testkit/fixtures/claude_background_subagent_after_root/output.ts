import { assert } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection, ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT } from "./input.ts";

const SUBAGENT_TEXTS = ["SUB_STEP_1", "SUB_STEP_2", "SUB_FINAL_REPORT"];
const SUBAGENT_COMMANDS = ["sleep 3 && echo SUB_DONE_1", "sleep 3 && echo SUB_DONE_2"];

function assistantTexts(projection: OrchestrationV2ThreadProjection): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text.trim()] : [],
  );
}

function commandTexts(projection: OrchestrationV2ThreadProjection): ReadonlyArray<string> {
  return projection.turnItems.flatMap((item) =>
    item.type === "command_execution" ? [JSON.stringify(item.input)] : [],
  );
}

// Every frame the background subagent emits arrives after the root turn's
// result, so it reaches the adapter through the wake buffer and drains into
// the continuation turn. None of it may land in the parent thread.
export function assertClaudeBackgroundSubagentAfterRootOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT]);

  const parentTexts = assistantTexts(projection);
  assert.includeMembers([...parentTexts], ["ROOT_STARTED", "ROOT_WAKE_DONE"]);
  for (const text of SUBAGENT_TEXTS) {
    assert.notInclude(parentTexts, text, `subagent text ${text} leaked into the parent thread`);
  }
  for (const command of SUBAGENT_COMMANDS) {
    assert.isFalse(
      commandTexts(projection).some((input) => input.includes(command)),
      `subagent command ${command} leaked into the parent thread`,
    );
  }

  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.equal(subagent?.status, "completed");
  assert.equal(subagent?.origin, "provider_native");
  if (subagent?.childThreadId == null) {
    throw new Error("The background subagent is missing its child thread.");
  }
  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  assert.deepEqual(
    assistantTexts(childProjection).filter((text) => SUBAGENT_TEXTS.includes(text)),
    SUBAGENT_TEXTS,
    "the child thread shows the subagent's narration in order and its final report once",
  );
  for (const command of SUBAGENT_COMMANDS) {
    assert.isTrue(
      commandTexts(childProjection).some((input) => input.includes(command)),
      `subagent command ${command} must be in the child thread`,
    );
  }
}
