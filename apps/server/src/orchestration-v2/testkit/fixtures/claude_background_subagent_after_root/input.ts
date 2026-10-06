import { claudeBackgroundWakeResultLabel } from "../../../Adapters/ClaudeAdapterV2.testkit.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT = [
  "Live-test a background subagent that keeps working after your turn ends. Do exactly this, with no extra steps.",
  "",
  "1) Use the Agent tool with run_in_background set to true to launch ONE general-purpose subagent with this prompt:",
  '   "Do 2 steps. Before each step, write exactly one line: SUB_STEP_N (N = 1, then 2). Then run this exact command with the Bash tool: sleep 3 && echo SUB_DONE_N. After both steps, reply with exactly: SUB_FINAL_REPORT"',
  "2) Immediately after launching it, reply with exactly ROOT_STARTED and stop. Do not wait for it or check on it.",
  "3) When its completion is reported, reply with exactly ROOT_WAKE_DONE and stop.",
].join("\n");

export function claudeBackgroundSubagentAfterRootInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_SUBAGENT_AFTER_ROOT_PROMPT },
      // The subagent's frames all arrive after the root settles, so they wait
      // in the wake buffer; its completion starts continuation run 2, which
      // drains them. The wake result is held until run 2 has drained the
      // buffered wake reply, so the recording cannot end the session first.
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
