import {
  SUBAGENT_V2_PROMPT,
  SUBAGENT_V2_NESTED_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function subagentV2Input(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: SUBAGENT_V2_PROMPT }],
  };
}

export function subagentV2NestedInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: SUBAGENT_V2_NESTED_PROMPT }],
  };
}
