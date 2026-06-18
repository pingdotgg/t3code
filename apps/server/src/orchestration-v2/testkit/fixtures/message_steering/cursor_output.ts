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
  assertTurnItemTypes(projection, ["user_message", "run_interrupt_result", "assistant_message"]);
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
  assert.notInclude(
    projection.visibleTurnItems.map((row) => row.item.type),
    "run_interrupt_result",
    "restart steering must keep its internal interruption out of visible chat history",
  );
}
