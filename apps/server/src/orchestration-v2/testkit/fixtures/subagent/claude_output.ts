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

export function assertClaudeSubagentOutput(
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
  assertAssistantTextIncludes(projection, "claude-read-only-fixture");
  assertAssistantTextIncludes(projection, "ES2022");
  assert.lengthOf(
    projection.turnItems.filter((item) => item.type === "dynamic_tool"),
    0,
    "subagent tools must not be projected into the parent thread",
  );

  const subagentNodes = projection.nodes.filter((node) => node.kind === "subagent");
  assert.lengthOf(subagentNodes, 2);
  assert.deepEqual(
    subagentNodes.map((node) => node.status),
    ["completed", "completed"],
  );

  assert.lengthOf(projection.subagents, 2);
  assert.lengthOf(result.shellSnapshot.threads, 3);
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt ===
          "Read the file `package.json` in the current working directory and return its full contents." &&
        subagent.result?.includes("claude-read-only-fixture"),
    ),
  );
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt ===
          "Read the file `tsconfig.json` in the current working directory and return its full contents." &&
        subagent.result?.includes("ES2022"),
    ),
  );
  for (const subagent of projection.subagents) {
    const expectedProgress = subagent.prompt.includes("package.json")
      ? "Summarizing package.json"
      : "Reading tsconfig.json";
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.createdBy, "agent");
    assert.equal(subagent.driver, "claudeAgent");
    assert.equal(subagent.status, "completed");
    assert.equal(subagent.progress, expectedProgress);
    assert.isNull(subagent.providerThreadId);
    assert.isNotNull(subagent.childThreadId);
    assert.isNotNull(subagent.nativeTaskRef);
    assert.isNotNull(subagent.completedAt);
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
    assertTurnItemTypes(childProjection, [
      "user_message",
      "reasoning",
      "dynamic_tool",
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
    const progressItems = childProjection.turnItems.filter((item) => item.type === "reasoning");
    assert.lengthOf(
      progressItems,
      1,
      `child thread ${subagent.childThreadId} must coalesce progress into one item`,
    );
    const progressItem = progressItems[0];
    if (progressItem === undefined) {
      throw new Error(`Missing progress item for subagent ${subagent.id}`);
    }
    assert.equal(progressItem.text, expectedProgress);
    assert.equal(progressItem.status, "completed");
    assert.isFalse(progressItem.streaming);
    assert.isNotNull(progressItem.completedAt);

    const parentItem = projection.turnItems.find(
      (item) => item.type === "subagent" && item.subagentId === subagent.id,
    );
    assert.isDefined(parentItem);
    if (parentItem?.type !== "subagent") {
      throw new Error(`Missing parent lifecycle item for subagent ${subagent.id}`);
    }
    assert.equal(parentItem.progress, expectedProgress);
  }
}
