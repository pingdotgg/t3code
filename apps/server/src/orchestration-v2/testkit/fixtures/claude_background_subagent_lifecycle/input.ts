import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT = [
  "Live-test background subagents. You must call the Agent tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) In one message, make TWO Agent tool calls that launch general-purpose subagents, both with run_in_background set to true:",
  '   - description "Agent A", model "haiku", prompt: "Reply with exactly: A_FIRST"',
  `   - description "Agent B", prompt: "Call the Bash tool in the foreground (run_in_background false) with this exact command and wait for it: node -e \\"setTimeout(() => console.log('B_DONE'), 90000)\\" Then reply with exactly: B_FINAL"`,
  "2) After both calls return, reply with exactly LAUNCHED and stop. Do not wait for them or check on them.",
  "3) When Agent A's completion is reported, reply with exactly A_REPORTED and stop.",
].join("\n");

export const CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT =
  "Stop Agent B now with the TaskStop tool. Then reply with exactly: B_STOPPED";

export const CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT = [
  "Use the SendMessage tool to send Agent A this message: Reply with exactly: A_SECOND",
  "Then reply with exactly RESUMED and stop. When Agent A's new completion is reported, reply with exactly A_RESUME_REPORTED and stop.",
].join("\n");

export const CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT = "Reply with exactly: ALL_DONE";

// Each wake turn reports a notification that landed during the turn before
// it, so the wake result is what starts its continuation run. Each next prompt
// waits for that run to settle, as the recording waited for the wake turn.
export function claudeBackgroundSubagentLifecycleInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_LAUNCH_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_STOP_PROMPT },
      { type: "await_run_status", targetRunIndex: 4, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_RESUME_PROMPT },
      { type: "await_run_status", targetRunIndex: 6, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_LIFECYCLE_FINAL_PROMPT },
    ],
  };
}
