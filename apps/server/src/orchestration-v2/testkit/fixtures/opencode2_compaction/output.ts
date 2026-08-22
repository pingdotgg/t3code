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
  assert.equal(completed.usedTokenCount, 902_000);
  assert.equal(completed.inputTokenCount, 272_000);
  assert.equal(completed.inputLimit, 922_000);
  assert.equal(completed.contextLimit, 1_050_000);
  assert.equal(completed.outputReserve, 32_000);
  assert.equal(completed.triggerThreshold, 902_000);
  assert.equal(completed.triggerReason, "auto");

  const interrupted = compactions.find((compaction) => compaction.status === "cancelled");
  assert.isDefined(interrupted);
  assert.equal(interrupted.driver, "opencode2");
  assert.equal(interrupted.summary, "Partial summary");
  assert.equal(interrupted.usedTokenCount, 902_000);
  assert.equal(interrupted.inputTokenCount, 272_000);
  assert.equal(interrupted.inputLimit, 922_000);
  assert.equal(interrupted.contextLimit, 1_050_000);
  assert.equal(interrupted.outputReserve, 32_000);
  assert.equal(interrupted.triggerThreshold, 902_000);
  assert.equal(interrupted.triggerReason, "auto");

  for (const compaction of compactions) {
    const node = projection.nodes.find((candidate) => candidate.id === compaction.nodeId);
    assert.isDefined(node);
    assert.equal(node.kind, "system");
    assert.equal(node.status, compaction.status);
  }
}
