import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_TODO_LIST_PROMPT } from "./input.ts";

export function assertClaudeTodoListOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [CLAUDE_TODO_LIST_PROMPT]);
  assertAssistantTextIncludes(projection, "claude todo list fixture complete");

  // TaskCreate and TaskUpdate edit one list for the turn, updated in place.
  const todoLists = projection.plans.filter((plan) => plan.kind === "todo_list");
  assert.lengthOf(todoLists, 1);
  assert.deepEqual(
    todoLists[0]?.steps.map((step) => [step.text, step.status]),
    [
      ["Inspect package.json", "completed"],
      ["Inspect tsconfig.json", "completed"],
      ["Report completion", "completed"],
    ],
  );
  const planIds = new Set(
    result.domainEvents.flatMap((event) =>
      event.type === "plan.updated" ? [event.payload.id] : [],
    ),
  );
  assert.equal(planIds.size, 1, "Claude task updates must preserve one plan identity");
}
