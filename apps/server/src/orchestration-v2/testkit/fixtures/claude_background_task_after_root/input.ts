import { claudeBackgroundWakeResultLabel } from "../../../Adapters/ClaudeAdapterV2.testkit.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT = [
  "Live-test post-settle background Bash wake. Do exactly this in order, with no extra steps.",
  "",
  "1) Run this exact command using the Bash tool with run_in_background set to true:",
  "   sleep 25 && echo L2_BG_DONE",
  "2) Immediately after starting it, reply with a short message containing exactly L2_STARTED and stop.",
  "3) Do NOT poll TaskOutput. Do NOT wait for the task. Do not spawn subagents or monitors.",
  "4) If its completion is reported later, acknowledge it once by replying with exactly L2_WAKE: L2_BG_DONE and stop.",
  "",
  "The point is that your first turn ends while the command is still running.",
].join("\n");

export function claudeBackgroundTaskAfterRootInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_TASK_AFTER_ROOT_PROMPT },
      { type: "await_run_status", targetRunIndex: 1, status: "completed" },
      { type: "release_replay_gate", label: "background_tasks_changed:empty" },
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
