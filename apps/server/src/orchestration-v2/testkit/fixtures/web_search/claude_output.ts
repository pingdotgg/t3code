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

const CLAUDE_WEB_SEARCH_QUERY = "FIFA World Cup 2026 ticket pricing";

export function assertClaudeWebSearchOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertExecutionNodeKinds(projection, ["root_turn", "tool_call", "assistant_message"]);
  assertConversationMessageRoles(projection, ["user", "assistant"]);
  assertTurnItemTypes(projection, [
    "user_message",
    "dynamic_tool",
    "web_search",
    "assistant_message",
  ]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [WEB_SEARCH_PROMPT]);
  assertAssistantTextIncludes(projection, "web search fixture complete");

  const toolSearchItems = projection.turnItems.filter(
    (item) => item.type === "dynamic_tool" && item.toolName === "ToolSearch",
  );
  assert.lengthOf(toolSearchItems, 1);

  const webSearchItems = projection.turnItems.filter((item) => item.type === "web_search");
  assert.lengthOf(webSearchItems, 1);
  const webSearch = webSearchItems[0];
  assert.isDefined(webSearch);
  assert.equal(webSearch.status, "completed");
  assert.include(webSearch.patterns ?? [], CLAUDE_WEB_SEARCH_QUERY);
  assert.isAtLeast(webSearch.results?.length ?? 0, 1);
  assert.isTrue(
    webSearch.results?.some((entry) => entry.url?.includes("fifa.com")) ?? false,
    "Claude web search should project structured result URLs",
  );
}
