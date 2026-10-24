/**
 * Copy for Claude's refusal fallback dialog, shared by the server adapter
 * (which asks the question) and the web client (which rewinds the flagged
 * message when the user picks the edit answer). Both sides must agree on
 * these strings, so reword the question or the answer label here only.
 */
export const CLAUDE_REFUSAL_FALLBACK_EDIT_ANSWER = "Edit message";

const QUESTION_SUFFIX = "'s safeguards flagged this message.";

export function formatClaudeRefusalFallbackQuestion(modelName: string): string {
  return `${modelName}${QUESTION_SUFFIX}`;
}

export function isClaudeRefusalFallbackEditAnswer(question: string, answer: unknown): boolean {
  return question.endsWith(QUESTION_SUFFIX) && answer === CLAUDE_REFUSAL_FALLBACK_EDIT_ANSWER;
}
