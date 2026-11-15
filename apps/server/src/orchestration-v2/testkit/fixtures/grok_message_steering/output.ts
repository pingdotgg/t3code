import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  field,
  MESSAGE_STEERING_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";
import { GROK_MESSAGE_STEERING_PROMPT } from "./input.ts";

export function assertGrokNativeMessageSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const methods = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [String(field(entry.frame, "method"))] : [],
  );
  // Grok steers natively: one prompt, one `_x.ai/interject`, and no cancel-and-re-prompt.
  assert.deepEqual(
    ["session/prompt", "_x.ai/interject", "session/cancel"].map(
      (method) => methods.filter((candidate) => candidate === method).length,
    ),
    [1, 1, 0],
  );

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    GROK_MESSAGE_STEERING_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");
  // The steer must leave the running foreground command to finish.
  const command = projection.turnItems.find((item) => item.type === "command_execution");
  assert.include(JSON.stringify(command?.output ?? null), "FOREGROUND_DONE");
  assert.equal(
    projection.providerTurns.length,
    1,
    "active steering must not create a new provider turn",
  );
}
