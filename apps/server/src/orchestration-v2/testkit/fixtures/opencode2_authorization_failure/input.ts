import type { OrchestratorFixtureInput } from "../shared.ts";

export const OPENCODE2_AUTHORIZATION_FAILURE_PROMPT = "Trigger the fixture authorization failure.";

export function openCode2AuthorizationFailureInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE2_AUTHORIZATION_FAILURE_PROMPT }],
  };
}
