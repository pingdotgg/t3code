import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  CLAUDE_SUBAGENT_EMPTY_PROMPT_BLANK_PROMPT,
  CLAUDE_SUBAGENT_EMPTY_PROMPT_LATE_PROMPT,
  CLAUDE_SUBAGENT_EMPTY_PROMPT_ROOT_PROMPT,
} from "./input.ts";

export function assertClaudeSubagentEmptyPromptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_SUBAGENT_EMPTY_PROMPT_ROOT_PROMPT]);
  assert.lengthOf(projection.subagents, 2);

  for (const [threadId, childProjection] of result.projections) {
    if (childProjection.thread.lineage.parentThreadId === null) {
      continue;
    }
    assert.isFalse(
      childProjection.messages.some(
        (message) => message.role === "user" && message.text.trim().length === 0,
      ),
      `child thread ${threadId} must not open with a blank user message`,
    );
    assert.isFalse(
      childProjection.turnItems.some(
        (item) => item.type === "user_message" && item.text.trim().length === 0,
      ),
      `child thread ${threadId} must not open with a blank user turn item`,
    );
  }

  const blankSubagent = projection.subagents.find(
    (subagent) => subagent.prompt === CLAUDE_SUBAGENT_EMPTY_PROMPT_BLANK_PROMPT,
  );
  assert.isDefined(blankSubagent, "the whitespace-only launch must still register a subagent");
  assert.equal(blankSubagent.status, "completed");
  assert.isNotNull(blankSubagent.childThreadId);
  if (blankSubagent.childThreadId === null) {
    throw new Error(`Subagent ${blankSubagent.id} is missing its child thread`);
  }
  const blankChild = result.projections.get(blankSubagent.childThreadId);
  assert.isDefined(blankChild);
  assert.lengthOf(
    blankChild.turnItems.filter((item) => item.type === "user_message"),
    0,
    "a whitespace-only prompt must not project an opening user message",
  );
  assert.isTrue(
    blankChild.turnItems.some((item) => item.type === "assistant_message"),
    "the child thread still receives its own assistant output",
  );

  const lateSubagent = projection.subagents.find(
    (subagent) => subagent.prompt === CLAUDE_SUBAGENT_EMPTY_PROMPT_LATE_PROMPT,
  );
  assert.isDefined(
    lateSubagent,
    "task_started must still fill in the prompt task_progress registered without",
  );
  assert.equal(lateSubagent.status, "completed");
  if (lateSubagent.childThreadId === null) {
    throw new Error(`Subagent ${lateSubagent.id} is missing its child thread`);
  }
  const lateChild = result.projections.get(lateSubagent.childThreadId);
  assert.isDefined(lateChild);
  assert.deepEqual(
    lateChild.turnItems.filter((item) => item.type === "user_message").map((item) => item.text),
    [CLAUDE_SUBAGENT_EMPTY_PROMPT_LATE_PROMPT],
    "the opening message is emitted exactly once, when the prompt first has text",
  );
}
