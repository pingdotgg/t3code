import type { ThreadId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { toKindScopedComposerContextId } from "./composerContextReferences";

export interface TerminalContextSelection {
  terminalId: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface TerminalContextDraft extends TerminalContextSelection {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

/** Legacy ordinal placeholder from drafts saved before context references. Migration only. */
export const INLINE_TERMINAL_CONTEXT_PLACEHOLDER = "\uFFFC";

export interface TerminalContextReferenceSource {
  id: string;
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}

/** The canonical inline link that stands for this context in the prompt. */
export function formatTerminalContextReference(context: TerminalContextReferenceSource): string {
  return formatComposerContextReference({
    kind: "terminal",
    contextId: toKindScopedComposerContextId("terminal", context.id),
    label: formatTerminalContextLabel(context),
  });
}

export function normalizeTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function hasTerminalContextText(context: { text: string }): boolean {
  return normalizeTerminalContextText(context.text).length > 0;
}

export function isTerminalContextExpired(context: { text: string }): boolean {
  return !hasTerminalContextText(context);
}

export function filterTerminalContextsWithText<T extends { text: string }>(
  contexts: ReadonlyArray<T>,
): T[] {
  return contexts.filter((context) => hasTerminalContextText(context));
}

function normalizeTerminalContextSelection(
  selection: TerminalContextSelection,
): TerminalContextSelection | null {
  const text = normalizeTerminalContextText(selection.text);
  const terminalId = selection.terminalId.trim();
  const terminalLabel = selection.terminalLabel.trim();
  if (text.length === 0 || terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(selection.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(selection.lineEnd));
  return {
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text,
  };
}

function formatTerminalContextRange(selection: { lineStart: number; lineEnd: number }): string {
  return selection.lineStart === selection.lineEnd
    ? `line ${selection.lineStart}`
    : `lines ${selection.lineStart}-${selection.lineEnd}`;
}

export function formatTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return `${selection.terminalLabel} ${formatTerminalContextRange(selection)}`;
}

/** Binds legacy U+FFFC placeholders to contexts in array order; leftover placeholders vanish. */
export function migrateLegacyTerminalContextPlaceholders(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextReferenceSource>,
): string {
  if (!prompt.includes(INLINE_TERMINAL_CONTEXT_PLACEHOLDER)) return prompt;
  let index = 0;
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, () => {
    const context = contexts[index];
    index += 1;
    return context ? formatTerminalContextReference(context) : "";
  });
}
