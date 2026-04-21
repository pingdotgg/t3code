import { type OrchestratorFixtureInput } from "../shared.ts";

const SUBAGENT_PROMPT = "Spawn 2 subagents, one to read package.json and one to read tsconfig.json";

export function subagentInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: SUBAGENT_PROMPT }],
  };
}
