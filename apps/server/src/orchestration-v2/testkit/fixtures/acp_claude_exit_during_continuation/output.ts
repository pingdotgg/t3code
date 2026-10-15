import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// The exit fails Claude's own cycle and closes its reply, its tool, and the
// running subagent with its own tool.
export function assertAcpClaudeExitDuringContinuationOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "failed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const [, cycleRun] = projection.runs;
  const errorItem = projection.turnItems.find(
    (item) => item.runId === cycleRun?.id && item.type === "error",
  );
  if (errorItem?.type !== "error") throw new Error("expected the run's error item");
  assert.equal(errorItem.failure.class, "transport_error");
  assert.equal(errorItem.failure.message, "The agent exited before it finished the turn.");
  const cycleMessage = projection.messages.find(
    (message) => message.id === cycleRun?.userMessageId,
  );
  assert.equal(`${cycleMessage?.createdBy}:${cycleMessage?.creationSource}`, "agent:provider");
  assert.deepEqual(
    projection.messages.flatMap((message) =>
      message.runId === cycleRun?.id && message.role === "assistant"
        ? [`${message.text}${message.streaming ? " (streaming)" : ""}`]
        : [],
    ),
    ["Checking on the subagent.", "It is still waiting."],
  );

  // The tool it was running and the background subagent ended with the
  // process, so neither stays running.
  assert.deepEqual(
    projection.turnItems.flatMap((item) =>
      item.runId === cycleRun?.id && item.type === "dynamic_tool" ? [item.status] : [],
    ),
    ["interrupted"],
  );
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["interrupted"],
  );
  // The subagent's own tool, started before Claude's cycle took the subagent
  // over, ends in the subagent's thread and shows nowhere else.
  const childThreadId = projection.subagents[0]?.childThreadId;
  const child = childThreadId == null ? undefined : result.projections.get(childThreadId);
  assert.deepEqual(
    child?.turnItems.flatMap((item) => (item.type === "dynamic_tool" ? [item.status] : [])),
    ["interrupted"],
  );
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "dynamic_tool" ? [item.title] : [])),
    ["Read notes.md"],
  );
}
