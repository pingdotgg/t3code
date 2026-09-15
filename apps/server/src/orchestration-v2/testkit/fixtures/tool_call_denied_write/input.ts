import { WORKSPACE_NEVER_POLICY, type OrchestratorFixtureInput } from "../shared.ts";

export const DENIED_WRITE_POLICY = {
  ...WORKSPACE_NEVER_POLICY,
  approvalPolicy: "on-request",
} as const;

/**
 * Workspace-relative path the recorded Write call targets. The recorder
 * verifies it stays absent around the real SDK turn and replay tests assert it
 * is never created in the scenario workspace.
 */
export const TOOL_CALL_DENIED_WRITE_TARGET = ".claude-denied-write.txt";

export const TOOL_CALL_DENIED_WRITE_PROMPT = `Use the Write tool once to create ${TOOL_CALL_DENIED_WRITE_TARGET} containing exactly: approval fixture. If permission is denied, do not retry or use another tool; reply exactly: write permission denied. Do not read any files, use the shell, network, or MCP.`;

export function toolCallDeniedWriteInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TOOL_CALL_DENIED_WRITE_PROMPT },
      { type: "approve_next_runtime_request", decision: "decline" },
    ],
  };
}
