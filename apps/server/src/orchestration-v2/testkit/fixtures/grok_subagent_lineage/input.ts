import type { OrchestratorFixtureInput } from "../shared.ts";

export const GROK_SUBAGENT_LINEAGE_PROMPT = "audit this codebase";

export function grokSubagentLineageInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: GROK_SUBAGENT_LINEAGE_PROMPT }],
  };
}
