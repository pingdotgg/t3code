import { MessageId } from "@t3tools/contracts";

type LessonMessage = {
  readonly id: ReturnType<typeof MessageId.make>;
  readonly role: "user" | "assistant";
  readonly text: string;
};

const turn = (id: string, role: LessonMessage["role"], text: string): LessonMessage => ({
  id: MessageId.make(`message:${id}`),
  role,
  text,
});

const longMessages: LessonMessage[] = [
  turn("u1", "user", "Teach me context management in a small language model application."),
  turn("a1", "assistant", "We will build the idea from a conversation history and a token budget."),
  ...Array.from({ length: 27 }, (_, index) => {
    const n = index + 2;
    return [
      turn(
        `u${n}`,
        "user",
        `Turn ${n}: I tried the context management exercise and asked about its next step.`,
      ),
      turn(
        `a${n}`,
        "assistant",
        `Turn ${n}: We worked through token budgets, message selection, and preserving the user's goal.`,
      ),
    ] as const;
  }).flat(),
  turn(
    "u30",
    "user",
    "I am confused: why does keeping the first user message help when the newest messages are selected?",
  ),
  turn(
    "a30",
    "assistant",
    "The first user message anchors the original goal while the newest messages preserve the current state; selection can use both priorities.",
  ),
  turn(
    "u31",
    "user",
    "So the oldest message is retained because it states the goal, not because old context is always useful?",
  ),
  turn(
    "a31",
    "assistant",
    "Exactly. Older messages are omitted when they are less useful, while the initial request remains a compact statement of intent.",
  ),
  turn("u32", "user", "Continue with the omission markers and the final exercise."),
  turn(
    "a32",
    "assistant",
    "We covered gap markers, bounded messages, and the final exercise is to design a compact summarizer.",
  ),
  turn("u33", "user", "I completed the exercise and want a recap."),
  turn(
    "a33",
    "assistant",
    "The lesson now reaches the recap: context is selected under a budget while preserving intent and recent work.",
  ),
  turn("u34", "user", "What should I review next?"),
  turn(
    "a34",
    "assistant",
    "Review the tradeoff between retaining the goal and retaining the latest state.",
  ),
  turn("u35", "user", "One last question about context windows."),
  turn(
    "a35",
    "assistant",
    "A context window is a bounded input, so every retained message must earn its space.",
  ),
  turn("u36", "user", "Thanks, I understand the main design."),
  turn("a36", "assistant", "Good. You can now implement and test the selection policy."),
  turn("u37", "user", "Please summarize the lesson."),
  turn("a37", "assistant", "We are ready for a learner-focused summary."),
];

const shortMessages: LessonMessage[] = [
  turn("u1", "user", "Teach me why a context budget matters."),
  turn("a1", "assistant", "A context budget limits how much conversation can be sent to a model."),
  turn("u2", "user", "We compared a small budget with a large one."),
  turn(
    "a2",
    "assistant",
    "You saw that a small budget requires choosing the most useful messages.",
  ),
  turn("u3", "user", "I understand that the budget controls retained history."),
  turn(
    "a3",
    "assistant",
    "The lesson has introduced the basic tradeoff and is ready for a short recap.",
  ),
  turn("u4", "user", "What is the key idea?"),
  turn(
    "a4",
    "assistant",
    "Keep the context that best preserves the learner's goal and current work.",
  ),
  turn("u5", "user", "Please summarize this lesson."),
  turn("a5", "assistant", "We have covered the basic context-budget idea."),
];

export const sideChatSummaryCases = [
  {
    id: "long-learner-confusion",
    kind: "opening_summary",
    source:
      "~/t3-learn-notes/context-management/lesson.md (the side-chat summary finding near line 969; 63% of summaries hit the cap)",
    messages: longMessages,
    judgeChars: 400,
    rubric:
      "The text names the learner's confusion about why the first user message is kept alongside the newest messages.",
  },
  {
    id: "short-control",
    kind: "opening_summary",
    source:
      "~/t3-learn-notes/context-management/lesson.md (control for the side-chat summary finding near line 969)",
    messages: shortMessages,
    judgeChars: null,
    rubric:
      "The learner's understanding or state comes before lesson progress and topic, or the summary has no learner-state claim to order.",
  },
] as const;

export const sideChatOutcomeCases = [
  {
    id: "r8-deduction-limit-question",
    kind: "outcome_note",
    source: "~/t3-learn-team/notes/golden-walk-2026-11-08-r8/transcript.md (walk r8, Side chat)",
    excerpt: "Its score falls in a straight line from 1 at the ideal to 0 at a fail limit",
    messages: [
      {
        role: "user",
        text: "wait so where does the line start and stop for a real check, like the doc example has an ideal, a deduction limit and a fail limit. what's the deduction limit for if the line already goes from ideal to fail limit?",
      },
      {
        role: "assistant",
        text: "The deduction limit doesn't change the score. It's a marker on the line, not a bend in it. The score is one straight line from 1 at the ideal down to 0 at the fail limit. The deduction limit is the task's own stated rule and adds no extra penalty.",
      },
    ],
    rubric:
      "Answer YES if the note reports the learner's question about what the deduction limit is for (any wording). Answer NO if it claims the learner held a specific wrong idea they never stated, such as that the deduction limit bends or changes the score line. Saying the learner asked or was unsure is fine: a question is not a misconception.",
  },
] as const;

export type SideChatSummaryCase = (typeof sideChatSummaryCases)[number];
export type SideChatOutcomeCase = (typeof sideChatOutcomeCases)[number];
