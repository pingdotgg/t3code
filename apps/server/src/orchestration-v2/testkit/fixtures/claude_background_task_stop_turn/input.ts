import { claudeBackgroundWakeResultLabel } from "../../../Adapters/ClaudeAdapterV2.testkit.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_TASK_STOP_TURN_PROMPT = [
  "Live-test stopping a turn that owns background work. You must make two Bash tool calls, one after the other. Do exactly this, with no extra steps.",
  "",
  "1) Call the Bash tool with run_in_background set to true and this exact command:",
  "   sleep 20 && echo BG_STOP_TURN_DONE",
  "2) After that call returns, call the Bash tool again in the foreground (run_in_background false) with this exact command and wait for it:",
  `   node -e "setTimeout(() => console.log('FG_DONE'), 60000)"`,
  "3) After it finishes, reply with exactly FINISHED.",
  "4) When the background command's completion is reported later, reply with exactly WAKE_DONE and stop.",
].join("\n");

/**
 * The composer's Stop lands on the foreground command. Claude ends the turn
 * and keeps its process, so the background command finishes and wakes the
 * thread into continuation run 2.
 */
export function claudeBackgroundTaskStopTurnInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_TASK_STOP_TURN_PROMPT },
      {
        type: "interrupt",
        targetRunIndex: 1,
        waitForTurnItemType: "command_execution",
        scope: "turn",
      },
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
