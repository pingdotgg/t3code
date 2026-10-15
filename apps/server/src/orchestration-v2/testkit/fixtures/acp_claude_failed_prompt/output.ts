import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

// The run fails with the agent's error and closes its open tool and reply.
export function assertAcpClaudeFailedPromptOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["failed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const errorItem = projection.turnItems.find((item) => item.type === "error");
  if (errorItem?.type !== "error") throw new Error("expected the run's error item");
  assert.deepEqual(
    { class: errorItem.failure.class, code: errorItem.failure.code },
    { class: "provider_error", code: "-32000" },
  );
  assert.equal(errorItem.failure.message, "Please sign in to Claude");
  assert.deepEqual(
    projection.turnItems.flatMap((item) => (item.type === "dynamic_tool" ? [item.status] : [])),
    ["interrupted"],
  );
  assert.deepEqual(
    projection.messages.flatMap((message) =>
      message.role === "assistant" ? [`${message.text}:${message.streaming}`] : [],
    ),
    ["Checking your account.:false"],
  );
}
