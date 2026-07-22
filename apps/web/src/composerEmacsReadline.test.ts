import { describe, expect, it } from "vite-plus/test";

import { resolveComposerReadlineReplacement } from "./composerEmacsReadline";
import { applyEmacsReadlineActionToPlainText } from "./emacsReadlineBindings";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

describe("resolveComposerReadlineReplacement", () => {
  it("keeps the logical caret after yanking text that will reparse into a chip", () => {
    const mention = "[file.ts](src/file.ts)";
    const edit = applyEmacsReadlineActionToPlainText({
      action: "yank",
      value: "a  z",
      selectionStart: 2,
      selectionEnd: 2,
      yankText: mention,
    });

    expect(
      resolveComposerReadlineReplacement({ edit, selectedText: "", terminalContextTexts: [] }),
    ).toMatchObject({
      insertedText: mention,
      caretOffset: 3,
    });
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
