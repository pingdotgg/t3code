import { type OrchestratorFixtureInput, WEB_SEARCH_PROMPT } from "../shared.ts";

export function webSearchInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: WEB_SEARCH_PROMPT }],
  };
}
