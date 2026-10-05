import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypeSequence,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  OPENCODE2_QUESTION_PROMPT,
  projectionFor,
} from "../shared.ts";

/**
 * The question tool's form is a user input request with the model's options and
 * a free-form answer; the answer goes back to OpenCode and the turn uses it.
 */
export function assertOpenCode2QuestionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [OPENCODE2_QUESTION_PROMPT]);
  // The form is the item; OpenCode's own `question` tool call is not repeated.
  assertTurnItemTypeSequence(projection, [
    "user_message",
    "assistant_message",
    "user_input_request",
    "assistant_message",
    "checkpoint",
  ]);
  assertAssistantTextIncludes(projection, "blue");

  const [request] = projection.runtimeRequests;
  assert.lengthOf(projection.runtimeRequests, 1);
  assert.deepInclude(request, { kind: "user_input", status: "resolved" });
  assert.deepEqual(request?.answers, { q0: "blue" });

  const item = projection.turnItems.find((candidate) => candidate.type === "user_input_request");
  assert.equal(item?.status, "completed");
  assert.deepEqual(item?.type === "user_input_request" ? item.questions : [], [
    {
      id: "q0",
      header: "Color preference",
      question: "Which color do you prefer?",
      options: [
        { label: "Red", description: "Choose the color red", value: "Red" },
        { label: "Blue", description: "Choose the color blue", value: "Blue" },
      ],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ]);
}
