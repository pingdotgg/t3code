import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { QuestionCardInput } from "./tools.ts";

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
