import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertSemanticProjectionIntegrity,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";

/**
 * The workflow row stays live after its turn and settles when the workflow
 * does; Muse's own report turn becomes a second, completed run instead of
 * being interrupted, and nothing is left pending.
 */
export function assertMuseWorkflowOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assert.deepEqual(
    projection.runs.map((run) => run.status),
    ["completed", "completed"],
  );
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  const methods = outbound.map((frame) =>
    typeof frame === "object" && frame !== null ? Reflect.get(frame, "method") : undefined,
  );
  assert.notInclude(methods, "turn/interrupt", "Muse's report turn must not be interrupted");
  assert.equal(methods.filter((method) => method === "turn/start").length, 1);

  const workflow = projection.turnItems.find(
    (item) => item.type === "dynamic_tool" && item.toolName === "workflow",
  );
  assert.isDefined(workflow, "the workflow shows as a row");
  assert.equal(workflow.status, "completed");
  assert.equal(workflow.runId, projection.runs[0]?.id);

  const report = projection.messages.filter(
    (message) => message.role === "assistant" && message.runId === projection.runs[1]?.id,
  );
  assert.isAbove(report.length, 0, "Muse's report reaches the second run");

  // Each workflow agent is a native subagent nested under the workflow row.
  assert.lengthOf(projection.subagents, 2);
  for (const agent of projection.subagents) {
    assert.equal(agent.origin, "provider_native");
    assert.equal(agent.status, "completed");
    assert.isNull(agent.childThreadId);
  }
  const agentRows = projection.turnItems.filter((item) => item.type === "subagent");
  assert.lengthOf(agentRows, 2);
  assert.isTrue(agentRows.every((row) => row.parentItemId === workflow.id));
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
}
