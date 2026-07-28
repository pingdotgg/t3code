import { OPENCODE_ERROR_CLEANUP_DRAIN_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCodeErrorCleanupDrainInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE_ERROR_CLEANUP_DRAIN_PROMPT }],
  };
}
