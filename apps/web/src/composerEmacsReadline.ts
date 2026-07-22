import type { PlainTextEdit } from "./emacsReadlineBindings";
import { collapseExpandedComposerCursor } from "./composer-logic";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export interface ComposerReadlineReplacement {
  readonly caretOffset: number;
  readonly killedText?: string;
  readonly value: string;
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
  readonly expandedReplacementEnd: number;
  readonly expandedReplacementStart: number;
  readonly selectedText: string;
  readonly serializedValue: string;
  readonly terminalContextTexts: readonly string[];
}): ComposerReadlineReplacement {
  const insertedText = input.edit.insertedText ?? "";
  const value =
    input.serializedValue.slice(0, input.expandedReplacementStart) +
    insertedText +
    input.serializedValue.slice(input.expandedReplacementEnd);
  const expandedCaretOffset = input.expandedReplacementStart + insertedText.length;
  return {
    caretOffset: collapseExpandedComposerCursor(value, expandedCaretOffset),
    value,
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
