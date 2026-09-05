import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ComposerRecall } from "@t3tools/contracts";

import {
  createComposerRecall,
  offsetComposerRecall,
  recallComposerText,
} from "./composerRecall.ts";

const decodeComposerRecall = Schema.decodeUnknownSync(ComposerRecall);

describe("composer recall", () => {
  it.each(["  😀\r\n    indented\t\n", "Ultrathink:\nLiteral", "", " \t\r\n"])(
    "round trips authored text without changing trimmed input: %j",
    (raw) => {
      const composerRecall = createComposerRecall(raw);
      expect(decodeComposerRecall(composerRecall)).toEqual(composerRecall);
      expect(recallComposerText({ text: raw.trim(), composerRecall })).toBe(raw);
    },
  );

  it("keeps authored slices around a generated inline span and prefix", () => {
    const expanded = "  typed @same then @same end  ";
    const second = expanded.lastIndexOf("@same");
    const recall = createComposerRecall(expanded, [
      [0, second],
      [second + 5, expanded.length],
    ]);
    const text = `PREFIX\n${expanded.trim()}\nCONTEXT`;
    expect(recallComposerText({ text, composerRecall: offsetComposerRecall(recall, 7) })).toBe(
      "  typed @same then  end  ",
    );
  });

  it.each([
    { ranges: [[-1, 3]] },
    { ranges: [[0, 500]] },
    { ranges: [[2, 1]] },
    {
      ranges: [
        [0, 3],
        [2, 4],
      ],
    },
    { ranges: [[0.5, 3]] },
    { ranges: [], leadingWhitespace: "not whitespace" },
  ] as const)("keeps full text when slice metadata is invalid: %j", (composerRecall) => {
    expect(recallComposerText({ text: "literal", composerRecall })).toBe("literal");
  });

  it("distinguishes no authored text from unknown origin", () => {
    expect(recallComposerText({ text: "generated", composerRecall: { ranges: [] } })).toBe("");
    expect(recallComposerText({ text: "generated" })).toBe("generated");
  });

  it("keeps metadata independent of a large prompt's length", () => {
    const raw = "x".repeat(50_000);
    const metadata = createComposerRecall(raw);
    expect(metadata).toEqual({ ranges: [[0, 50_000]] });
    expect(Buffer.byteLength(JSON.stringify({ composerRecall: metadata }))).toBe(41);
  });
});
