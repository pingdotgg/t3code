import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MESSAGE_STEERING_MID_TOOL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertClaudeMessageSteeringMidToolOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assert.equal(transcript.provider, "claudeAgent");
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_MID_TOOL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  // The steer lands while the Bash tool is running, so the CLI queues it and
  // ends the native turn with terminal_reason "aborted_tools" before answering.
  // That result must not settle the run: the answer arrives afterwards and
  // belongs to the run that carries the steer.
  assertAssistantTextIncludes(projection, "steering fixture observed");
  assert.equal(projection.runs.length, 1, "a mid-tool steer must not open a second run");
  assert.equal(
    projection.providerTurns.length,
    1,
    "a mid-tool steer must not create a new provider turn",
  );
}
