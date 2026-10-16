import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertSemanticProjectionIntegrity,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";

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
  const finalSummary = transcript.entries
    .map((entry) =>
      entry.type === "emit_inbound"
        ? Reflect.get(Reflect.get(Object(entry.frame).params ?? {}, "item") ?? {}, "finalSummary")
        : undefined,
    )
    .findLast((summary) => typeof summary === "string");
  assert.isString(finalSummary, "Muse reports the workflow's result");
  assert.equal(workflow.type === "dynamic_tool" ? workflow.output : undefined, finalSummary);

  const report = projection.messages.filter(
    (message) => message.role === "assistant" && message.runId === projection.runs[1]?.id,
  );
  assert.isAbove(report.length, 0, "Muse's report reaches the second run");

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
