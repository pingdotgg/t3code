import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertCursorMessageSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "cursor");
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_INITIAL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");

  assert.lengthOf(projection.runs, 1, "steering must preserve the app run");
  assert.deepEqual(
    projection.attempts.map((attempt) => [attempt.reason, attempt.status]),
    [
      ["initial", "superseded"],
      ["steering_restart", "completed"],
    ],
  );
  assert.deepEqual(
    projection.providerTurns.map((turn) => turn.status),
    ["interrupted", "completed"],
  );
  assert.equal(projection.runs[0]?.activeAttemptId, projection.attempts[1]?.id);
  assert.equal(projection.runs[0]?.rootNodeId, projection.attempts[1]?.rootNodeId);
  assert.isFalse(
    projection.turnItems.some(
      (item) => item.type === "run_interrupt_request" || item.type === "run_interrupt_result",
    ),
    "steer supersede must not project run_interrupt_* items (those are hard Stop only)",
  );
}
