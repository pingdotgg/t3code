import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { quizCardProblem, readQuestionCard, readQuizCard } from "@t3tools/shared/quizCard";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { QuizToolkit } from "./tools.ts";

const QUIZ_CARD_SHOWN = `Shown to the learner as a card. End your turn now, without repeating the question or options; their pick, confidence and thinking arrive as their next message. Then:
- Say whether it was right, and why, in one or two lines. For a wrong pick, name the wrong idea that option stands for, so the lure is not learned.
- Read confidence with the verdict. Right and sure: step up a level. Right but unsure: one more item at this level. Wrong and sure: a real misconception; re-teach it, then retest the same wrong idea in a new setting. Wrong and unsure, or "don't know": a gap; a short fix is enough.
- Two right in a row with high confidence means the items are too easy: go up.`;

const QUESTION_CARD_SHOWN =
  "Shown to the learner as a card. End your turn now without repeating the question; their answer arrives as their next message. For blanks and numbers, the app already marked each answer right or wrong; confirm and explain. Grade open text strictly against the answer you wrote before asking: say plainly what holds and what is missing or wrong, never soften a wrong idea.";

const handlers = {
  quiz_card: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const card = readQuizCard(input);
      const problem =
        card === undefined
          ? "Invalid quiz card: provide 2–4 wrong options and all required bounded fields."
          : quizCardProblem(card);
      if (problem !== undefined || card === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: problem ?? "Invalid quiz card.",
        });
      }
      return { quizCard: card, message: QUIZ_CARD_SHOWN };
    }),
  ),
  question_card: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const card = readQuestionCard(input);
      if (card === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Invalid question card: provide a non-empty question of at most 2000 characters; for blanks, provide one entry per ___ in the question and list every accepted answer; for number, provide answer and tolerance ≥ 0; do not provide both; keep the whole card under about 7 KB.",
        });
      }
      return { questionCard: card, message: QUESTION_CARD_SHOWN };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof QuizToolkit.tools>;

export const layer = McpToolAccess.toLayer(QuizToolkit, handlers);

// The evals answer card calls with what T3 tells the agent.
export { QUESTION_CARD_SHOWN, QUIZ_CARD_SHOWN };
