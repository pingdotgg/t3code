import { expect, it } from "vite-plus/test";
import { readAloudSelectionSource, readAloudTapSource } from "./readAloudTap";

const markdown = "Intro **here**.\n\n> Quoted text.\n\nIntro here.";
const blocks = ["Intro here.\nQuoted text.", "Intro here."];
const text = blocks.join("\n");
const shown = {
  text,
  blocks: [
    { start: 0, end: blocks[0]!.length, kind: "text" as const },
    { start: blocks[0]!.length + 1, end: text.length, kind: "text" as const },
  ],
};

it("finds the markdown a tap on a rendered block or quote reads from", () => {
  // The same words in a later block keep their own place.
  expect(readAloudTapSource(markdown, shown, { text: "Intro here.", index: 6 })).toEqual({
    from: markdown.lastIndexOf("here"),
    word: true,
  });
  expect(readAloudTapSource(markdown, shown, { text: blocks[0]!, index: 1 })).toEqual({
    from: 0,
    word: true,
  });
  // A quote reports only its own text.
  expect(readAloudTapSource(markdown, shown, { text: "Quoted text.", index: 7 })).toEqual({
    from: markdown.indexOf("text."),
    word: true,
  });
  expect(readAloudTapSource(markdown, shown, { text: "Not shown", index: 0 })).toBeNull();
});

it("finds the markdown a selection reads from, in the block it was made in", () => {
  expect(readAloudSelectionSource(markdown, shown, { text: "here.", start: 6 })).toBe(
    markdown.indexOf("here"),
  );
  // The second block reports the same text at the same place, and its own block wins there.
  const second = { ...shown, blocks: [shown.blocks[1]!] };
  expect(readAloudSelectionSource(markdown, second, { text: "here.", start: 6 })).toBe(
    markdown.lastIndexOf("here"),
  );
  expect(readAloudSelectionSource(markdown, shown, { text: "", start: 0 })).toBeNull();
});
