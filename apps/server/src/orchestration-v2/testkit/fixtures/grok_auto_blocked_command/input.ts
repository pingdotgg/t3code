import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_AUTO_ROUTINE_MARKER = "grok-auto-routine-ok";
/**
 * Never exists, so approving the removal is harmless; `rm` of a non-scratch
 * home path is one Grok's classifier always holds for the user.
 */
export const GROK_AUTO_BLOCKED_PATH = "grok-auto-probe-does-not-exist";
export const GROK_AUTO_PENDING_SHELL_KEY = "grok-auto-blocked-pending";

export const GROK_AUTO_BLOCKED_COMMAND_PROMPT = [
  "This is a permission test. Run exactly these two shell commands, one at a time, each as its own tool call:",
  `1. echo ${GROK_AUTO_ROUTINE_MARKER}`,
  `2. rm -rf ~/${GROK_AUTO_BLOCKED_PATH}`,
  "The second path does not exist. Do not run anything else, then reply exactly: permission test done",
].join("\n");

/** Auto mode; the user approves the one command Grok's classifier holds. */
export function grokAutoBlockedCommandInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "auto",
    steps: [
      { type: "message", text: GROK_AUTO_BLOCKED_COMMAND_PROMPT },
      {
        type: "approve_next_runtime_request",
        shellSnapshotKeyWhilePending: GROK_AUTO_PENDING_SHELL_KEY,
      },
    ],
  };
}
