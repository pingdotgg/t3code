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
 * fx reports each sub-agent as a `subagent` tool call and streams none of the
 * child's frames, so each child thread holds the task and fx's reply.
 */
export function assertFxSubagentOutput(
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
    "the subagent calls must not also show as tool rows",
  );

  assert.lengthOf(projection.subagents, 2);
  assert.lengthOf(result.shellSnapshot.threads, 3);
  for (const subagent of projection.subagents) {
    assert.equal(subagent.status, "completed");
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.driver, "fx");
    assert.isNotNull(subagent.nativeTaskRef);
    assert.isNotEmpty(subagent.prompt);
    if (subagent.result === null) throw new Error(`Subagent ${subagent.id} has no result`);
    assert.notInclude(subagent.result, '"ok":', "the result is fx's reply, not its JSON");
    if (subagent.childThreadId === null) {
      throw new Error(`Subagent ${subagent.id} is missing its child thread`);
    }

    const child = result.projections.get(subagent.childThreadId);
    assert.isDefined(child);
    assert.equal(child.thread.lineage.parentThreadId, projection.thread.id);
    assert.equal(child.thread.lineage.relationshipToParent, "subagent");
    assert.lengthOf(child.runs, 0);
    assert.deepEqual(
      child.turnItems.map((item) => item.type),
      ["user_message", "assistant_message"],
    );
    assertUserMessagesInclude(child, [subagent.prompt]);
    const reply = child.turnItems.find((item) => item.type === "assistant_message");
    assert.equal(reply?.type === "assistant_message" ? reply.text : null, subagent.result);
  }
}
