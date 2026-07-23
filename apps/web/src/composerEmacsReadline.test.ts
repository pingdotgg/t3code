import { describe, expect, it } from "vite-plus/test";

import {
  resolveComposerReadlineReplacement,
  splitComposerReadlineInsertion,
} from "./composerEmacsReadline";
import { applyEmacsReadlineActionToPlainText } from "./emacsReadlineBindings";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("resolveComposerReadlineReplacement", () => {
  it.each([
    {
      name: "mention",
      serializedToken: "[file.ts](src/file.ts)",
      expectedSegment: { type: "mention", path: "src/file.ts" },
    },
    {
      name: "skill",
      serializedToken: "$review",
      expectedSegment: { type: "skill", name: "review" },
    },
  ])(
    "reconstructs a killed and yanked $name chip at the kill-ring boundary",
    ({ serializedToken, expectedSegment }) => {
      const killEdit = applyEmacsReadlineActionToPlainText({
        action: "kill-line",
        value: INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
        selectionStart: 0,
        selectionEnd: 1,
      });
      const killed = resolveComposerReadlineReplacement({
        edit: killEdit,
        placeholderReplacements: [{ type: "inline-token", text: serializedToken }],
      });
      expect(killed.insertedText).toBe("");
      expect(killed.killedText).toBe(`${serializedToken} `);
      const killedText = killed.killedText;
      if (killedText === undefined) throw new Error("Expected killed chip text");

      const yankEdit = applyEmacsReadlineActionToPlainText({
        action: "yank",
        value: "",
        selectionStart: 0,
        selectionEnd: 0,
        yankText: killedText,
      });
      const yanked = resolveComposerReadlineReplacement({
        edit: yankEdit,
        placeholderReplacements: [],
      });

      expect(splitComposerReadlineInsertion(yanked.insertedText)).toEqual([
        expectedSegment,
        { type: "text", text: " " },
      ]);
    },
  );

  it("preserves token boundaries for adjacent chips and plain text", () => {
    const logicalText = `before${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}after`;
    const killed = resolveComposerReadlineReplacement({
      edit: applyEmacsReadlineActionToPlainText({
        action: "kill-line",
        value: logicalText,
        selectionStart: 0,
        selectionEnd: logicalText.length,
      }),
      placeholderReplacements: [
        { type: "inline-token", text: "[file.ts](src/file.ts)" },
        { type: "inline-token", text: "$review" },
      ],
    });

    expect(killed.killedText).toBe("before [file.ts](src/file.ts) $review after");
    expect(splitComposerReadlineInsertion(killed.killedText ?? "")).toEqual([
      { type: "text", text: "before " },
      { type: "mention", path: "src/file.ts" },
      { type: "text", text: " " },
      { type: "skill", name: "review" },
      { type: "text", text: " after" },
    ]);
  });

  it("keeps transpose insertions literal instead of creating inline chips", () => {
    expect(splitComposerReadlineInsertion("$a", { parseInlineTokens: false })).toEqual([
      { type: "text", text: "$a" },
    ]);
    expect(
      splitComposerReadlineInsertion("[file.ts](src/file.ts)", { parseInlineTokens: false }),
    ).toEqual([{ type: "text", text: "[file.ts](src/file.ts)" }]);
  });

  it("keeps an empty inline-token insertion empty", () => {
    expect(splitComposerReadlineInsertion("")).toEqual([]);
  });

  it("stores readable terminal text instead of object-replacement placeholders", () => {
    const selectedText = `before ${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} after`;
    const edit = applyEmacsReadlineActionToPlainText({
      action: "kill-line",
      value: `before \uFFFC after`,
      selectionStart: 0,
      selectionEnd: selectedText.length,
    });

    expect(
      resolveComposerReadlineReplacement({
        edit,
        placeholderReplacements: [{ type: "text", text: "terminal output" }],
      }).killedText,
    ).toBe("before terminal output after");
  });
});
