import { OrchestratorMcpFailure } from "@t3tools/contracts";
import {
  T3_LEARN_QUESTION_RULES,
  T3_LEARN_QUIZ_RULES_FULL,
} from "@t3tools/provider-core/server/learnInstructions";
import { QUESTION_CARD_TOOL_NAME, QUIZ_CARD_TOOL_NAME } from "@t3tools/shared/quizCard";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

// First, so the model writes the reply before the question.
const reply = Schema.String.check(Schema.isPattern(/\S/), Schema.isMaxLength(2000)).annotate({
  description:
    "Your words to the learner, shown as your message text just above the card; they never see your thinking. A short reply is refused unless purpose is set. Except when purpose is set, the reply itself must be one tight paragraph: give the verdict on the learner's last answer, if there is one, then teach what this card tests with its facts (rules, numbers, definitions) written out here, never just a pointer to a table or text above. When purpose is set, the reply may be one short framing sentence.",
});
const source = Schema.String.pipe(Schema.check(Schema.isMaxLength(500))).annotate({
  description:
    "Shown to the learner under your reply. Where the project facts in reply come from: the file you read that runs them (e.g. `grader/bank/compose.py`). If a doc, README or CLAUDE.md says something different, name that doc and say it is out of date, e.g. `grader/bank/compose.py; docs/grading.md is out of date: it names grader/core.py, which nothing calls`. Empty string when the card is not about project files.",
});
const purpose = Schema.Literals(["opening-check", "explain-back"]).annotate({
  description:
    "Set only for the lesson's opening check of what the learner knows, or when asking them to explain a topic back before it is saved to their map; then the reply may be one framing sentence.",
});

export const QuizCardInput = Schema.Struct({
  reply,
  source,
  purpose: Schema.optional(purpose),
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
  // The returned reply carries the folded source, so it may exceed the input cap.
  success: Schema.Struct({
    quizCard: Schema.Struct({ ...QuizCardInput.fields, reply: Schema.String }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Ask a quiz")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const QuestionCardInput = Schema.Struct({
  reply,
  source,
  purpose: Schema.optional(purpose),
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
  success: Schema.Struct({
    questionCard: Schema.Struct({ ...QuestionCardInput.fields, reply: Schema.String }),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Title, "Ask a question")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const QuizToolkit = Toolkit.make(QuizCardTool, QuestionCardTool);
