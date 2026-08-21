import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_WORKFLOW_PROMPT =
  "Run a two-phase workflow, then answer exactly: claude workflow fixture complete";

/**
 * End-to-end cover for the Claude workflow coordinator. The adapter-level
 * projection of phases and workers is unit-tested, and the panel derivation is
 * unit-tested against synthetic agents — nothing joined the two. This drives
 * real workflow frames through the orchestrator so the coordinator, its
 * phases, and its members are asserted on the projection the client actually
 * receives, then feeds that projection to the panel derivation.
 */
export function claudeWorkflowInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_WORKFLOW_PROMPT }],
  };
}
