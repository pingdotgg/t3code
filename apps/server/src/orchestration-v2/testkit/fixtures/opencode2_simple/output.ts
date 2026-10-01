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
  OPENCODE2_SIMPLE_PROMPT,
  projectionFor,
} from "../shared.ts";

/** One OpenCode 2 turn with streamed reasoning and text, ended by `execution.succeeded`. */
export function assertOpenCode2SimpleOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypeSequence(projection, [
    "user_message",
    "reasoning",
    "assistant_message",
    "checkpoint",
  ]);
  assertUserMessagesInclude(projection, [OPENCODE2_SIMPLE_PROMPT]);
  assertAssistantTextIncludes(projection, "391 is not prime: it's the product 17 × 23.");

  const reasoning = projection.turnItems.find((item) => item.type === "reasoning");
  assert.include(reasoning?.type === "reasoning" ? reasoning.text : "", "17×23 = 391");

  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["completed"],
  );
}
