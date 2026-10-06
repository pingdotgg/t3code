import {
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT,
  CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT,
} from "../claude_background_subagent_lifecycle/input.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

// Agent B's wait outlives the stop prompt, so its "stopped" notification
// lands during the stop turn and queues a wake turn in the CLI. The resume
// prompt is sent as soon as the stop turn settles, and the CLI runs the
// queued wake turn before it.
export const CLAUDE_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT = [
  "Live-test background subagents. You must call the Agent tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) In one message, make TWO Agent tool calls that launch general-purpose subagents, both with run_in_background set to true:",
  '   - description "Agent A", model "haiku", prompt: "Reply with exactly: A_FIRST"',
  '   - description "Agent B", prompt: "Run this exact command with the Bash tool: sleep 60 && echo B_DONE. Then reply with exactly: B_FINAL"',
  "2) After both calls return, reply with exactly LAUNCHED and stop. Do not wait for them or check on them.",
  "3) When Agent A's completion is reported, reply with exactly A_REPORTED and stop.",
].join("\n");

export function claudeBackgroundWakeBeforeQueuedPromptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_WAKE_BEFORE_QUEUED_PROMPT_LAUNCH_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT },
      // Sent as soon as the thread is idle, as in the recording, so it
      // reaches the CLI while the stop notification's wake turn is queued.
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT },
    ],
  };
}
