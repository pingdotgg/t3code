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
  projectionFor,
  SUBAGENT_PROMPT,
} from "../shared.ts";

export function assertCursorSubagentOutput(
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
  assertExecutionNodeKinds(projection, ["root_turn", "subagent"]);
  assertTurnItemTypes(projection, ["user_message", "subagent", "assistant_message"]);
  assertRunProviderTurnCardinality({ projection, rootRunCount: 1 });
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertUserMessagesInclude(projection, [SUBAGENT_PROMPT]);
  assertAssistantTextIncludes(projection, "cursor-read-only-fixture");
  assertAssistantTextIncludes(projection, "ES2022");

  const lifecycleItems = projection.turnItems.filter(
    (item) =>
      item.type === "reasoning" || item.type === "assistant_message" || item.type === "subagent",
  );
  assert.deepEqual(
    lifecycleItems.map((item) => item.type),
    ["reasoning", "assistant_message", "subagent", "subagent", "assistant_message"],
    "Cursor progress, subagents, and the final response must retain provider order",
  );
  const assistantMessages = lifecycleItems.filter((item) => item.type === "assistant_message");
  assert.lengthOf(assistantMessages, 2);
  assert.equal(
    assistantMessages[0]?.text,
    "Spawning two subagents in parallel to read `package.json` and `tsconfig.json`.\n",
  );
  assert.include(assistantMessages[1]?.text ?? "", "Both subagents finished.");

  assert.lengthOf(projection.subagents, 2);
  assert.lengthOf(result.shellSnapshot.threads, 3);
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["completed", "completed"],
  );

  for (const subagent of projection.subagents) {
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.createdBy, "agent");
    assert.equal(subagent.driver, "cursor");
    assert.isNull(subagent.providerThreadId);
    assert.isNotNull(subagent.childThreadId);
    assert.isNotNull(subagent.nativeTaskRef);
    assert.isNotNull(subagent.completedAt);
    assert.isNotNull(subagent.result);
    if (subagent.childThreadId === null) {
      throw new Error(`Subagent ${subagent.id} is missing its child thread`);
    }

    const childProjection = result.projections.get(subagent.childThreadId);
    assert.isDefined(childProjection);
    assert.equal(childProjection.thread.lineage.parentThreadId, projection.thread.id);
    assert.equal(childProjection.thread.lineage.relationshipToParent, "subagent");
    assert.isNull(childProjection.thread.activeProviderThreadId);
    assert.lengthOf(childProjection.runs, 0);
    assert.lengthOf(childProjection.providerThreads, 0);
    assert.lengthOf(childProjection.providerTurns, 0);
    assertExecutionNodeKinds(childProjection, ["root_turn", "tool_call"]);
    assertTurnItemTypes(childProjection, ["user_message", "file_search", "assistant_message"]);
    assertUserMessagesInclude(childProjection, [subagent.prompt]);
    assert.isTrue(
      childProjection.turnItems.some(
        (item) =>
          item.type === "assistant_message" &&
          subagent.result !== null &&
          item.text.includes(subagent.result.slice(0, 40)),
      ),
    );
  }
}
