import { describe, expect, it } from "vite-plus/test";

import { resolveComposerReadlineReplacement } from "./composerEmacsReadline";
import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";
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
    "keeps the caret after a killed and yanked $name chip",
    ({ serializedToken, expectedSegment }) => {
      const prefix = "before ";
      const suffix = " after";
      const logicalValue = `${prefix}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER}${suffix}`;
      const serializedValue = `${prefix}${serializedToken}${suffix}`;
      const killEdit = applyEmacsReadlineActionToPlainText({
        action: "kill-line",
        value: logicalValue,
        selectionStart: prefix.length,
        selectionEnd: prefix.length + 1,
      });
      const killed = resolveComposerReadlineReplacement({
        edit: killEdit,
        expandedReplacementStart: prefix.length,
        expandedReplacementEnd: prefix.length + serializedToken.length,
        selectedText: serializedToken,
        serializedValue,
        terminalContextTexts: [],
      });
      expect(killed.value).toBe(`${prefix}${suffix}`);
      expect(killed.killedText).toBe(serializedToken);
      const killedText = killed.killedText;
      if (killedText === undefined) throw new Error("Expected killed chip text");

      const yankEdit = applyEmacsReadlineActionToPlainText({
        action: "yank",
        value: killed.value,
        selectionStart: prefix.length,
        selectionEnd: prefix.length,
        yankText: killedText,
      });
      const yanked = resolveComposerReadlineReplacement({
        edit: yankEdit,
        expandedReplacementStart: prefix.length,
        expandedReplacementEnd: prefix.length,
        selectedText: "",
        serializedValue: killed.value,
        terminalContextTexts: [],
      });

      expect(yanked.value).toBe(serializedValue);
      expect(yanked.caretOffset).toBe(prefix.length + 1);
      expect(splitPromptIntoComposerSegments(yanked.value)).toContainEqual(
        expect.objectContaining(expectedSegment),
      );
    },
  );

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
        expandedReplacementStart: 0,
        expandedReplacementEnd: selectedText.length,
        selectedText,
        serializedValue: selectedText,
        terminalContextTexts: ["terminal output"],
      }).killedText,
    ).toBe("before terminal output after");
  });
});
