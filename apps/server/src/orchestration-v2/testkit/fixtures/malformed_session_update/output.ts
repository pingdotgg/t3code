import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { MALFORMED_SESSION_UPDATE_PROMPT } from "./input.ts";

export function assertMalformedSessionUpdateOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [MALFORMED_SESSION_UPDATE_PROMPT]);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  // The dropped update does not fail the turn.
  assert.notInclude(
    projection.turnItems.map((item) => item.type),
    "error",
  );
  assertAssistantTextIncludes(projection, "malformed update fixture ok");
}
