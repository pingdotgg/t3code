import type { OrchestratorFixtureInput } from "../shared.ts";

export const MUSE_PERMISSION_APPROVED_FILE = "muse-approved.txt";
export const MUSE_PERMISSION_DECLINED_FILE = "muse-declined.txt";

export function musePermissionInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      {
        type: "message",
        text: `Run the shell command \`touch ${MUSE_PERMISSION_APPROVED_FILE}\` with your shell tool, then reply DONE.`,
      },
      { type: "approve_next_runtime_request" },
      {
        type: "message",
        text: `Run the shell command \`touch ${MUSE_PERMISSION_DECLINED_FILE}\` with your shell tool once. If it is rejected, do not retry; reply REJECTED.`,
      },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  };
}
