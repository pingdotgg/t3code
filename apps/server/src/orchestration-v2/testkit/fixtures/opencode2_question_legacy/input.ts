import { PLAN_QUESTIONS_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2QuestionLegacyInput(): OrchestratorFixtureInput {
  return {
    interactionMode: "plan",
    steps: [
      { type: "message", text: PLAN_QUESTIONS_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: {
          "question-0-schema-vs-flexibility": "Strict schemas",
        },
      },
    ],
  };
}
