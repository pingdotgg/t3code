import { TOOL_CALL_WRITE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function toolCallReadOnlyOnRequestInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TOOL_CALL_WRITE_PROMPT },
      { type: "approve_next_runtime_request" },
    ],
  };
}

/**
 * Kiro under an explicit approval policy runs Supervised, so after the write
 * it also asks the user to review the turn's changes.
 */
export function toolCallReadOnlyOnRequestKiroInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TOOL_CALL_WRITE_PROMPT },
      { type: "approve_next_runtime_request" },
      { type: "approve_next_runtime_request" },
    ],
  };
}
