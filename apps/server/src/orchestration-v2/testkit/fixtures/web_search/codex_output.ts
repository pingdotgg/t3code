import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertExecutionNodeKinds,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  WEB_SEARCH_PROMPT,
} from "../shared.ts";

const WEB_SEARCH_QUERY = "FIFA World Cup 2026 ticket prices official";

export function assertWebSearchOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertExecutionNodeKinds(projection, ["root_turn", "tool_call", "assistant_message"]);
  assertConversationMessageRoles(projection, ["user", "assistant"]);
  assertTurnItemTypes(projection, ["user_message", "web_search", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [WEB_SEARCH_PROMPT]);
  assertAssistantTextIncludes(projection, "web search fixture complete");

  const webSearchItems = projection.turnItems.filter((item) => item.type === "web_search");
  assert.lengthOf(webSearchItems, 1);
  assert.equal(webSearchItems[0]?.status, "completed");
  assert.include(webSearchItems[0]?.patterns ?? [], WEB_SEARCH_QUERY);
}
