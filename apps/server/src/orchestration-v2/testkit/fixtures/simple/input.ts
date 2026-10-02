import { SIMPLE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function simpleInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: SIMPLE_PROMPT }],
  };
}
