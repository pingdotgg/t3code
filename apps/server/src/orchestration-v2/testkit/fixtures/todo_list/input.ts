import { TODO_LIST_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function todoListInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: TODO_LIST_PROMPT }],
  };
}
