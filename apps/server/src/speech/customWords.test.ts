import { describe, expect, it } from "vite-plus/test";

import {
  applySpeechCustomWords,
  normalizeSpeechCustomWords,
  transcriptionCustomWords,
} from "./customWords.ts";

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

  it("prioritizes the correction word without changing saved dictionary words", () => {
    const speechCustomWords = Array.from({ length: 100 }, (_, index) => `word${index}`);
    const settings = {
      speechCustomWords,
      speechCorrectionWord: "err",
      speechPostProcessingEnabled: true,
    };
    expect(transcriptionCustomWords(settings)).toEqual(["err", ...speechCustomWords.slice(0, 99)]);
    expect(settings.speechCustomWords).toEqual(speechCustomWords);
    expect(transcriptionCustomWords({ ...settings, speechPostProcessingEnabled: false })).toEqual(
      speechCustomWords,
    );
  });
});
