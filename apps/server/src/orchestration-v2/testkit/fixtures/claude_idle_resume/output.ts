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
  // The transcript itself enforces the regression: query.open:2 expects a
  // `resume`-style open. A create-style reopen (the bug) fails the replay at
  // the boundary before these assertions run. Both runs must complete — the
  // pre-fix behavior burned the first post-idle message as a failed run.
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
