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
// The outer subagent's snapshots report claude-haiku-4-5-20251001, recorded as
// the catalog slug; the nested one never streams a snapshot of its own (the
// CLI's session storage shows it ran on the same).
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
  const byTask = (taskId: string) => {
    const subagent = projection.subagents.find((agent) => agent.nativeTaskRef?.nativeId === taskId);
    assert.isDefined(subagent, `missing subagent for task ${taskId}`);
    assert.equal(subagent.status, "completed");
    return subagent;
  };
  const outer = byTask(OUTER_TASK_ID);
  const nested = byTask(NESTED_TASK_ID);

  assert.equal(outer.parentNodeId, rootNodeId);
  assert.equal(outer.model, SUBAGENT_MODEL);

  // The nested Agent call appears only in the outer subagent's snapshot, so
  // only that snapshot can say who launched it and on which model.
  assert.equal(nested.parentNodeId, outer.id, "a nested subagent hangs off its owner");
  assert.equal(nested.model, SUBAGENT_MODEL, "a nested subagent runs on its owner's model");
  // The session's effort is not sent for claude-haiku-4-5, which offers none.
  const subagentSelection = { instanceId: outer.providerInstanceId, model: SUBAGENT_MODEL };
  assert.deepEqual(outer.modelSelection, subagentSelection);
  assert.deepEqual(nested.modelSelection, subagentSelection);
  const nestedNode = projection.nodes.find((node) => node.id === nested.id);
  assert.isDefined(nestedNode);
  assert.equal(nestedNode.parentNodeId, outer.id);
  assert.equal(nestedNode.rootNodeId, rootNodeId);
  assert.include(nested.result ?? "", "NESTED_LEAF_OK");

  if (nested.childThreadId === null) {
    throw new Error("nested subagent is missing its child thread");
  }
  const nestedChild = result.projections.get(nested.childThreadId);
  assert.isDefined(nestedChild);
  assert.equal(nestedChild.thread.modelSelection.model, SUBAGENT_MODEL);
}
