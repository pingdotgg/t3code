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
        selectedText: serializedToken,
        terminalContextTexts: [],
      });
      expect(killed.insertedText).toBe("");
      expect(killed.killedText).toBe(serializedToken);
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
        selectedText: "",
        terminalContextTexts: [],
      });

      expect(splitComposerReadlineInsertion(yanked.insertedText)).toEqual([
        expectedSegment,
        { type: "text", text: " " },
      ]);
    },
  );

  it("keeps transpose insertions literal instead of creating inline chips", () => {
    expect(splitComposerReadlineInsertion("$a", { parseInlineTokens: false })).toEqual([
      { type: "text", text: "$a" },
    ]);
    expect(
      splitComposerReadlineInsertion("[file.ts](src/file.ts)", { parseInlineTokens: false }),
    ).toEqual([{ type: "text", text: "[file.ts](src/file.ts)" }]);
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
        selectedText,
        terminalContextTexts: ["terminal output"],
      }).killedText,
    ).toBe("before terminal output after");
  });
});
