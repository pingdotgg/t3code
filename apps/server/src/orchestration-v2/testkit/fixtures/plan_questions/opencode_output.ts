import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertPlanQuestionsOutputBase } from "./codex_output.ts";
import { projectionFor } from "../shared.ts";

export function assertOpenCodePlanQuestionsOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertPlanQuestionsOutputBase(result, transcript);
  const projection = projectionFor(result, transcript.scenario);
  const requestItem = projection.turnItems.find((item) => item.type === "user_input_request");
  assert.equal(requestItem?.questions[0]?.id, "question-0-schema-vs-flexibility");
  assert.equal(requestItem?.status, "completed");
  assert.lengthOf(
    projection.turnItems.filter(
      (item) => item.type === "dynamic_tool" && item.toolName === "question",
    ),
    0,
  );
}
