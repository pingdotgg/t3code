import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * Two turns in one Muse session. Muse streams reasoning beside each reply, and
 * its per-step skill-reminder child never shows as a row.
 */
export function assertMuseMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
  assertUserMessagesInclude(projection, [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT]);
  assertAssistantTextIncludes(projection, "first fixture turn complete");
  assertAssistantTextIncludes(projection, "second fixture turn complete");
  assert.isTrue(
    projection.turnItems.every((item) =>
      ["user_message", "assistant_message", "reasoning", "checkpoint"].includes(item.type),
    ),
    `unexpected rows: ${projection.turnItems.map((item) => item.type).join(", ")}`,
  );
  // Both turns ran on one native session.
  assert.lengthOf(projection.providerThreads, 1);
}
