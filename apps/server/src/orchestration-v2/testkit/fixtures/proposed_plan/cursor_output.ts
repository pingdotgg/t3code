import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  PROPOSED_PLAN_PROMPT,
} from "../shared.ts";

export function assertProposedPlanCursorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1]);
  assertExecutionNodeKinds(projection, ["root_turn", "plan", "subagent", "tool_call"]);
  assertTurnItemTypes(projection, ["user_message", "subagent", "file_search", "proposed_plan"]);
  assertUserMessagesInclude(projection, [PROPOSED_PLAN_PROMPT]);

  const proposedPlans = projection.plans.filter((plan) => plan.kind === "proposed_plan");
  assert.isAtLeast(proposedPlans.length, 1);
  assert.include(proposedPlans.at(-1)?.markdown, "Deterministic Replay Fixtures");

  const proposedPlanItems = projection.turnItems.filter((item) => item.type === "proposed_plan");
  assert.isAtLeast(proposedPlanItems.length, 1);
  assert.equal(proposedPlanItems.at(-1)?.streaming, false);
  assert.isAtLeast(projection.subagents.length, 1);
}
