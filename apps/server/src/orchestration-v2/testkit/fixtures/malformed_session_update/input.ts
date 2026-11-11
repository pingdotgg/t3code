import type { OrchestratorFixtureInput } from "../shared.ts";

export const MALFORMED_SESSION_UPDATE_PROMPT =
  "Respond with the following text: malformed update fixture ok";

export function malformedSessionUpdateInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: MALFORMED_SESSION_UPDATE_PROMPT }],
  };
}
