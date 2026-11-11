import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_PROMPT,
} from "../shared.ts";

/**
 * Kiro sends a sub-agent's frames on the parent session, tagged with its
 * `agentSubtaskId`. They belong in the sub-agent's thread, not the parent's.
 */
export function assertKiroSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertExecutionNodeKinds(projection, ["root_turn", "subagent"]);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertUserMessagesInclude(projection, [SUBAGENT_PROMPT]);
  assertTurnItemTypes(projection, ["user_message", "subagent", "assistant_message"]);
  assert.notInclude(
    projection.turnItems.map((item) => item.type),
    "dynamic_tool",
    "the sub-agents' tool calls must not land in the parent thread",
  );

  assert.lengthOf(projection.subagents, 2);
  assert.lengthOf(result.shellSnapshot.threads, 3);
  const parentText = projection.turnItems
    .flatMap((item) => (item.type === "assistant_message" ? [item.text] : []))
    .join("\n");
  for (const subagent of projection.subagents) {
    assert.equal(subagent.status, "completed");
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.driver, "kiro");
    assert.isNotNull(subagent.nativeTaskRef);
    assert.isNotNull(subagent.title);
    assert.isNotNull(subagent.result);
    if (subagent.childThreadId === null) {
      throw new Error(`Subagent ${subagent.id} is missing its child thread`);
    }

    const child = result.projections.get(subagent.childThreadId);
    assert.isDefined(child);
    assert.equal(child.thread.lineage.parentThreadId, projection.thread.id);
    assert.equal(child.thread.lineage.relationshipToParent, "subagent");
    assert.lengthOf(child.runs, 0);
    assertTurnItemTypes(child, ["user_message", "dynamic_tool", "assistant_message"]);
    assertUserMessagesInclude(child, [subagent.prompt]);
    for (const item of child.turnItems) {
      if (item.type !== "assistant_message") continue;
      assert.notInclude(parentText, item.text.trim().slice(0, 40));
    }
  }
}
