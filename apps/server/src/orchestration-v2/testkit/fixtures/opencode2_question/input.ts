import { OPENCODE2_QUESTION_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

/** The question tool asks one question with two options; the user types their own answer. */
export function openCode2QuestionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_QUESTION_PROMPT },
      { type: "answer_next_user_input_request", answers: { q0: "blue" } },
    ],
  };
}
