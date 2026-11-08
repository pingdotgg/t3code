import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  cardAnswerAwaitsReply,
  type QuestionCard,
  quizCardProblem,
  readQuestionCard,
  readQuizCard,
} from "@t3tools/shared/quizCard";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { QuizToolkit } from "./tools.ts";

const CARD_REPLY_FIRST =
  "Not shown: the learner just answered a card and has seen no reply, because they never see your thinking. Call this card again with `reply` set to your reply: your verdict on their answer, then the teaching this card tests.";

// Models write the reply in their thinking and quiz on, so a card after an answer carries it (APP-97).
// The answer each thread's reply covered, so later cards in that turn need none.
const repliedAnswers = new Map<string, string>();

const deliveredMessages = <
  Message extends { readonly role: string; readonly text: string; readonly runId?: string | null },
  Run extends { readonly id: string; readonly status: string },
>(
  messages: ReadonlyArray<Message>,
  runs: ReadonlyArray<Run>,
) => {
  const undeliveredRunIds = new Set(
    runs
      .filter((run) => run.status === "queued" || run.status === "preparing")
      .map((run) => run.id),
  );
  return messages.filter(
    (message) =>
      message.runId === undefined ||
      message.runId === null ||
      !undeliveredRunIds.has(message.runId),
  );
};

const requireQuestionReply = Effect.fn("QuizHandlers.requireQuestionReply")(function* (
  card: QuestionCard,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined) return;
  const threadId = scope.thread.threadId;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  // A failed read never blocks the lesson; the card shows as before.
  const { messages, runs } = yield* threads
    .getThreadRecords(threadId, ["messages", "runs"], { messageRoles: ["user", "assistant"] })
    .pipe(Effect.orElseSucceed(() => ({ messages: [], runs: [] })));
  const delivered = deliveredMessages(messages, runs ?? []);
  const answerId = delivered.findLast((message) => message.role === "user")?.id;
  if (card.reply !== undefined) {
    if (answerId !== undefined) repliedAnswers.set(threadId, answerId);
    return;
  }
  const replied = answerId !== undefined && repliedAnswers.get(threadId) === answerId;
  if (cardAnswerAwaitsReply(delivered) && !replied) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: CARD_REPLY_FIRST,
    });
  }
});

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
          ? "Invalid quiz card: reply is required; put the teaching this card tests in reply, then provide 2–4 wrong options and all other required bounded fields."
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
            "Invalid question card: provide a non-empty question of at most 2000 characters; for blanks, provide one entry per ___ in the question and list every accepted answer; for number, provide answer and tolerance ≥ 0; do not provide both; keep reply under 2000 characters and the whole card under about 7 KB.",
        });
      }
      yield* requireQuestionReply(card);
      return { questionCard: card, message: QUESTION_CARD_SHOWN };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof QuizToolkit.tools>;

export const layer = McpToolAccess.toLayer(QuizToolkit, handlers);

export { CARD_REPLY_FIRST, QUESTION_CARD_SHOWN, QUIZ_CARD_SHOWN };
