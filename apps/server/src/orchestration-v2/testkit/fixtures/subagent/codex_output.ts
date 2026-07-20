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
  SUBAGENT_PROMPT,
} from "../shared.ts";

export function assertSubagentOutput(
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
  assertUserMessagesInclude(projection, [SUBAGENT_PROMPT]);
  assert.equal(projection.runs.length, 1, "subagent provider turns must not become app runs");
  assert.lengthOf(
    projection.turnItems.filter((item) => item.type === "command_execution"),
    0,
    "subagent commands must not be projected into the parent thread",
  );

  assert.lengthOf(projection.subagents, 2);
  assert.lengthOf(result.shellSnapshot.threads, 3);
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["completed", "completed"],
  );
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt.includes("Read package.json only") &&
        subagent.result?.includes("Package name: `effect-codex-app-server`"),
    ),
  );
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt.includes("Read tsconfig.json only") &&
        subagent.result?.includes("`extends`: `../../tsconfig.base.json`"),
    ),
  );

  for (const subagent of projection.subagents) {
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.createdBy, "agent");
    assert.equal(subagent.driver, "codex");
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
    assertTurnItemTypes(childProjection, [
      "user_message",
      "command_execution",
      "assistant_message",
    ]);
    assertUserMessagesInclude(childProjection, [subagent.prompt]);
    assert.isTrue(
      childProjection.turnItems.some(
        (item) =>
          item.type === "assistant_message" &&
          subagent.result !== null &&
          item.text.includes(subagent.result.slice(0, 40)),
      ),
      `child thread ${subagent.childThreadId} must contain the subagent response`,
    );
  }

  const rootProviderThread = projection.providerThreads.find(
    (thread) => thread.ownerNodeId === null && thread.appThreadId === projection.thread.id,
  );
  assert.isDefined(rootProviderThread);
  assert.equal(rootProviderThread.appThreadId, projection.thread.id);
  assert.equal(projection.thread.activeProviderThreadId, rootProviderThread.id);
}
