import type { OrchestratorFixtureInput } from "../shared.ts";

export const ACP_REGISTRY_COMPACTION_SUMMARY = "Retained the fixture decisions.";

/**
 * A registry agent gets one normal turn, then a bare `/compact`: the message
 * the Compact context action sends, or a user, MCP tool or schedule types.
 */
export function acpRegistryCompactionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: "Respond with exactly: compaction fixture ready" },
      { type: "message", text: "/compact" },
    ],
  };
}
