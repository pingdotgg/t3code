import type { OrchestratorFixtureInput } from "../shared.ts";

const KIRO_PERMISSION_FILE = "kiro-permission-probe.txt";
const KIRO_PERMISSION_CONTENT = "kiro permission probe";
export const KIRO_PERMISSION_PROMPT = [
  `Create a file named ${KIRO_PERMISSION_FILE} in the current workspace containing exactly: ${KIRO_PERMISSION_CONTENT}`,
  "Use one file write tool call and nothing else, then reply exactly: kiro permission done",
].join("\n");

/**
 * Supervised: the user approves the write, then accepts it again in Kiro's
 * own end-of-turn "Review changes", which Kiro asks only with Autopilot off.
 */
export function kiroSupervisedWriteInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: KIRO_PERMISSION_PROMPT },
      { type: "approve_next_runtime_request" },
      { type: "approve_next_runtime_request" },
    ],
  };
}

/** Full access: Kiro still asks before the write; T3 answers it by policy, never the user. */
export function kiroFullAccessWriteInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "full-access",
    steps: [{ type: "message", text: KIRO_PERMISSION_PROMPT }],
  };
}
