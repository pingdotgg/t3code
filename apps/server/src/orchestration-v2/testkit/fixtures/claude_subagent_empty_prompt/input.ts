import type { OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_SUBAGENT_EMPTY_PROMPT_ROOT_PROMPT = [
  "Launch two subagents with the Agent tool. Give the first one a blank prompt.",
  "Let the second report progress before its prompt is known.",
].join(" ");

/** The whitespace-only prompt the first Agent launch carries. */
export const CLAUDE_SUBAGENT_EMPTY_PROMPT_BLANK_PROMPT = " ";

/** Arrives on task_started only after task_progress already registered the child. */
export const CLAUDE_SUBAGENT_EMPTY_PROMPT_LATE_PROMPT =
  "Read the file `tsconfig.json` in the current working directory and return its full contents.";

export function claudeSubagentEmptyPromptInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_SUBAGENT_EMPTY_PROMPT_ROOT_PROMPT }],
  };
}
