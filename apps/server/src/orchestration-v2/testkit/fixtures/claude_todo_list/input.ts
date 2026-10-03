import { CLAUDE_MODEL_SELECTION, type OrchestratorFixtureInput } from "../shared.ts";

export const CLAUDE_TODO_LIST_PROMPT =
  "Use TaskCreate to track exactly three tasks: inspect package.json, inspect tsconfig.json, report completion. Use TaskUpdate to mark each task in_progress when you start it and completed when you finish it. Read package.json and tsconfig.json, then answer exactly: claude todo list fixture complete";

// Task tools replace TodoWrite on Claude 5 models only.
export const CLAUDE_TODO_LIST_MODEL_SELECTION = {
  ...CLAUDE_MODEL_SELECTION,
  model: "claude-sonnet-5-5",
};

export function claudeTodoListInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_TODO_LIST_PROMPT }],
  };
}
