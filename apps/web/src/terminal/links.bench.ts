import { describe, test } from "vite-plus/test";

import { extractTerminalLinks } from "../terminal-links";

// Hover detection runs this over a whole wrapped logical line on every frame,
// so separator-free output must stay linear in length.
const dense = (length: number) => "a1B2c3".repeat(Math.ceil(length / 6)).slice(0, length);
const spaced = (length: number) => "word ".repeat(Math.ceil(length / 5)).slice(0, length);

for (const length of [2_000, 10_000]) {
  describe(`extractTerminalLinks over ${length} chars`, () => {
    const denseText = dense(length);
    const spacedText = spaced(length);
    test("dense (no spaces)", async ({ bench }) => {
      await bench("dense", () => {
        extractTerminalLinks(denseText);
      }).run();
    });
    test("spaced", async ({ bench }) => {
      await bench("spaced", () => {
        extractTerminalLinks(spacedText);
      }).run();
    });
  });
}
