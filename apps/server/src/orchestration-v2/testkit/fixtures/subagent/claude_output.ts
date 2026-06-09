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
  assertExecutionNodeKinds(projection, ["root_turn", "subagent", "tool_call"]);
  assertTurnItemTypes(projection, [
    "user_message",
    "subagent",
    "dynamic_tool",
    "assistant_message",
  ]);
  assertRunProviderTurnCardinality({ projection, rootRunCount: 1 });
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertUserMessagesInclude(projection, [SUBAGENT_PROMPT]);
  assertAssistantTextIncludes(projection, "claude-read-only-fixture");
  assertAssistantTextIncludes(projection, "ES2022");

  const subagentNodes = projection.nodes.filter((node) => node.kind === "subagent");
  assert.lengthOf(subagentNodes, 2);
  assert.deepEqual(
    subagentNodes.map((node) => node.status),
    ["completed", "completed"],
  );

  assert.lengthOf(projection.subagents, 2);
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt ===
          "Read the file `package.json` in the current working directory and return its full contents." &&
        subagent.result === "Read package.json",
    ),
  );
  assert.isTrue(
    projection.subagents.some(
      (subagent) =>
        subagent.prompt ===
          "Read the file `tsconfig.json` in the current working directory and return its full contents." &&
        subagent.result === "Read tsconfig.json",
    ),
  );
  for (const subagent of projection.subagents) {
    assert.equal(subagent.origin, "provider_native");
    assert.equal(subagent.createdBy, "agent");
    assert.equal(subagent.provider, "claudeAgent");
    assert.equal(subagent.status, "completed");
    assert.isNull(subagent.providerThreadId);
    assert.isNull(subagent.childThreadId);
    assert.isNotNull(subagent.nativeTaskRef);
    assert.isNotNull(subagent.completedAt);
  }

  const subagentNodeIds = new Set(subagentNodes.map((node) => node.id));
  const nestedToolNodes = projection.nodes.filter(
    (node) =>
      node.kind === "tool_call" &&
      node.parentNodeId !== null &&
      subagentNodeIds.has(node.parentNodeId),
  );
  assert.isAtLeast(nestedToolNodes.length, 2);
}
