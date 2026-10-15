import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// Claude's failed cycle fails its continuation run with the agent's error,
// not completes it.
export function assertAcpClaudeFailedContinuationOutput(
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
  const cycleMessage = projection.messages.find(
    (message) => message.id === cycleRun?.userMessageId,
  );
  assert.equal(`${cycleMessage?.createdBy}:${cycleMessage?.creationSource}`, "agent:provider");
  const errorItem = projection.turnItems.find(
    (item) => item.runId === cycleRun?.id && item.type === "error",
  );
  if (errorItem?.type !== "error") throw new Error("expected the cycle's error item");
  assert.equal(errorItem.failure.message, "API Error: 529 overloaded");
  assert.equal(errorItem.failure.code, "-32603");
  assert.deepEqual(
    projection.messages.flatMap((message) =>
      message.runId === cycleRun?.id && message.role === "assistant"
        ? [`${message.text}:${message.streaming}`]
        : [],
    ),
    ["Reporting the result.:false"],
  );
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["completed"],
  );
}
