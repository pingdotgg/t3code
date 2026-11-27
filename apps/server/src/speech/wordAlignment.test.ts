import { describe, expect, it } from "vite-plus/test";

import { estimateWords, textWords } from "./wordAlignment.ts";

describe("estimateWords", () => {
  it("spreads words over the span with longer pauses after punctuation", () => {
    const text = "One two. Three";
    const words = estimateWords(text, textWords(text), 1, 3);
    expect(words.map((word) => text.slice(word.start, word.end))).toEqual(["One", "two.", "Three"]);
    expect(words[0]!.startSeconds).toBe(1);
    expect(words.at(-1)!.endSeconds).toBe(3);
    // "two." carries a sentence pause, so it lasts longer than "One".
    expect(words[1]!.endSeconds - words[1]!.startSeconds).toBeGreaterThan(
      words[0]!.endSeconds - words[0]!.startSeconds,
    );
  });
});
