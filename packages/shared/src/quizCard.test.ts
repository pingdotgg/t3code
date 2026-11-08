import { describe, expect, it } from "vite-plus/test";
import {
  answeredCardIds,
  cardAnswerAwaitsReply,
  blankAnswerRight,
  blanksAnswerMessage,
  cardAnswerMessage,
  numberAnswerMessage,
  numberAnswerRight,
  quizAnswerGrade,
  quizAnswerMessage,
  quizCardProblem,
  readQuizCard,
  readQuestionCard,
  parseNumberAnswer,
  shuffledQuizOptions,
  type QuizCard,
} from "./quizCard.ts";

const card: QuizCard = {
  answer: "High",
  explanation: "Because",
  level: "apply",
  question: "Which?",
  wrongOptions: [
    { option: "Low", wrongIdea: "Mistake" },
    { option: "Medium", wrongIdea: "Another" },
  ],
};

describe("quiz cards", () => {
  it("reads which cards the user's messages answered", () => {
    const answer = cardAnswerMessage('Quiz answer: "High", right.', "item-2");
    expect(quizAnswerGrade(answer)).toBe("right");
    expect([
      ...answeredCardIds([
        { role: "user", text: answer },
        { role: "user", text: "Quiz answer: I don't know." },
        { role: "assistant", text: cardAnswerMessage("echo", "item-3") },
      ]),
    ]).toEqual(["item-2"]);
    const answered = { role: "user", text: answer };
    expect(cardAnswerAwaitsReply([answered])).toBe(true);
    expect(cardAnswerAwaitsReply([answered, { role: "assistant", text: " " }])).toBe(true);
    expect(cardAnswerAwaitsReply([answered, { role: "assistant", text: "Right." }])).toBe(false);
    expect(cardAnswerAwaitsReply([{ role: "user", text: "Teach me." }])).toBe(false);
    expect(cardAnswerAwaitsReply([])).toBe(false);
  });

  it("reads bounded question cards", () => {
    expect(readQuestionCard({ question: "  Explain this. " })).toEqual({
      question: "Explain this.",
    });
    expect(readQuestionCard({ question: " " })).toBeUndefined();
    expect(readQuestionCard({ question: "x".repeat(2001) })).toBeUndefined();
    expect(
      readQuestionCard({
        question: "___ + ___",
        blanks: [{ answers: ["x"] }, { answers: ["y", " z "] }],
      }),
    ).toEqual({
      question: "___ + ___",
      blanks: [{ answers: ["x"] }, { answers: ["y", "z"] }],
    });
    expect(
      readQuestionCard({ question: "___", blanks: [{ answers: ["x"] }, { answers: ["y"] }] }),
    ).toBeUndefined();
    expect(
      readQuestionCard({
        question: "Q",
        blanks: [{ answers: ["x"] }],
        number: { answer: 1, tolerance: 0 },
      }),
    ).toBeUndefined();
    expect(
      readQuestionCard({ question: "Q", number: { answer: 1, tolerance: -1 } }),
    ).toBeUndefined();
    expect(
      readQuestionCard({ question: "Q", number: { answer: Number.NaN, tolerance: 0 } }),
    ).toBeUndefined();
    expect(
      readQuestionCard({ question: "Q", number: { answer: 1, tolerance: 0, unit: " m " } }),
    ).toEqual({
      question: "Q",
      number: { answer: 1, tolerance: 0, unit: "m" },
    });
    expect(
      readQuestionCard({ question: "Q", number: { answer: 1, tolerance: 0, unit: "" } }),
    ).toEqual({ question: "Q", number: { answer: 1, tolerance: 0 } });
    expect(
      readQuestionCard({
        question: "漢".repeat(1990) + " ___",
        blanks: [{ answers: ["漢", "字", "語", "文"].map((char) => char.repeat(100)) }],
      }),
    ).toBeUndefined();
  });
  it("grades blank and number answers", () => {
    const blank = { answers: ["Ohm's law", " ohm's   law "] };
    expect(blankAnswerRight(blank, " OHM'S law ")).toBe(true);
    expect(blankAnswerRight(blank, "Kirchhoff's law")).toBe(false);
    expect(numberAnswerRight({ answer: 10, tolerance: 1 }, "9")).toBe(true);
    expect(numberAnswerRight({ answer: 10, tolerance: 1 }, "11")).toBe(true);
    expect(numberAnswerRight({ answer: 10, tolerance: 1 }, "8.9")).toBe(false);
    expect(numberAnswerRight({ answer: 0.1 + 0.2, tolerance: 0 }, "0.3")).toBe(true);
    expect(numberAnswerRight({ answer: 9.81, tolerance: 0 }, "9,81")).toBe(true);
    expect(parseNumberAnswer("6.67e-11")).toBe(6.67e-11);
    expect(parseNumberAnswer(" ")).toBeUndefined();
    expect(numberAnswerRight({ answer: 1, tolerance: 0 }, "garbage")).toBe(false);
    expect(numberAnswerRight({ answer: 6.67e-11, tolerance: 0 }, "0")).toBe(false);
    expect(numberAnswerRight({ answer: 1000, tolerance: 0 }, "1,000")).toBe(true);
    expect(numberAnswerRight({ answer: -5, tolerance: 0 }, "\u22125")).toBe(true);
    expect(blankAnswerRight({ answers: ["m"] }, "M")).toBe(false);
    expect(blankAnswerRight({ answers: ["mPa"] }, "MPa")).toBe(false);
    expect(blankAnswerRight({ answers: ["acceleration"] }, "Acceleration")).toBe(true);
  });
  it("validates options and bounds", () => {
    expect(quizCardProblem({ ...card, answer: "All of the above" })).toBeDefined();
    expect(quizCardProblem({ ...card, answer: "(Recommended) High" })).toBeDefined();
    expect(
      quizCardProblem({
        ...card,
        wrongOptions: [
          { option: "High", wrongIdea: "x" },
          { option: "Low", wrongIdea: "y" },
        ],
      }),
    ).toBeDefined();
    expect(
      quizCardProblem({ ...card, question: "漢".repeat(2000), explanation: "漢".repeat(1500) }),
    ).toBeDefined();
    expect(quizCardProblem(card)).toBeUndefined();
    expect(
      readQuizCard({
        ...card,
        wrongOptions: [{ option: "Low" }, { option: "Medium", wrongIdea: "x" }],
      }),
    ).toBeUndefined();
    expect(
      readQuizCard({
        ...card,
        wrongOptions: [
          ...card.wrongOptions,
          { option: "x", wrongIdea: "x" },
          { option: "y", wrongIdea: "y" },
          { option: "z", wrongIdea: "z" },
        ],
      }),
    ).toBeUndefined();
  });
  it("shuffles deterministically", () => {
    expect(shuffledQuizOptions(card, "one")).toEqual(shuffledQuizOptions(card, "one"));
    expect(
      shuffledQuizOptions(card, "one")
        .map((x) => x.option)
        .sort(),
    ).toEqual([card.answer, ...card.wrongOptions.map((x) => x.option)].sort());
    expect(
      new Set(
        ["a", "b", "c", "d"].map((seed) =>
          shuffledQuizOptions(card, seed)
            .map((x) => x.option)
            .join("|"),
        ),
      ).size,
    ).toBeGreaterThan(1);
  });
  it("formats answer messages", () => {
    expect(
      quizAnswerMessage({ answer: "High", correct: true, confidence: 80, thinking: "x" }),
    ).toBe('Quiz answer: "High", right. Confidence: 80%. My thinking: x');
    expect(quizAnswerMessage({ answer: "Low", correct: false, confidence: 20 })).toBe(
      'Quiz answer: "Low", wrong. Confidence: 20%.',
    );
    expect(quizAnswerMessage({ answer: null, correct: false, thinking: "unsure" })).toBe(
      "Quiz answer: I don't know. My thinking: unsure",
    );
    const question = {
      question: "___ + ___",
      blanks: [{ answers: ["m"] }, { answers: ["g"] }],
    } as const;
    expect(blanksAnswerMessage({ answers: ["m", "x"], card: question, thinking: "units" })).toBe(
      'Blanks answer: 1. "m", right; 2. "x", wrong. My thinking: units',
    );
    const number = {
      question: "Speed?",
      number: { answer: 9.8, tolerance: 0.1, unit: "m/s²" },
    } as const;
    expect(numberAnswerMessage({ answer: "9.8", card: number })).toBe(
      'Number answer: "9.8 m/s²", right.',
    );
  });
  it("reads the grade back from an answer message", () => {
    expect(quizAnswerGrade(quizAnswerMessage({ answer: "High", correct: true }))).toBe("right");
    expect(
      quizAnswerGrade(quizAnswerMessage({ answer: "Low", correct: false, thinking: '", right.' })),
    ).toBe("wrong");
    expect(quizAnswerGrade(quizAnswerMessage({ answer: null, correct: false }))).toBe("unknown");
    expect(quizAnswerGrade("Is the answer right?")).toBe(undefined);
  });
});
