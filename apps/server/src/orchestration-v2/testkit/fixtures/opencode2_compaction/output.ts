import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_COMPACTION_INTERRUPT_PROMPT,
  OPENCODE2_COMPACTION_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCode2CompactionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "interrupted"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertConversationMessageRoles(projection, ["user", "assistant", "user"]);
  assertUserMessagesInclude(projection, [
    OPENCODE2_COMPACTION_PROMPT,
    OPENCODE2_COMPACTION_INTERRUPT_PROMPT,
  ]);
  assertAssistantTextIncludes(projection, "compaction fixture complete");

  const compactions = projection.turnItems.filter((item) => item.type === "compaction");
  assert.equal(compactions.length, 2, "each lifecycle must retain one stable compaction row");
  const completed = compactions.find((compaction) => compaction.status === "completed");
  assert.isDefined(completed);
  assert.equal(completed.driver, "opencode2");
  assert.equal(completed.summary, "Summary from compaction.");

  const interrupted = compactions.find((compaction) => compaction.status === "cancelled");
  assert.isDefined(interrupted);
  assert.equal(interrupted.driver, "opencode2");
  assert.equal(interrupted.summary, "Partial summary");

  for (const compaction of compactions) {
    const node = projection.nodes.find((candidate) => candidate.id === compaction.nodeId);
    assert.isDefined(node);
    assert.equal(node.kind, "system");
    assert.equal(node.status, compaction.status);
  }
}
