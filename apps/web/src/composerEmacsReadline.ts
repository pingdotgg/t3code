import type { PlainTextEdit } from "./emacsReadlineBindings";
import { collapseExpandedComposerCursor } from "./composer-logic";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export interface ComposerReadlineReplacement {
  readonly caretOffset: number;
  readonly insertedText: string;
  readonly killedText?: string;
}

function expandTerminalContextPlaceholders(
  text: string,
  terminalContextTexts: readonly string[],
): string {
  let terminalContextIndex = 0;
  return text.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, () => {
    const contextText = terminalContextTexts[terminalContextIndex] ?? "";
    terminalContextIndex += 1;
    return contextText;
  });
}

export function resolveComposerReadlineReplacement(input: {
  readonly edit: PlainTextEdit;
  readonly selectedText: string;
  readonly terminalContextTexts: readonly string[];
}): ComposerReadlineReplacement {
  return {
    caretOffset: collapseExpandedComposerCursor(input.edit.value, input.edit.selectionStart),
    insertedText: input.edit.insertedText ?? "",
    ...(input.edit.killedText === undefined
      ? {}
      : {
          killedText: expandTerminalContextPlaceholders(
            input.selectedText,
            input.terminalContextTexts,
          ),
        }),
  };
}
