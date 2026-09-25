import { describe, expect, it } from "vite-plus/test";

import {
  applySpeechCustomWords,
  applySpeechAliases,
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

  it("preserves whitespace around fuzzy corrections", () => {
    expect(applySpeechCustomWords("  hello\n\nhandee   friend\t", ["Handy"])).toBe(
      "  hello\n\nHandy   friend\t",
    );
    expect(applySpeechCustomWords("first line\nsecond line", ["Handy"])).toBe(
      "first line\nsecond line",
    );
    expect(applySpeechCustomWords("Chat\nG P T", ["ChatGPT"])).toBe("Chat\nG P T");
  });

  it("normalizes, deduplicates, and removes unsafe prompt characters", () => {
    expect(
      normalizeSpeechCustomWords([
        { term: "  T3   Code ", aliases: ["T three code"] },
        { term: "T3 Code", aliases: [] },
        { term: "<Effect>", aliases: [] },
      ]),
    ).toEqual([
      { term: "T3 Code", aliases: ["T three code"] },
      { term: "Effect", aliases: [] },
    ]);
  });

  it("replaces aliases as complete phrases without changing punctuation", () => {
    const words = [{ term: "MiniMax", aliases: ["mini max", "minimum max"] }];
    expect(applySpeechAliases("Use mini max, not mini maximum.", words)).toBe(
      "Use MiniMax, not mini maximum.",
    );
    expect(applySpeechAliases("Use minimum max!", words)).toBe("Use MiniMax!");
  });

  it("prioritizes the correction word without changing saved dictionary words", () => {
    const speechCustomWords = Array.from({ length: 100 }, (_, index) => ({
      term: `word${index}`,
      aliases: [],
    }));
    const settings = {
      speechCustomWords,
      speechCorrectionWord: "err",
      speechPostProcessingEnabled: true,
    };
    expect(transcriptionCustomWords(settings)).toEqual([
      "err",
      ...speechCustomWords.slice(0, 99).map(({ term }) => term),
    ]);
    expect(settings.speechCustomWords).toEqual(speechCustomWords);
    expect(transcriptionCustomWords({ ...settings, speechPostProcessingEnabled: false })).toEqual(
      speechCustomWords.map(({ term }) => term),
    );
  });
});
