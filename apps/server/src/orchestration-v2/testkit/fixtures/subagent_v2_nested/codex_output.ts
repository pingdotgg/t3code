import { assert } from "@effect/vitest";
import type {
  OrchestrationV2ThreadProjection,
  ProviderReplayTranscript,
  ThreadId,
} from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertRunProviderTurnCardinality,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  projectionFor,
  SUBAGENT_V2_NESTED_PROMPT,
} from "../shared.ts";

function projectionById(
  result: OrchestratorV2ScenarioResult,
  threadId: ThreadId,
): OrchestrationV2ThreadProjection {
  const projection = result.projections.get(threadId);
  assert.isDefined(projection, `missing projection for ${threadId}`);
  return projection;
}

/**
 * Codex names each v2 agent by its path from the root. The model picks the
 * leaf names, so the check is that each path extends its parent's by one segment.
 */
function assertCompletedProviderNativeSubagent(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly parentPath: string;
  readonly result: string;
}) {
  assert.lengthOf(input.projection.subagents, 1);
  assert.lengthOf(
    input.projection.turnItems.filter((item) => item.type === "subagent"),
    1,
    `${input.projection.thread.id} must only render its direct subagent`,
  );

  const subagent = input.projection.subagents[0]!;
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.createdBy, "agent");
  assert.equal(subagent.driver, "codex");
  assert.match(subagent.title ?? "", new RegExp(`^${input.parentPath}/[^/]+$`, "u"));
  assert.equal(subagent.status, "completed");
  assert.equal(subagent.result, input.result);
  assert.isNotNull(subagent.childThreadId);
  assert.isNotNull(subagent.providerThreadId);
  assert.isNotNull(subagent.nativeTaskRef);
  assert.isNotNull(subagent.completedAt);
  return subagent;
}

export function assertSubagentV2NestedOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 1,
    runStatuses: ["completed"],
  });

  const rootProjection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(rootProjection);
  assertTurnItemTypes(rootProjection, ["user_message", "subagent", "assistant_message"]);
  assertRunProviderTurnCardinality({ projection: rootProjection, rootRunCount: 1 });
  assertNoExtraAppRunsForProviderChildren({ projection: rootProjection, expectedAppRuns: 1 });
  assertUserMessagesInclude(rootProjection, [SUBAGENT_V2_NESTED_PROMPT]);
  assert.lengthOf(result.shellSnapshot.threads, 4);

  const first = assertCompletedProviderNativeSubagent({
    projection: rootProjection,
    parentPath: "/root",
    result: "Hello.",
  });
  if (first.childThreadId === null) {
    throw new Error("first nested fixture subagent is missing its child thread");
  }

  const firstProjection = projectionById(result, first.childThreadId);
  assert.equal(firstProjection.thread.lineage.parentThreadId, rootProjection.thread.id);
  assert.equal(firstProjection.thread.lineage.relationshipToParent, "subagent");
  assert.equal(firstProjection.thread.lineage.rootThreadId, rootProjection.thread.id);
  assert.lengthOf(firstProjection.runs, 0);
  assert.lengthOf(firstProjection.providerTurns, 1);
  assertTurnItemTypes(firstProjection, ["subagent", "assistant_message"]);

  const second = assertCompletedProviderNativeSubagent({
    projection: firstProjection,
    parentPath: first.title ?? "",
    result: "Hello.",
  });
  if (second.childThreadId === null) {
    throw new Error("second nested fixture subagent is missing its child thread");
  }

  const secondProjection = projectionById(result, second.childThreadId);
  assert.equal(secondProjection.thread.lineage.parentThreadId, firstProjection.thread.id);
  assert.equal(secondProjection.thread.lineage.relationshipToParent, "subagent");
  assert.equal(secondProjection.thread.lineage.rootThreadId, rootProjection.thread.id);
  assert.lengthOf(secondProjection.runs, 0);
  assert.lengthOf(secondProjection.providerTurns, 1);
  assertTurnItemTypes(secondProjection, ["subagent", "assistant_message"]);

  const third = assertCompletedProviderNativeSubagent({
    projection: secondProjection,
    parentPath: second.title ?? "",
    result: "Hello.",
  });
  if (third.childThreadId === null) {
    throw new Error("third nested fixture subagent is missing its child thread");
  }

  const thirdProjection = projectionById(result, third.childThreadId);
  assert.equal(thirdProjection.thread.lineage.parentThreadId, secondProjection.thread.id);
  assert.equal(thirdProjection.thread.lineage.relationshipToParent, "subagent");
  assert.equal(thirdProjection.thread.lineage.rootThreadId, rootProjection.thread.id);
  assert.lengthOf(thirdProjection.runs, 0);
  assert.lengthOf(thirdProjection.providerTurns, 1);
  assert.lengthOf(thirdProjection.subagents, 0);
  assertTurnItemTypes(thirdProjection, ["assistant_message"]);
  assert.isTrue(
    thirdProjection.turnItems.some(
      (item) => item.type === "assistant_message" && item.text === "Hello.",
    ),
    "leaf child thread must contain the final assistant message",
  );
}
