import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { CLAUDE_IDLE_RESUME_PROMPT_1, CLAUDE_IDLE_RESUME_PROMPT_2 } from "./input.ts";

export function assertClaudeIdleResumeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [CLAUDE_IDLE_RESUME_PROMPT_1, CLAUDE_IDLE_RESUME_PROMPT_2]);

  const assistantTexts = projection.turnItems.flatMap((item) =>
    item.type === "assistant_message" ? [item.text] : [],
  );
  assert.deepEqual(assistantTexts, [
    "idle resume first turn complete",
    "idle resume second turn complete",
  ]);
}
