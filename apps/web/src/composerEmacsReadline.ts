import { collectComposerInlineTokens } from "@t3tools/shared/composerInlineTokens";
import type { LexicalNode, RangeSelection } from "lexical";

import type { PlainTextEdit } from "./emacsReadlineBindings";
import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "./lib/terminalContext";

export interface ComposerReadlineReplacement {
  readonly insertedText: string;
  readonly killedText?: string;
}

export type ComposerReadlinePlaceholderReplacement =
  | { readonly type: "inline-token"; readonly text: string }
  | { readonly type: "text"; readonly text: string };

export type ComposerReadlineInsertionSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "mention"; readonly path: string }
  | { readonly type: "skill"; readonly name: string };

export function splitComposerReadlineInsertion(
  text: string,
  options: { readonly parseInlineTokens?: boolean } = {},
): readonly ComposerReadlineInsertionSegment[] {
  if (options.parseInlineTokens === false) {
    return text ? [{ type: "text", text }] : [];
  }

  // A virtual delimiter recognizes a confirmed killed chip even when its
  // serialized source ends at the kill-ring boundary.
  const tokens = collectComposerInlineTokens(`${text}\n`).filter(
    (token) => token.end <= text.length,
  );
  const segments: ComposerReadlineInsertionSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor) continue;
    if (token.start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, token.start) });
    }
    segments.push(
      token.type === "mention"
        ? { type: "mention", path: token.value }
        : { type: "skill", name: token.value },
    );
    cursor = token.end;
  }
  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  } else if (segments.length > 0 && segments.at(-1)?.type !== "text") {
    // Inline-token grammar requires trailing whitespace. Preserve the chip
    // reconstructed at the kill-ring boundary by adding the same delimiter
    // used by autocomplete and paste insertion.
    segments.push({ type: "text", text: " " });
  }
  return segments;
}

export function $replaceComposerReadlineSelection(
  selection: RangeSelection,
  nodes: readonly LexicalNode[],
): void {
  if (nodes.length > 0) {
    selection.insertNodes([...nodes]);
  } else {
    selection.removeText();
  }
}

function expandComposerReadlinePlaceholders(
  text: string,
  replacements: readonly ComposerReadlinePlaceholderReplacement[],
): string {
  let replacementIndex = 0;
  let expanded = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      expanded += character;
      continue;
    }

    const replacement = replacements[replacementIndex];
    replacementIndex += 1;
    if (!replacement) continue;

    if (replacement.type === "inline-token") {
      if (expanded.length > 0 && !/\s/u.test(expanded.at(-1) ?? "")) {
        expanded += " ";
      }
      expanded += replacement.text;
      const nextCharacter = text[index + 1];
      if (nextCharacter === undefined || !/\s/u.test(nextCharacter)) {
        expanded += " ";
      }
      continue;
    }

    expanded += replacement.text;
  }

  return expanded;
}

export function resolveComposerReadlineReplacement(input: {
  readonly edit: PlainTextEdit;
  readonly placeholderReplacements: readonly ComposerReadlinePlaceholderReplacement[];
}): ComposerReadlineReplacement {
  return {
    insertedText: input.edit.insertedText ?? "",
    ...(input.edit.killedText === undefined
      ? {}
      : {
          killedText: expandComposerReadlinePlaceholders(
            input.edit.killedText,
            input.placeholderReplacements,
          ),
        }),
  };
}
