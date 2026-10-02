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
  assertTurnItemTypes(projection, ["user_message", "dynamic_tool", "assistant_message"]);
  assertUserMessagesInclude(projection, [TOOL_CALL_READ_ONLY_PROMPT]);
  assertAssistantTextIncludes(projection, "read only tool fixture complete");
  assertRuntimeRequestCounts(projection, { total: 0 });

  const assistantMessages = projection.turnItems.filter(
    (item) => item.type === "assistant_message",
  );
  assert.deepEqual(
    // Trailing newlines after the progress line vary between recordings.
    assistantMessages.map((item) => item.text.trimEnd()),
    ["Reading both files now.", "read only tool fixture complete"],
    "Cursor progress text and the final response must be separate messages",
  );

  const reads = projection.turnItems.filter((item) => item.type === "dynamic_tool");
  assert.lengthOf(reads, 2);
  assert.isBelow(assistantMessages[0]?.ordinal ?? Infinity, reads[0]?.ordinal ?? -Infinity);
  assert.isBelow(reads[1]?.ordinal ?? Infinity, assistantMessages[1]?.ordinal ?? -Infinity);
  assert.isTrue(
    reads.some((item) => JSON.stringify(item.output ?? []).includes("cursor-read-only-fixture")),
  );
  assert.isTrue(reads.some((item) => JSON.stringify(item.output ?? []).includes("ES2022")));
  const expectedPaths = [
    "/tmp/claude-replay-tool_call_read_only/package.json",
    "/tmp/claude-replay-tool_call_read_only/tsconfig.json",
  ];
  assert.deepEqual(
    reads.map((item) => (item.input as { path: string }).path).toSorted(),
    expectedPaths,
    "Cursor read paths must match the files named in the recorded prompt",
  );
}
