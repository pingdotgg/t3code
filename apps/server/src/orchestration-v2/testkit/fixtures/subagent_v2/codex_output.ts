import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertExecutionNodeKinds,
  assertNoExtraAppRunsForProviderChildren,
  assertRunProviderTurnCardinality,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_PROMPT,
} from "../shared.ts";

export function assertSubagentV2Output(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message", "subagent", "assistant_message"]);
  assertExecutionNodeKinds(projection, ["root_turn", "subagent"]);
  assertRunProviderTurnCardinality({ projection, rootRunCount: 1 });
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertUserMessagesInclude(projection, [SUBAGENT_V2_PROMPT]);
  assert.lengthOf(projection.subagents, 1);
  assert.lengthOf(result.shellSnapshot.threads, 2);

  const subagent = projection.subagents[0]!;
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.createdBy, "agent");
  assert.equal(subagent.driver, "codex");
  assert.equal(subagent.title, "/root/hello_agent");
  assert.equal(subagent.prompt, "");
  assert.equal(subagent.status, "completed");
  assert.equal(subagent.result, "Hello.");
  assert.isNotNull(subagent.childThreadId);
  assert.isNotNull(subagent.providerThreadId);
  assert.isNotNull(subagent.nativeTaskRef);
  assert.isNotNull(subagent.completedAt);
  if (subagent.childThreadId === null) {
    throw new Error(`Subagent ${subagent.id} is missing its child thread`);
  }

  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === subagent.providerThreadId,
  );
  assert.isDefined(providerThread);
  assert.equal(providerThread.appThreadId, subagent.childThreadId);
  assert.isNull(providerThread.ownerNodeId);

  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  assert.equal(childProjection.thread.lineage.parentThreadId, projection.thread.id);
  assert.equal(childProjection.thread.lineage.relationshipToParent, "subagent");
  assert.equal(childProjection.thread.activeProviderThreadId, providerThread.id);
  assert.lengthOf(childProjection.runs, 0);
  assert.lengthOf(childProjection.providerThreads, 1);
  assert.lengthOf(childProjection.providerTurns, 1);
  assertTurnItemTypes(childProjection, ["assistant_message"]);
  assert.isTrue(
    childProjection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text.includes("Hello."),
    ),
    "child thread must contain the post-root subagent response",
  );
  assert.equal(childProjection.providerTurns[0]?.status, "completed");
}
