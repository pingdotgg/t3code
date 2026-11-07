import { describe, expect, it } from "vite-plus/test";
import {
  answeredCardIds,
  cardAnswerMessage,
  quizAnswerGrade,
  quizAnswerMessage,
  quizCardProblem,
  readQuizCard,
  readQuestionCard,
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
  });

  it("reads bounded question cards", () => {
    expect(readQuestionCard({ question: "  Explain this. " })).toEqual({
      question: "Explain this.",
    });
    expect(readQuestionCard({ question: " " })).toBeUndefined();
    expect(readQuestionCard({ question: "x".repeat(2001) })).toBeUndefined();
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
