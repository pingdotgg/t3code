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
import { KIRO_MESSAGE_STEERING_PROMPT } from "./input.ts";

export function assertKiroMessageSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const methods = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [String(field(entry.frame, "method"))] : [],
  );
  // Kiro steers natively: one prompt, one `_session/steer`, and no cancel-and-re-prompt.
  assert.deepEqual(
    ["session/prompt", "_session/steer", "session/cancel"].map(
      (method) => methods.filter((candidate) => candidate === method).length,
    ),
    [1, 1, 0],
  );

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [
    KIRO_MESSAGE_STEERING_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");
  // Kiro's model appends a `[STEERING steer-…]` note for Kiro's own UI; T3 drops it.
  assert.notInclude(
    projection.turnItems
      .map((item) => (item.type === "assistant_message" ? item.text : ""))
      .join(""),
    "[STEERING",
  );
  assert.equal(
    projection.providerTurns.length,
    1,
    "active steering must not create a new provider turn",
  );
}
