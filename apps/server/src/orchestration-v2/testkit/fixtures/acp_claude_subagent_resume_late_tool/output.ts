import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// The run that resumed the subagent takes over the tool its child left open,
// so the tool's late completion still reaches the child thread, once.
export function assertAcpClaudeSubagentResumeLateToolOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const resumingRun = projection.runs[1];
  const [subagent] = projection.subagents;
  assert.deepEqual(
    [projection.subagents.length, subagent?.status, subagent?.runId],
    [1, "completed", resumingRun?.id],
  );
  const childThreadId = subagent?.childThreadId;
  const child = childThreadId == null ? undefined : result.projections.get(childThreadId);
  assert.deepEqual(
    child?.turnItems.flatMap((item) =>
      item.type === "assistant_message" || item.type === "user_message"
        ? [`${item.type}:${item.text}`]
        : item.type === "dynamic_tool"
          ? [`${item.type}:${item.status}`]
          : [],
    ),
    [
      "user_message:Find the flaky test.",
      "dynamic_tool:completed",
      "assistant_message:Found it: retry.test.ts",
      "user_message:Now fix it.",
      "assistant_message:Fixed retry.test.ts",
    ],
  );
  const toolCompletions = result.domainEvents.filter(
    (event) =>
      event.type === "turn-item.updated" &&
      event.payload.threadId === childThreadId &&
      event.payload.type === "dynamic_tool" &&
      event.payload.status === "completed",
  );
  assert.lengthOf(toolCompletions, 1);
}
