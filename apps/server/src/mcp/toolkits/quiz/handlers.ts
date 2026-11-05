import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { quizCardProblem, readQuizCard } from "@t3tools/shared/quizCard";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { QuizToolkit } from "./tools.ts";

const handlers = {
  quiz_card: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      yield* McpInvocationContext.requireThreadScope(scope, "quiz_card");
      const card = readQuizCard(input);
      if (card === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Invalid quiz card: provide 2–4 wrong options and all required bounded fields.",
        });
      }
      const problem = quizCardProblem(card);
      if (problem !== undefined) {
        return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: problem });
      }
      return {
        quizCard: card,
        message:
          "Shown to the learner as a quiz card with shuffled options, \"I don't know\" and a confidence slider. End your turn now; their answer, confidence and thinking arrive as their next message. Don't repeat the question or options.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof QuizToolkit.tools>;

export const layer = McpToolAccess.toLayer(QuizToolkit, handlers);
