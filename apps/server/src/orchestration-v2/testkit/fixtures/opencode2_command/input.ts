import { OPENCODE2_COMMAND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2CommandInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: OPENCODE2_COMMAND_PROMPT }] };
}
