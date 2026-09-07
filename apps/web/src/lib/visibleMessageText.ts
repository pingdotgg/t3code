import type { ParsedElementContextEntry } from "./elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "./previewAnnotation";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "./terminalContext";

export interface DisplayedUserMessageContent {
  /** The prompt text rendered in the message body after context blocks are removed. */
  readonly visibleText: string;
  /** The original prompt used by copy-message. */
  readonly copyText: string;
  readonly terminalContexts: ReadonlyArray<ParsedTerminalContextEntry>;
  readonly previewAnnotations: ReadonlyArray<ParsedPreviewAnnotation>;
  readonly elementContexts: ReadonlyArray<ParsedElementContextEntry>;
}

/**
 * Derives the user-message content rendered by the timeline. Search and the
 * row share this path so appended context payloads cannot become invisible
 * matches.
 */
export function deriveDisplayedUserMessageContent(text: string): DisplayedUserMessageContent {
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let visibleText = text;

  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    visibleText = extracted.promptText;
  }

  const displayed = deriveDisplayedUserMessageState(visibleText);

  return {
    visibleText: displayed.visibleText,
    copyText: text,
    terminalContexts: displayed.contexts,
    previewAnnotations,
    elementContexts: displayed.elementContexts,
  };
}
