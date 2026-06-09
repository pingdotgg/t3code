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
    providerTurnCountAtLeast: 3,
    runStatuses: ["completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message", "subagent", "assistant_message"]);
  assertExecutionNodeKinds(projection, ["root_turn", "subagent"]);
  assertRunProviderTurnCardinality({ projection, rootRunCount: 1, providerTurnCountAtLeast: 3 });
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertUserMessagesInclude(projection, [SUBAGENT_PROMPT]);
  assert.equal(projection.runs.length, 1, "subagent provider turns must not become app runs");

  assert.lengthOf(projection.subagents, 2);
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
    assert.equal(subagent.provider, "codex");
    assert.isNull(subagent.childThreadId);
    assert.isNotNull(subagent.providerThreadId);
    assert.isNotNull(subagent.nativeTaskRef);
    assert.isNotNull(subagent.completedAt);

    const providerThread = projection.providerThreads.find(
      (thread) => thread.id === subagent.providerThreadId,
    );
    assert.isDefined(providerThread);
    assert.isNull(providerThread.appThreadId);
    assert.equal(providerThread.ownerNodeId, subagent.id);
  }

  const rootProviderThread = projection.providerThreads.find(
    (thread) => thread.ownerNodeId === null,
  );
  assert.isDefined(rootProviderThread);
  assert.equal(rootProviderThread.appThreadId, projection.thread.id);
  assert.equal(projection.thread.activeProviderThreadId, rootProviderThread.id);
}
