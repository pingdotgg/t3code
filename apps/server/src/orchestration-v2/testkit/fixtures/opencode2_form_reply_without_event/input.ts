import { PLAN_QUESTIONS_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2FormReplyWithoutEventInput(): OrchestratorFixtureInput {
  return {
    interactionMode: "plan",
    steps: [
      { type: "message", text: PLAN_QUESTIONS_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: {
          "question-0-handoff-model": "Inherited model",
        },
      },
    ],
  };
}
