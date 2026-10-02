import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertNoExtraAppRunsForProviderChildren,
  assertRunProviderTurnCardinality,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  OPENCODE_SUBAGENT_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertOpenCodeSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertExecutionNodeKinds(projection, ["root_turn", "subagent", "assistant_message"]);
  assertTurnItemTypes(projection, ["user_message", "subagent", "assistant_message"]);
  assertRunProviderTurnCardinality({ projection, rootRunCount: 1 });
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertUserMessagesInclude(projection, [OPENCODE_SUBAGENT_PROMPT]);
  assertAssistantTextIncludes(projection, "PARENT_OK");

  assert.lengthOf(projection.subagents, 1);
  assert.lengthOf(result.shellSnapshot.threads, 2);
  const subagent = projection.subagents[0];
  assert.isDefined(subagent);
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.createdBy, "agent");
  assert.equal(subagent.driver, "opencode");
  assert.equal(subagent.status, "completed");
  assert.equal(subagent.prompt, "Respond exactly CHILD_OK.");
  assert.include(subagent.result ?? "", "CHILD_OK");
  assert.isNotNull(subagent.childThreadId);
  assert.isNotNull(subagent.providerThreadId);
  assert.isNotNull(subagent.nativeTaskRef);
  assert.isNotNull(subagent.completedAt);
  if (subagent.childThreadId === null || subagent.providerThreadId === null) {
    throw new Error("OpenCode subagent is missing its child thread identity");
  }

  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === subagent.providerThreadId,
  );
  assert.isDefined(providerThread);
  assert.equal(providerThread.appThreadId, subagent.childThreadId);
  assert.equal(providerThread.ownerNodeId, subagent.id);

  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  assert.equal(childProjection.thread.lineage.parentThreadId, projection.thread.id);
  assert.equal(childProjection.thread.lineage.relationshipToParent, "subagent");
  assert.equal(childProjection.thread.activeProviderThreadId, providerThread.id);
  assert.lengthOf(childProjection.runs, 0);
  assert.lengthOf(childProjection.providerThreads, 1);
  assert.lengthOf(childProjection.providerTurns, 1);
  assert.equal(childProjection.providerTurns[0]?.status, "completed");
  assertExecutionNodeKinds(childProjection, ["root_turn", "assistant_message"]);
  assertTurnItemTypes(childProjection, ["user_message", "assistant_message"]);
  assertUserMessagesInclude(childProjection, ["Respond exactly CHILD_OK."]);
  assertAssistantTextIncludes(childProjection, "CHILD_OK");
}
