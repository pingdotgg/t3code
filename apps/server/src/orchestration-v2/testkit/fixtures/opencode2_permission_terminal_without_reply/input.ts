import { SIMPLE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2PermissionTerminalWithoutReplyInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: SIMPLE_PROMPT }] };
}
