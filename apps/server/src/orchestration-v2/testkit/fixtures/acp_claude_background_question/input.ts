import type { OrchestratorFixtureInput } from "../shared.ts";

const ACP_CLAUDE_BACKGROUND_QUESTION_PROMPT = "Fix a file in the background.";

// Claude Agent on ACP v2. After run 1 ended, the background subagent asks the
// user a question (AskUserQuestion, a form elicitation on its child session).
// The question opens a continuation run that shows it, the user answers, and
// Claude follows up once the subagent finished.
export function acpClaudeBackgroundQuestionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_BACKGROUND_QUESTION_PROMPT },
      { type: "answer_next_user_input_request", answers: { file: "a.ts" } },
      { type: "await_run_status", targetRunIndex: 3, status: "completed" },
    ],
  };
}

// The same question, which the user stops instead of answering.
export function acpClaudeBackgroundQuestionStopInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: ACP_CLAUDE_BACKGROUND_QUESTION_PROMPT },
      {
        type: "await_run_status",
        targetRunIndex: 2,
        status: "running",
        waitForTurnItemType: "user_input_request",
      },
      { type: "interrupt", targetRunIndex: 2 },
    ],
  };
}
