import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_COMPACTION_FIRST_PROMPT,
  OPENCODE2_COMPACTION_RECALL_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * `/compact` runs `session.compact`: OpenCode queues a compaction item and
 * summarizes in its own execution, which ends the `/compact` turn. The next
 * turn answers from the summary.
 */
export function assertOpenCode2CompactionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [
    OPENCODE2_COMPACTION_FIRST_PROMPT,
    "/compact",
    OPENCODE2_COMPACTION_RECALL_PROMPT,
  ]);

  const compactRun = projection.runs[1];
  const compactions = projection.turnItems.filter((item) => item.type === "compaction");
  assert.lengthOf(compactions, 1);
  const [compaction] = compactions;
  assert.equal(compaction?.runId, compactRun?.id);
  assert.equal(compaction?.status, "completed");
  assert.equal(compaction?.title, "Context compacted");
  // The summary OpenCode carries forward is `compaction.ended`'s full text.
  assert.include(compaction?.type === "compaction" ? compaction.summary : "", "PAPAYA");
  assert.include(compaction?.type === "compaction" ? compaction.summary : "", "## Objective");
  // The `/compact` run shows no assistant reply; the recall run answers from the summary.
  assert.isUndefined(
    projection.turnItems.find(
      (item) => item.type === "assistant_message" && item.runId === compactRun?.id,
    ),
  );
  assertAssistantTextIncludes(projection, "PAPAYA");
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["completed", "completed", "completed"],
  );
}
