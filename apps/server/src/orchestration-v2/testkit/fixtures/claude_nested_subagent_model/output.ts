import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

const OUTER_TASK_ID = "a457ca677bc1ecd82";
const NESTED_TASK_ID = "aac1d7a2af5371c7d";
const SUBAGENT_MODEL = "claude-haiku-4-5";

export function assertClaudeNestedSubagentModelOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertAssistantTextIncludes(projection, "NESTED_LEAF_OK");
  assert.lengthOf(result.shellSnapshot.threads, 3);

  const rootNodeId = projection.runs[0]?.rootNodeId;
  assert.isDefined(rootNodeId);
  const byTask = (owner: typeof projection, taskId: string) => {
    const subagent = owner.subagents.find((agent) => agent.nativeTaskRef?.nativeId === taskId);
    assert.isDefined(subagent, `missing subagent for task ${taskId}`);
    assert.equal(subagent.status, "completed");
    return subagent;
  };
  const outer = byTask(projection, OUTER_TASK_ID);
  if (outer.childThreadId === null) {
    throw new Error("outer subagent is missing its child thread");
  }
  const outerChild = result.projections.get(outer.childThreadId);
  assert.isDefined(outerChild);
  const nested = byTask(outerChild, NESTED_TASK_ID);
  assert.isUndefined(
    projection.subagents.find((agent) => agent.id === nested.id),
    "a nested subagent belongs to its owner's thread, not the root",
  );

  assert.equal(outer.parentNodeId, rootNodeId);
  assert.equal(outer.model, SUBAGENT_MODEL);

  assert.equal(nested.threadId, outer.childThreadId, "a nested subagent hangs off its owner");
  assert.equal(nested.runId, projection.runs[0]?.id, "the root run executes it");
  assert.equal(nested.executionThreadId, projection.thread.id);
  assert.equal(nested.model, SUBAGENT_MODEL, "a nested subagent runs on its owner's model");
  const subagentSelection = { instanceId: outer.providerInstanceId, model: SUBAGENT_MODEL };
  assert.deepEqual(outer.modelSelection, subagentSelection);
  assert.deepEqual(nested.modelSelection, subagentSelection);
  const nestedNode = outerChild.nodes.find((node) => node.id === nested.id);
  assert.isDefined(nestedNode);
  assert.equal(nestedNode.parentNodeId, nested.parentNodeId);
  assert.isNull(nestedNode.runId, "the owner's thread has no runs");
  assert.equal(outerChild.nodes.find((node) => node.id === nested.parentNodeId)?.kind, "root_turn");
  assert.include(nested.result ?? "", "NESTED_LEAF_OK");

  if (nested.childThreadId === null) {
    throw new Error("nested subagent is missing its child thread");
  }
  const nestedChild = result.projections.get(nested.childThreadId);
  assert.isDefined(nestedChild);
  assert.equal(nestedChild.thread.modelSelection.model, SUBAGENT_MODEL);
  assert.equal(nestedChild.thread.lineage.parentThreadId, outer.childThreadId);

  // The result counts only the root; the process ledger adds both subagents' work once.
  assert.lengthOf(projection.providerTurns, 1);
  assert.deepInclude(projection.providerTurns[0]?.turnTokenUsage, {
    usageStatus: "complete",
    hasSubagents: true,
    inputTokens: 74_167,
    outputTokens: 236,
    reasoningTokens: 30,
    models: ["claude-sonnet-4-6"],
    otherUsage: { inputTokens: 87_409, outputTokens: 335 },
  });
}
