import { type OrchestratorFixtureInput } from "../shared.ts";

const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";

export function simpleInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: SIMPLE_PROMPT }],
  };
}
