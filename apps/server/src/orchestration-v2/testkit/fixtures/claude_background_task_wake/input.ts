import { claudeBackgroundWakeResultLabel } from "../../../Adapters/ClaudeAdapterV2.testkit.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_TASK_WAKE_PROMPT = [
  "Live-test a background Bash wake. You must call the Bash tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) Call the Bash tool with run_in_background set to true and this exact command:",
  "   sleep 8 && echo BG_DONE",
  "2) After that tool call returns, reply with exactly STARTED and stop. Do not poll, read its output, or wait for it.",
  "3) When its completion is reported later, reply with exactly WAKE_DONE and stop.",
].join("\n");

export const CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT = "Reply with exactly: USER_REPLY";

export function claudeBackgroundTaskWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_TASK_WAKE_PROMPT },
      // The wake turn arrives after the root settled, so it waits in the wake
      // buffer until continuation run 2 drains it. The wake result is held
      // until run 2 has attached, so it settles run 2 and not an idle stream.
      {
        type: "await_run_status",
        targetRunIndex: 2,
        status: "running",
        waitForTurnItemType: "assistant_message",
      },
      { type: "release_replay_gate", label: claudeBackgroundWakeResultLabel(1) },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
      { type: "message", text: CLAUDE_BACKGROUND_TASK_WAKE_FOLLOW_UP_PROMPT },
    ],
  };
}
