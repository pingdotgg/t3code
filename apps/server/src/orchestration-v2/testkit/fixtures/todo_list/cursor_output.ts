import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TODO_LIST_PROMPT,
} from "../shared.ts";

export function assertTodoListCursorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1]);
  assertExecutionNodeKinds(projection, ["root_turn", "todo_list", "tool_call"]);
  assertTurnItemTypes(projection, [
    "user_message",
    "file_search",
    "todo_list",
    "assistant_message",
  ]);
  assertUserMessagesInclude(projection, [TODO_LIST_PROMPT]);
  assertAssistantTextIncludes(projection, "todo list fixture complete");

  const conversationalItems = projection.turnItems.filter(
    (item) => item.type === "assistant_message" || item.type === "reasoning",
  );
  assert.deepEqual(
    conversationalItems.map((item) => item.type),
    ["assistant_message", "reasoning", "reasoning", "assistant_message", "assistant_message"],
    "separate Cursor reasoning and assistant segments must not be concatenated",
  );
  const assistantMessages = conversationalItems.filter((item) => item.type === "assistant_message");
  assert.lengthOf(assistantMessages, 3);
  assert.include(assistantMessages[0]?.text ?? "", "I'll use the update_plan tool");
  assert.include(assistantMessages[1]?.text ?? "", "No `update_plan` tool is available");
  assert.equal(assistantMessages[2]?.text, "todo list fixture complete");
  assert.lengthOf(
    conversationalItems.filter((item) => item.type === "reasoning"),
    2,
  );

  const todoLists = projection.plans.filter((plan) => plan.kind === "todo_list");
  assert.isAtLeast(todoLists.length, 1);
  assert.deepEqual(
    todoLists.at(-1)?.steps.map((step) => step.status),
    ["completed", "completed", "completed"],
  );
}
