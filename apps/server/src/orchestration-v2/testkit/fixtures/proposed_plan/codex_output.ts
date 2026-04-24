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
  projectionFor,
  PROPOSED_PLAN_PROMPT,
} from "../shared.ts";

export function assertProposedPlanOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertRunOrdinals(projection, [1]);
  assertExecutionNodeKinds(projection, ["root_turn", "plan"]);
  assertTurnItemTypes(projection, ["user_message", "proposed_plan"]);
  assertUserMessagesInclude(projection, [PROPOSED_PLAN_PROMPT]);

  const proposedPlans = projection.plans.filter((plan) => plan.kind === "proposed_plan");
  assert.isAtLeast(proposedPlans.length, 1);
  assert.include(proposedPlans.at(-1)?.markdown, "Deterministic Replay Fixtures");

  const proposedPlanItems = projection.turnItems.filter((item) => item.type === "proposed_plan");
  assert.isAtLeast(proposedPlanItems.length, 1);
  assert.equal(proposedPlanItems.at(-1)?.streaming, false);
}
