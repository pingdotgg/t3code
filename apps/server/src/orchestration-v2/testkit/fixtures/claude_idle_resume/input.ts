import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_IDLE_RESUME_PROMPT_1 = "Respond with exactly: idle resume first turn complete";
export const CLAUDE_IDLE_RESUME_PROMPT_2 = "Respond with exactly: idle resume second turn complete";

export function claudeIdleResumeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: CLAUDE_IDLE_RESUME_PROMPT_1 },
      { type: "advance_clock", duration: "31 minutes" },
      { type: "message", text: CLAUDE_IDLE_RESUME_PROMPT_2 },
    ],
  };
}
