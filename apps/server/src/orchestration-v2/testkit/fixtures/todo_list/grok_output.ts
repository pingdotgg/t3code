import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TODO_LIST_PROMPT,
} from "../shared.ts";

export function assertTodoListGrokOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertExecutionNodeKinds(projection, ["root_turn", "todo_list", "tool_call"]);
  assertTurnItemTypes(projection, [
    "user_message",
    "todo_list",
    "file_search",
    "assistant_message",
  ]);
  assertUserMessagesInclude(projection, [TODO_LIST_PROMPT]);
  assertAssistantTextIncludes(projection, "todo list fixture complete");

  const planEvents = result.domainEvents.filter((event) => event.type === "plan.updated");
  assert.lengthOf(planEvents, 2);
  assert.lengthOf(
    new Set(planEvents.map((event) => (event.type === "plan.updated" ? event.payload.id : null))),
    1,
    "ACP plan updates must preserve one plan identity",
  );
  const todoLists = projection.plans.filter((plan) => plan.kind === "todo_list");
  assert.isAtLeast(todoLists.length, 1);
  assert.deepEqual(
    todoLists.at(-1)?.steps.map((step) => step.status),
    ["completed", "completed", "completed"],
  );
}
