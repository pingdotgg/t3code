import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { QuestionCardInput, QuizCardInput } from "./tools.ts";

const decodeQuizCard = Schema.decodeUnknownSync(QuizCardInput);
const decodeQuestionCard = Schema.decodeUnknownSync(QuestionCardInput);

describe("QuestionCardInput", () => {
  it("accepts the bounded blanks and number a tutor sends", () => {
    const decode = Schema.decodeUnknownSync(QuestionCardInput);
    const blanks = {
      question: "v = ___ + ___ t",
      blanks: [{ answers: ["v0", "v₀", "u", "v_0"] }, { answers: ["a"] }],
    };
    expect(decode(blanks)).toEqual(blanks);
    expect(decode({ question: "How fast?", number: { answer: 10, tolerance: 0.1 } })).toEqual({
      question: "How fast?",
      number: { answer: 10, tolerance: 0.1 },
    });
    expect(() => decode({ question: "x ___", blanks: [{ answers: [] }] })).toThrow();
    expect(() =>
      decode({ question: "x ___", blanks: [{ answers: ["a", "b", "c", "d", "e"] }] }),
    ).toThrow();
  });
});

describe("QuizCardInput", () => {
  it("requires a non-empty reply containing the card's teaching", () => {
    const card = {
      answer: "A",
      explanation: "Because",
      level: "apply",
      question: "Which?",
      wrongOptions: [
        { option: "B", wrongIdea: "Mistake" },
        { option: "C", wrongIdea: "Another" },
      ],
    };
    expect(() => decodeQuizCard(card)).toThrow();
    expect(() => decodeQuizCard({ ...card, reply: " " })).toThrow();
    expect(
      decodeQuizCard({ ...card, reply: "Dead checks score in the 0.01 to 0.25 band." }),
    ).toMatchObject({ reply: "Dead checks score in the 0.01 to 0.25 band." });
  });

  it("still allows a question card without a reply", () => {
    expect(decodeQuestionCard({ question: "Why?" })).toEqual({
      question: "Why?",
    });
  });
});
