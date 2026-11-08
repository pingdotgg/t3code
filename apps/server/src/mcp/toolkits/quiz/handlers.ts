import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  type CardPurpose,
  cardReplyProblem,
  foldCardReply,
  quizCardProblem,
  readQuestionCard,
  readQuizCard,
} from "@t3tools/shared/quizCard";

import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { QuizToolkit } from "./tools.ts";

const QUIZ_CARD_SHOWN = `Shown to the learner as a card. End your turn now, without repeating the question or options; their pick, confidence and thinking arrive as their next message. Then:
- Say whether it was right, and why, in one or two lines. For a wrong pick, name the wrong idea that option stands for, so the lure is not learned.
- Read confidence with the verdict. Right and sure: step up a level. Right but unsure: one more item at this level. Wrong and sure: a real misconception; re-teach it, then retest the same wrong idea in a new setting. Wrong and unsure, or "don't know": a gap; a short fix is enough.
- Two right in a row with high confidence means the items are too easy: go up.`;

const QUESTION_CARD_SHOWN =
  "Shown to the learner as a card. End your turn now without repeating the question; their answer arrives as their next message. For blanks and numbers, the app already marked each answer right or wrong; confirm and explain. Grade open text strictly against the answer you wrote before asking: say plainly what holds and what is missing or wrong, never soften a wrong idea.";

// Card replies are appended after other messages and queued sends sit in delivery order, so sort by time.
export const shownTutorText = (
  messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly text: string;
    readonly createdAt: DateTime.Utc;
  }>,
) => {
  const ordered = messages.toSorted(
    (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
  );
  const lastUser = ordered.findLastIndex((message) => message.role === "user");
  return ordered
    .slice(lastUser + 1)
    .filter(
      (message) => message.role === "assistant" && !/(?::|%3A)thinking(?::|%3A)/iu.test(message.id),
    )
    .reduce((total, message) => total + message.text.length, 0);
};

const readShownTutorText = readThread(undefined, ["messages"]).pipe(
  Effect.map(({ projection }) => shownTutorText(projection.messages)),
  Effect.orElseSucceed(() => undefined),
);

const refuseThinReply = Effect.fn("quiz.refuseThinReply")(function* (
  reply: string,
  purpose: CardPurpose | undefined,
) {
  const shownBefore = yield* readShownTutorText;
  const problem =
    shownBefore === undefined ? undefined : cardReplyProblem({ reply, purpose, shownBefore });
  if (problem !== undefined) {
    return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: problem });
  }
});

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
      yield* refuseThinReply(input.reply, input.purpose);
      const shownReply = foldCardReply(input.reply, input.source);
      const shownCard = readQuizCard({ ...card, reply: shownReply });
      if (shownCard === undefined || quizCardProblem(shownCard) !== undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Invalid quiz card: the reply and source make the card too long.",
        });
      }
      return {
        quizCard: { ...shownCard, reply: shownReply, source: input.source },
        message: QUIZ_CARD_SHOWN,
      };
    }),
  ),
  question_card: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const card = readQuestionCard(input);
      if (card === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Invalid question card: provide a non-empty question of at most 2000 characters; for blanks, provide one entry per ___ in the question and list every accepted answer; for number, provide answer and tolerance ≥ 0; do not provide both; keep reply under 2000 characters and the whole card under about 7 KB.",
        });
      }
      yield* refuseThinReply(input.reply, input.purpose);
      const shownReply = foldCardReply(input.reply, input.source);
      const shownCard = readQuestionCard({ ...card, reply: shownReply });
      if (shownCard === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Invalid question card: the reply and source make the card too long.",
        });
      }
      return {
        questionCard: { ...shownCard, reply: shownReply, source: input.source },
        message: QUESTION_CARD_SHOWN,
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof QuizToolkit.tools>;

export const layer = McpToolAccess.toLayer(QuizToolkit, handlers);

export { QUESTION_CARD_SHOWN, QUIZ_CARD_SHOWN };
