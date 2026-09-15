import { describe, expect, it } from "vite-plus/test";

import { applySpeechCustomWords, normalizeSpeechCustomWords } from "./customWords.ts";

describe("speech custom words", () => {
  it.each([
    ["hello handee", ["Handy"], "hello Handy"],
    ["use Chat G P T today", ["ChatGPT"], "use ChatGPT today"],
    ["CHARGE B is ready", ["ChargeBee"], "CHARGEBEE is ready"],
    ["send it to R and D.", ["R&D"], "send it to R&D."],
    ["「Handee。」", ["Handy"], "「Handy。」"],
  ])("corrects %s", (text, words, expected) => {
    expect(applySpeechCustomWords(text, words)).toBe(expected);
  });

  it("does not fuzzily replace CJK terms", () => {
    expect(applySpeechCustomWords("你好。", ["你号"])).toBe("你好。");
  });

  it("normalizes, deduplicates, and removes unsafe prompt characters", () => {
    expect(normalizeSpeechCustomWords(["  T3   Code ", "T3 Code", "<Effect>"])).toEqual([
      "T3 Code",
      "Effect",
    ]);
  });
});
