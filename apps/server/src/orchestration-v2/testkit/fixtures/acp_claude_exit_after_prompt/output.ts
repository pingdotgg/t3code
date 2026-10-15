import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// The run fails when the agent exits, and the reply it streamed so far closes.
export function assertAcpClaudeExitAfterPromptOutput(
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
  const [, run] = projection.runs;
  const errorItem = projection.turnItems.find(
    (item) => item.runId === run?.id && item.type === "error",
  );
  if (errorItem?.type !== "error") throw new Error("expected the run's error item");
  assert.equal(errorItem.failure.class, "transport_error");
  assert.equal(errorItem.failure.message, "The agent exited before it finished the turn.");
  assert.deepEqual(
    projection.messages.flatMap((message) =>
      message.runId === run?.id && message.role === "assistant"
        ? [`${message.text}${message.streaming ? " (streaming)" : ""}`]
        : [],
    ),
    ["The subagent finished.", "It found two stale branches."],
  );
}
