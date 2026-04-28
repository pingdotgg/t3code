import { extractTrailingCodeContexts, type ParsedCodeContextEntry } from "./codeContext";
import {
  extractTrailingTerminalContexts,
  type ParsedTerminalContextEntry,
} from "./terminalContext";

export interface DisplayedUserMessageState {
  visibleText: string;
  copyText: string;
  contextCount: number;
  previewTitle: string | null;
  terminalContexts: ParsedTerminalContextEntry[];
  codeContexts: ParsedCodeContextEntry[];
}

export function deriveDisplayedUserMessageState(prompt: string): DisplayedUserMessageState {
  const extractedCodeContexts = extractTrailingCodeContexts(prompt);
  const extractedTerminalContexts = extractTrailingTerminalContexts(
    extractedCodeContexts.promptText,
  );
  const previewParts = [
    extractedTerminalContexts.previewTitle,
    extractedCodeContexts.previewTitle,
  ].filter((value): value is string => value !== null && value.length > 0);

  return {
    visibleText: extractedTerminalContexts.promptText,
    copyText: prompt,
    contextCount: extractedTerminalContexts.contextCount + extractedCodeContexts.contextCount,
    previewTitle: previewParts.length > 0 ? previewParts.join("\n\n") : null,
    terminalContexts: extractedTerminalContexts.contexts,
    codeContexts: extractedCodeContexts.contexts,
  };
}
