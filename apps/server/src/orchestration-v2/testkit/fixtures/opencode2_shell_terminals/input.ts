import {
  OPENCODE2_SHELL_DELETION_PROMPT,
  OPENCODE2_SHELL_FAILURE_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function openCode2ShellTerminalsInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_SHELL_FAILURE_PROMPT },
      { type: "message", text: OPENCODE2_SHELL_DELETION_PROMPT },
    ],
  };
}
