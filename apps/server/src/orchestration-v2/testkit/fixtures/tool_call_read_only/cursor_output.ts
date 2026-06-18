import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_READ_ONLY_PROMPT,
} from "../shared.ts";

export function assertToolCallReadOnlyCursorOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "file_search", "assistant_message"]);
  assertUserMessagesInclude(projection, [TOOL_CALL_READ_ONLY_PROMPT]);
  assertAssistantTextIncludes(projection, "read only tool fixture complete");
  assertRuntimeRequestCounts(projection, { total: 0 });

  const assistantMessages = projection.turnItems.filter(
    (item) => item.type === "assistant_message",
  );
  assert.deepEqual(
    assistantMessages.map((item) => item.text),
    ["Reading both files now.\n", "read only tool fixture complete"],
    "Cursor progress text and the final response must be separate messages",
  );

  const fileSearches = projection.turnItems.filter((item) => item.type === "file_search");
  assert.lengthOf(fileSearches, 2);
  assert.isBelow(assistantMessages[0]?.ordinal ?? Infinity, fileSearches[0]?.ordinal ?? -Infinity);
  assert.isBelow(fileSearches[1]?.ordinal ?? Infinity, assistantMessages[1]?.ordinal ?? -Infinity);
  assert.isTrue(
    fileSearches.some((item) =>
      JSON.stringify(item.results ?? []).includes("cursor-read-only-fixture"),
    ),
  );
  assert.isTrue(fileSearches.some((item) => JSON.stringify(item.results ?? []).includes("ES2022")));
}
