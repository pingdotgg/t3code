import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_READ_ONLY_PROMPT,
} from "../shared.ts";

/** ZCode reads both files itself, without asking, and answers after the reads. */
export function assertToolCallReadOnlyZCodeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_READ_ONLY_PROMPT]);
  assertAssistantTextIncludes(projection, "read only tool fixture complete");
  assertRuntimeRequestCounts(projection, { total: 0 });

  const reads = projection.turnItems.filter((item) => item.type === "dynamic_tool");
  assert.lengthOf(reads, 2);
  assert.isTrue(reads.every((item) => item.status === "completed"));
  assert.isTrue(
    reads.some((item) => JSON.stringify(item.output ?? []).includes("zcode-read-only-fixture")),
  );
  assert.isTrue(reads.some((item) => JSON.stringify(item.output ?? []).includes("ES2022")));
  const answer = projection.turnItems.findLast((item) => item.type === "assistant_message");
  assert.isBelow(
    Math.max(...reads.map((item) => item.ordinal)),
    answer?.ordinal ?? -Infinity,
    "the answer follows the reads",
  );
}
