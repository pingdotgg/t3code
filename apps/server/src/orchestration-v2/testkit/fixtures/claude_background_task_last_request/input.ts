import { claudeBackgroundWakeResultLabel } from "../../../Adapters/ClaudeAdapterV2.testkit.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

// The command ends while Claude writes its final reply, so no later request carries its
// notification and Claude answers it in a turn of its own.
export const CLAUDE_BACKGROUND_TASK_LAST_REQUEST_PROMPT = [
  "Live-test a background Bash wake that finishes while you write your reply. You must call the Bash tool before replying. Do exactly this, with no extra steps.",
  "",
  "1) Call the Bash tool with run_in_background set to true and this exact command:",
  "   sleep 4 && echo BG_DONE",
  "2) After that tool call returns, call no more tools. Reply with the numbers from one to two hundred written out as English words, one per line, and nothing else.",
  "3) When its completion is reported later, reply with exactly WAKE_DONE and stop.",
].join("\n");

export function claudeBackgroundTaskLastRequestInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_TASK_LAST_REQUEST_PROMPT },
      {
        type: "await_run_status",
        targetRunIndex: 2,
        status: "running",
        waitForTurnItemType: "assistant_message",
      },
      { type: "release_replay_gate", label: claudeBackgroundWakeResultLabel(1) },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
