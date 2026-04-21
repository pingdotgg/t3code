import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  TURN_INTERRUPT_PROMPT,
} from "../shared.ts";

export function assertTurnInterruptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["interrupted"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message"]);
  assertUserMessagesInclude(projection, [TURN_INTERRUPT_PROMPT]);
  assert.include(["interrupted", "cancelled"], projection.providerTurns[0]?.status);
}
