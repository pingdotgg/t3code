import type { ParsedElementContextEntry } from "./elementContext.ts";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "./previewAnnotationText.ts";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "./terminalContext.ts";

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
  const terminalContexts: ParsedTerminalContextEntry[] = [];
  const elementContexts: ParsedElementContextEntry[] = [];
  let visibleText = text;

  // Peel the outermost suffix first: annotations can contain their own element context.
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (extracted.annotation) {
      previewAnnotations.unshift(extracted.annotation);
      visibleText = extracted.promptText;
      continue;
    }
    const displayed = deriveDisplayedUserMessageState(visibleText);
    if (displayed.visibleText === visibleText) break;
    terminalContexts.unshift(...displayed.contexts);
    elementContexts.unshift(...displayed.elementContexts);
    visibleText = displayed.visibleText;
  }

  return {
    visibleText,
    copyText: text,
    terminalContexts,
    previewAnnotations,
    elementContexts,
  };
}
