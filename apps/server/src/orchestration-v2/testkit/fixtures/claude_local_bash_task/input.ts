import { CLAUDE_LOCAL_BASH_TASK_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function claudeLocalBashTaskInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_LOCAL_BASH_TASK_PROMPT }],
  };
}
