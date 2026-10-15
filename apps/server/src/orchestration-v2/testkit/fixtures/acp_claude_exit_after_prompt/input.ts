import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_EXIT_FIRST_PROMPT = "Start a background subagent that waits.";
const ACP_CLAUDE_EXIT_SECOND_PROMPT = "Summarize what it found.";

// Claude Agent on ACP v2. The second prompt reaches Claude while its own cycle
// runs, so that cycle's idle already answers the prompt request. Claude then
// takes the prompt in, starts answering, and its process exits. No idle
// follows, so only the exit can end run 2.
export function acpClaudeExitAfterPromptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_EXIT_FIRST_PROMPT },
      { type: "message", text: ACP_CLAUDE_EXIT_SECOND_PROMPT },
    ],
  };
}
