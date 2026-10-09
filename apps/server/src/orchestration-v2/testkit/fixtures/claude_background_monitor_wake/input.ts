import { claudeBackgroundWakeResultLabel } from "../../../Adapters/ClaudeAdapterV2.testkit.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_BACKGROUND_MONITOR_WAKE_PROMPT = [
  "Live-test a background Monitor wake. You must call the Monitor tool before replying. Do exactly this, with no extra steps.",
  "",
  '1) Call the Monitor tool with description "Background monitor test" and this exact command:',
  "   sleep 8 && echo MONITOR_DONE",
  "2) After that tool call returns, reply with exactly STARTED and stop. Do not poll, read its output, or wait for it.",
  "3) When its completion is reported later, reply with exactly WAKE_DONE and stop.",
].join("\n");

// Same shape as claude_background_task_wake: the monitor's one event ends it,
// and that end wakes Claude after the root turn settled.
export function claudeBackgroundMonitorWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_BACKGROUND_MONITOR_WAKE_PROMPT },
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
