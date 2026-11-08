import { OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import {
  T3_LEARN_QUESTION_RULES,
  T3_LEARN_QUIZ_RULES_FULL,
} from "@t3tools/provider-core/server/learnInstructions";
import { QUESTION_CARD_TOOL_NAME, QUIZ_CARD_TOOL_NAME } from "@t3tools/shared/quizCard";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

// First, so the model writes the reply before the question.
const reply = TrimmedNonEmptyString.check(Schema.isMaxLength(2000)).annotate({
  description:
    "Your words to the learner, shown as your message text just above the card; they never see your thinking. After an answer: your verdict, then the teaching this card tests, with the facts it needs (rules, numbers, definitions) written out here, never just a pointer to a table or text above. For an opening check: one sentence of framing.",
});

export const QuizCardInput = Schema.Struct({
  reply,
  answer: Schema.String.pipe(Schema.check(Schema.isMaxLength(300))),
  explanation: Schema.String.pipe(Schema.check(Schema.isMaxLength(1500))),
  level: Schema.Literals(["remember", "understand", "apply", "analyse"]),
  question: Schema.String.pipe(Schema.check(Schema.isMaxLength(2000))),
  wrongOptions: Schema.Array(
    Schema.Struct({
      option: Schema.String.pipe(Schema.check(Schema.isMaxLength(300))),
      wrongIdea: Schema.String.pipe(Schema.check(Schema.isMaxLength(500))),
    }),
  ),
});

const QuizCardTool = Tool.make(QUIZ_CARD_TOOL_NAME, {
  description: T3_LEARN_QUIZ_RULES_FULL,
  parameters: QuizCardInput,
  success: Schema.Struct({ quizCard: QuizCardInput, message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Ask a quiz")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const QuestionCardInput = Schema.Struct({
  reply,
  question: Schema.String.pipe(Schema.check(Schema.isMaxLength(2000))),
  blanks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        answers: Schema.Array(Schema.String.pipe(Schema.check(Schema.isMaxLength(100)))).check(
          Schema.isMinLength(1),
          Schema.isMaxLength(4),
        ),
      }),
    )
      .check(Schema.isMinLength(1), Schema.isMaxLength(6))
      .annotate({
        description:
          "Set when the answer is a specific word, term, symbol or formula piece: one entry per ___ in the question, with every accepted form. The app gives one input per blank and marks each.",
      }),
  ),
  number: Schema.optional(
    Schema.Struct({
      answer: Schema.Number.pipe(Schema.check(Schema.isFinite())),
      tolerance: Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
      unit: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(40)))),
    }).annotate({
      description:
        "Set whenever the answer is a number (a calculation, count or measured value): the app gives a number input with the unit beside it and marks it right within tolerance, an absolute amount in the answer's unit.",
    }),
  ),
});

const QuestionCardTool = Tool.make(QUESTION_CARD_TOOL_NAME, {
  description: T3_LEARN_QUESTION_RULES,
  parameters: QuestionCardInput,
  success: Schema.Struct({ questionCard: QuestionCardInput, message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Ask a question")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const QuizToolkit = Toolkit.make(QuizCardTool, QuestionCardTool);
