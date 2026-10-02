import {
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
} from "../claude_background_subagent_lifecycle/input.ts";
import { CLAUDE_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT } from "../claude_background_wake_before_queued_prompt/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

// The same scenario recorded before prompts carried a uuid, so no frame
// echoes one: the shape a CLI that never echoes produces. The recorder of
// that time stopped at the first result after the last prompt, so the
// transcript ends before the final reply.
export function claudeBackgroundWakeBeforeQueuedPromptNoEchoInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT },
    ],
  };
}
