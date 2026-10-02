import { SKILL_INVOCATION_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export const SKILL_INVOCATION_FINAL = "review skill fixture complete";

export function skillInvocationInput(): OrchestratorFixtureInput {
  return {
    workspaceFiles: {
      ".cursor/skills/review/SKILL.md": [
        "---",
        "name: review",
        "description: Review the named file for the skill invocation fixture.",
        "---",
        "Do not use any tools. Respond with exactly: review skill fixture complete",
        "",
      ].join("\n"),
    },
    steps: [{ type: "message", text: SKILL_INVOCATION_PROMPT }],
  };
}
