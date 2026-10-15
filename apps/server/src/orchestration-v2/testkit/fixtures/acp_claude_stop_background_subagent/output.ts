import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// Stop closes Claude's session, which ends the subagent and its running
// command; both show ended in the subagent's thread, without a copy of that
// command in the root, and nothing the closed session sends shows.
export function assertAcpClaudeStopBackgroundSubagentOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["interrupted"],
  );
  const childThreadId = projection.subagents[0]?.childThreadId;
  const child = childThreadId == null ? undefined : result.projections.get(childThreadId);
  assert.deepEqual(
    child?.turnItems.flatMap((item) => (item.type === "dynamic_tool" ? [item.status] : [])),
    ["interrupted"],
  );
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "dynamic_tool" ? [item.title] : [])),
    [],
  );
  for (const thread of result.projections.values()) {
    assert.isFalse(thread.messages.some((message) => message.text === "AFTER_CLOSE"));
  }
  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
}
