import { OPENCODE2_SHELL_PROJECTION_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2ShellProjectionInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE2_SHELL_PROJECTION_PROMPT }],
  };
}
