import { extractTrailingCodeContexts, type ParsedCodeContextEntry } from "./codeContext";
import { extractTrailingElementContexts, type ParsedElementContextEntry } from "./elementContext";
import {
  extractTrailingTerminalContexts,
  type ParsedTerminalContextEntry,
} from "./terminalContext";

export interface DisplayedUserMessageState {
  visibleText: string;
  copyText: string;
  contextCount: number;
  previewTitle: string | null;
  /** Terminal-context entries extracted from the trailing `<terminal_context>` block. */
  contexts: ParsedTerminalContextEntry[];
  /** Workspace code selections extracted from the trailing `<code_context>` block. */
  codeContexts: ParsedCodeContextEntry[];
  /**
   * Element-context entries extracted from the trailing `<element_context>`
   * block (if any). Stripped from `visibleText` so the raw block doesn't
   * leak into the user's bubble.
   */
  elementContexts: ParsedElementContextEntry[];
}

/**
 * Strip and surface the trailing composer-attachment blocks from a sent user
 * message. Order matters: send-time appends `<terminal_context>` first, then
 * `<code_context>`, then `<element_context>` last — so extraction unwinds in
 * the reverse order.
 */
export function deriveDisplayedUserMessageState(prompt: string): DisplayedUserMessageState {
  const extractedElement = extractTrailingElementContexts(prompt);
  const extractedCode = extractTrailingCodeContexts(extractedElement.promptText);
  const extractedTerminal = extractTrailingTerminalContexts(extractedCode.promptText);
  const previewParts = [extractedTerminal.previewTitle, extractedCode.previewTitle].filter(
    (value): value is string => value !== null && value.length > 0,
  );

  return {
    visibleText: extractedTerminal.promptText,
    copyText: prompt,
    contextCount: extractedTerminal.contextCount + extractedCode.contextCount,
    previewTitle: previewParts.length > 0 ? previewParts.join("\n\n") : null,
    contexts: extractedTerminal.contexts,
    codeContexts: extractedCode.contexts,
    elementContexts: extractedElement.contexts,
  };
}
