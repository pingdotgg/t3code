import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

function questionItems(result: OrchestratorV2ScenarioResult, transcript: ProviderReplayTranscript) {
  const projection = projectionFor(result, transcript.scenario);
  return {
    projection,
    questions: projection.turnItems.flatMap((item) =>
      item.type === "user_input_request" ? [item] : [],
    ),
  };
}

// The question shows in a continuation run, which stays open until the user
// answered; the answer reaches the subagent (the transcript expects it).
export function assertAcpClaudeBackgroundQuestionOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 3,
    runStatuses: ["completed", "completed", "completed"],
  });
  const { projection, questions } = questionItems(result, transcript);
  assertSemanticProjectionIntegrity(projection);
  const [, questionRun] = projection.runs;
  assert.deepEqual(
    questions.map((item) => `${item.runId === questionRun?.id}:${item.status}`),
    ["true:completed"],
  );
  assert.deepEqual(
    projection.subagents.map((subagent) => subagent.status),
    ["completed"],
  );
}

// Stop cancels the question (the transcript expects the cancel) and ends the
// run that shows it.
export function assertAcpClaudeBackgroundQuestionStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "interrupted"],
  });
  const { projection, questions } = questionItems(result, transcript);
  assertSemanticProjectionIntegrity(projection);
  const [, questionRun] = projection.runs;
  assert.deepEqual(
    questions.map((item) => `${item.runId === questionRun?.id}:${item.status}`),
    ["true:cancelled"],
  );
}
