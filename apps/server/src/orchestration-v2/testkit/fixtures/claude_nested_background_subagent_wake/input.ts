import { claudeBackgroundWakeResultLabel } from "../../../Adapters/ClaudeAdapterV2.testkit.ts";
import type { OrchestratorFixtureInput } from "../shared.ts";

// The child starts a grandchild in the background and outlives it, so the
// grandchild ends while the root is idle and only the child's end wakes it.
export const CLAUDE_NESTED_BACKGROUND_SUBAGENT_WAKE_PROMPT = [
  "Live-test a background subagent that starts its own background subagent. Do exactly this, with no extra steps.",
  "",
  '1) Use the Agent tool with subagent_type "general-purpose" and run_in_background set to true to launch ONE subagent with this prompt:',
  '   "Do exactly this. a) Use the Agent tool with subagent_type \\"general-purpose\\" and run_in_background set to true to launch ONE subagent with the prompt: Reply with exactly GRANDCHILD_DONE. b) Run this exact command with the Bash tool: sleep 20 && echo CHILD_WAITED. c) Reply with exactly CHILD_DONE."',
  "2) Immediately after launching it, reply with exactly ROOT_STARTED and stop. Do not wait for it or check on it.",
  "3) When its completion is reported, reply with exactly ROOT_WAKE_DONE and stop.",
].join("\n");

export function claudeNestedBackgroundSubagentWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_NESTED_BACKGROUND_SUBAGENT_WAKE_PROMPT },
      // Only the child's end opens continuation run 2. The wake result is
      // held until run 2 has drained the buffered wake reply.
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
