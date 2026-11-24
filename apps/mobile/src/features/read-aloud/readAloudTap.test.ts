import { expect, it } from "vite-plus/test";
import { readAloudTapSource } from "./readAloudTap";

it("finds the markdown a tap on a rendered block or quote reads from", () => {
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
  // The same words in a later block keep their own place.
  expect(readAloudTapSource(markdown, shown, { text: "Intro here.", index: 6 })).toBe(
    markdown.lastIndexOf("here"),
  );
  expect(readAloudTapSource(markdown, shown, { text: blocks[0]!, index: 1 })).toBe(0);
  // A quote reports only its own text.
  expect(readAloudTapSource(markdown, shown, { text: "Quoted text.", index: 7 })).toBe(
    markdown.indexOf("text."),
  );
  expect(readAloudTapSource(markdown, shown, { text: "Not shown", index: 0 })).toBeNull();
});
