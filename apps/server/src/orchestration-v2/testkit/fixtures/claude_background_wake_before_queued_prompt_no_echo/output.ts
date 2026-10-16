import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertSemanticProjectionIntegrity, projectionFor } from "../shared.ts";
import {
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
} from "../claude_background_subagent_lifecycle/input.ts";

export function assertClaudeBackgroundWakeBeforeQueuedPromptNoEchoOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  const repliesFor = (text: string) => {
    const run = projection.runs.find(
      (candidate) =>
        projection.messages.find((message) => message.id === candidate.userMessageId)?.text ===
        text,
    );
    return projection.turnItems.flatMap((item) =>
      item.runId === run?.id && item.type === "assistant_message" ? [item.text.trim()] : [],
    );
  };
  assert.deepEqual(repliesFor(CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT), ["B_STOPPED"]);
  assert.deepEqual(repliesFor(CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT), [
    "Agent B has been confirmed killed.",
  ]);
  assert.isTrue(projection.runs.every((run) => run.status === "completed"));
}
