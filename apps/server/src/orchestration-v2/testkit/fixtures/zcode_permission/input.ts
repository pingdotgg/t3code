import type { OrchestratorFixtureInput } from "../shared.ts";

const ZCODE_PERMISSION_APPROVED_FILE = "zcode-approved.txt";
export const ZCODE_PERMISSION_DECLINED_FILE = "zcode-declined.txt";

/**
 * A Supervised ZCode thread runs in ZCode's `build` mode, which asks before
 * writes and commands. The write is approved and lands; the command is
 * declined, so it never runs and ZCode reports the rejection.
 */
export function zcodePermissionInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      {
        type: "message",
        text: `Use your file write tool once to create ${ZCODE_PERMISSION_APPROVED_FILE} containing exactly: approved. Do not read files or use the shell. Then reply exactly: DONE`,
      },
      { type: "approve_next_runtime_request" },
      {
        type: "message",
        text: `Run the shell command \`touch ${ZCODE_PERMISSION_DECLINED_FILE}\` once. If it is rejected, do not retry or use another tool; reply exactly: REJECTED`,
      },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  };
}
