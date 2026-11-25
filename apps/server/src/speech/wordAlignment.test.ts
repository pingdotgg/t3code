import { describe, expect, it } from "vite-plus/test";

import { estimateWords, matchHeardWords, textWords } from "./wordAlignment.ts";

const heard = (...words: ReadonlyArray<readonly [string, number]>) =>
  words.map(([text, start]) => ({ text, startSeconds: start, endSeconds: start + 0.3 }));

describe("matchHeardWords", () => {
  it("times identifiers and paths the voice read as separate words", () => {
    const text = "Open ThreadList.tsx and run vp test.";
    const { starts } = matchHeardWords(
      text,
      textWords(text),
      0,
      heard(
        ["open", 0],
        ["thread", 0.4],
        ["list", 0.7],
        ["TSX", 1],
        ["and", 1.4],
        ["run", 1.6],
        ["VP", 1.9],
        ["test.", 2.2],
      ),
    );
    expect([...starts]).toEqual([
      [0, 0],
      [1, 0.4],
      [2, 1.4],
      [3, 1.6],
      [4, 1.9],
      [5, 2.2],
    ]);
  });

  it("leaves numbers the voice spelled out untimed, and starts from the given word", () => {
    const text = "Done. It took 25 seconds, then stopped.";
    const { starts } = matchHeardWords(
      text,
      textWords(text),
      1,
      heard(
        ["It", 1],
        ["took", 1.2],
        ["twenty", 1.5],
        ["five", 1.8],
        ["seconds,", 2.1],
        ["then", 2.7],
        ["stopped.", 3],
      ),
    );
    expect(starts.has(0)).toBe(false);
    expect(starts.has(3)).toBe(false);
    expect(starts.get(4)).toBe(2.1);
    expect(starts.get(6)).toBe(3);
  });

  it("matches accented text regardless of accents and case", () => {
    const text = "Revisé la configuración";
    const {
      starts,
      matched,
      heard: total,
    } = matchHeardWords(
      text,
      textWords(text),
      0,
      heard(["revise", 0], ["LA", 0.5], ["configuracion", 0.7]),
    );
    expect(matched).toBe(total);
    expect([...starts]).toEqual([
      [0, 0],
      [1, 0.5],
      [2, 0.7],
    ]);
  });
});

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
