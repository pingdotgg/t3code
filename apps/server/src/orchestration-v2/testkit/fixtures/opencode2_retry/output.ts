import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_RETRY_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2RetryOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertConversationMessageRoles(projection, ["user", "assistant"]);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertUserMessagesInclude(projection, [OPENCODE2_RETRY_PROMPT]);
  assertAssistantTextIncludes(projection, "retry fixture complete");

  const scheduled = transcript.entries.filter(
    (entry) => entry.type === "emit_inbound" && entry.label === "session.retry.scheduled",
  );
  assert.equal(scheduled.length, 1);
  assert.isFalse(
    projection.turnItems.some((item) => item.type === "error"),
    "a provider-managed retry must not become a failed T3 turn item",
  );
}
