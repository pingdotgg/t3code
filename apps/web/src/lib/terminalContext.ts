import { type ThreadId } from "@t3tools/contracts";

import { extractTrailingElementContexts, type ParsedElementContextEntry } from "./elementContext";

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

export interface ExtractedTerminalContexts {
  promptText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
}

export interface DisplayedUserMessageState {
  visibleText: string;
  copyText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedTerminalContextEntry[];
  /**
   * Element-context entries extracted from the trailing `<element_context>`
   * block (if any). Stripped from `visibleText` so the raw block doesn't
   * leak into the user's bubble.
   */
  elementContexts: ParsedElementContextEntry[];
}

export interface ParsedTerminalContextEntry {
  header: string;
  body: string;
}

export interface TerminalContextSerializationOptions {
  readonly maxLines?: number;
  readonly maxChars?: number;
  readonly strategy?: "full" | "tail" | "head-tail";
}

export const DEFAULT_COMPACT_TERMINAL_CONTEXT_OPTIONS = {
  maxLines: 400,
  maxChars: 24_000,
  strategy: "head-tail",
} as const satisfies TerminalContextSerializationOptions;

export const INLINE_TERMINAL_CONTEXT_PLACEHOLDER = "\uFFFC";

const TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN =
  /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;

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

function previewTerminalContextText(text: string): string {
  const normalized = normalizeTerminalContextText(text);
  if (normalized.length === 0) {
    return "";
  }
  const lines = normalized.split("\n");
  const visibleLines = lines.slice(0, 3);
  if (lines.length > 3) {
    visibleLines.push("...");
  }
  const preview = visibleLines.join("\n");
  return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

export function normalizeTerminalContextSelection(
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

export function formatTerminalContextRange(selection: {
  lineStart: number;
  lineEnd: number;
}): string {
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

export function formatInlineTerminalContextLabel(selection: {
  terminalLabel: string;
  lineStart: number;
  lineEnd: number;
}): string {
  const terminalLabel = selection.terminalLabel.trim().toLowerCase().replace(/\s+/g, "-");
  const range =
    selection.lineStart === selection.lineEnd
      ? `${selection.lineStart}`
      : `${selection.lineStart}-${selection.lineEnd}`;
  return `@${terminalLabel}:${range}`;
}

export function buildTerminalContextPreviewTitle(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string | null {
  if (contexts.length === 0) {
    return null;
  }
  const previewParts: string[] = [];
  for (const context of contexts) {
    const normalized = normalizeTerminalContextSelection(context);
    if (!normalized) continue;
    const preview = previewTerminalContextText(normalized.text);
    previewParts.push(
      preview.length > 0
        ? `${formatTerminalContextLabel(normalized)}\n${preview}`
        : formatTerminalContextLabel(normalized),
    );
  }
  const previews = previewParts.join("\n\n");
  return previews.length > 0 ? previews : null;
}

function trimTerminalContextLines(
  lines: ReadonlyArray<string>,
  options: TerminalContextSerializationOptions,
): { readonly lines: ReadonlyArray<string>; readonly omittedLineCount: number } {
  const strategy = options.strategy ?? "full";
  const maxLines = options.maxLines;
  if (strategy === "full" || maxLines === undefined || maxLines <= 0 || lines.length <= maxLines) {
    return { lines, omittedLineCount: 0 };
  }
  if (strategy === "tail") {
    return {
      lines: lines.slice(-maxLines),
      omittedLineCount: lines.length - maxLines,
    };
  }
  const headCount = Math.max(1, Math.floor(maxLines * 0.2));
  const tailCount = Math.max(1, maxLines - headCount);
  return {
    lines: [...lines.slice(0, headCount), ...lines.slice(-tailCount)],
    omittedLineCount: Math.max(0, lines.length - headCount - tailCount),
  };
}

function trimTerminalContextChars(
  lines: ReadonlyArray<string>,
  maxChars: number | undefined,
): { readonly lines: ReadonlyArray<string>; readonly truncatedByChars: boolean } {
  if (maxChars === undefined || maxChars <= 0) {
    return { lines, truncatedByChars: false };
  }
  let remaining = maxChars;
  const kept: string[] = [];
  let truncatedByChars = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (remaining <= 0) {
      truncatedByChars = true;
      break;
    }
    if (line.length <= remaining) {
      kept.push(line);
      remaining -= line.length + 1;
      continue;
    }
    kept.push(`${line.slice(0, Math.max(0, remaining - 1))}…`);
    truncatedByChars = true;
    break;
  }
  return { lines: kept, truncatedByChars };
}

function buildTerminalContextBodyLines(
  selection: TerminalContextSelection,
  options: TerminalContextSerializationOptions = {},
): string[] {
  const sourceLines = normalizeTerminalContextText(selection.text).split("\n");
  const lineTrim = trimTerminalContextLines(sourceLines, options);
  const charTrim = trimTerminalContextChars(lineTrim.lines, options.maxChars);
  const lines: string[] = [];
  if (lineTrim.omittedLineCount > 0 && (options.strategy ?? "full") === "tail") {
    lines.push(
      `  [trimmed: omitted first ${lineTrim.omittedLineCount} of ${sourceLines.length} lines]`,
    );
  }
  const leadingLineOffset =
    lineTrim.omittedLineCount > 0 && (options.strategy ?? "full") === "tail"
      ? sourceLines.length - lineTrim.lines.length
      : 0;
  const headTailBreakIndex =
    lineTrim.omittedLineCount > 0 && (options.strategy ?? "full") === "head-tail"
      ? Math.max(1, Math.floor((options.maxLines ?? lineTrim.lines.length) * 0.2))
      : -1;
  for (let index = 0; index < charTrim.lines.length; index += 1) {
    if (index === headTailBreakIndex) {
      lines.push(
        `  [trimmed: omitted ${lineTrim.omittedLineCount} middle lines from ${sourceLines.length} total lines]`,
      );
    }
    const sourceIndex =
      headTailBreakIndex >= 0 && index >= headTailBreakIndex
        ? sourceLines.length - (lineTrim.lines.length - index)
        : leadingLineOffset + index;
    lines.push(`  ${selection.lineStart + sourceIndex} | ${charTrim.lines[index] ?? ""}`);
  }
  if (charTrim.truncatedByChars) {
    lines.push("  [trimmed: context exceeded character limit]");
  }
  return lines;
}

export function buildTerminalContextBlock(
  contexts: ReadonlyArray<TerminalContextSelection>,
  options: TerminalContextSerializationOptions = {},
): string {
  const normalizedContexts: TerminalContextSelection[] = [];
  for (const context of contexts) {
    const normalized = normalizeTerminalContextSelection(context);
    if (normalized !== null) {
      normalizedContexts.push(normalized);
    }
  }
  if (normalizedContexts.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (let index = 0; index < normalizedContexts.length; index += 1) {
    const context = normalizedContexts[index]!;
    lines.push(`- ${formatTerminalContextLabel(context)}:`);
    lines.push(...buildTerminalContextBodyLines(context, options));
    if (index < normalizedContexts.length - 1) {
      lines.push("");
    }
  }
  return ["<terminal_context>", ...lines, "</terminal_context>"].join("\n");
}

export function materializeInlineTerminalContextPrompt(
  prompt: string,
  contexts: ReadonlyArray<{
    terminalLabel: string;
    lineStart: number;
    lineEnd: number;
  }>,
): string {
  let nextContextIndex = 0;
  let result = "";

  for (const char of prompt) {
    if (char !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      result += char;
      continue;
    }
    const context = contexts[nextContextIndex] ?? null;
    nextContextIndex += 1;
    if (!context) {
      continue;
    }
    result += formatInlineTerminalContextLabel(context);
  }

  return result;
}

export function appendTerminalContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextSelection>,
  options: TerminalContextSerializationOptions = {},
): string {
  const trimmedPrompt = materializeInlineTerminalContextPrompt(prompt, contexts).trim();
  const contextBlock = buildTerminalContextBlock(contexts, options);
  if (contextBlock.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${contextBlock}` : contextBlock;
}

export function extractTrailingTerminalContexts(prompt: string): ExtractedTerminalContexts {
  const match = TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const parsedContexts = parseTerminalContextEntries(match[1] ?? "");
  return {
    promptText,
    contextCount: parsedContexts.length,
    previewTitle:
      parsedContexts.length > 0
        ? parsedContexts
            .map(({ header, body }) => (body.length > 0 ? `${header}\n${body}` : header))
            .join("\n\n")
        : null,
    contexts: parsedContexts,
  };
}

export function deriveDisplayedUserMessageState(prompt: string): DisplayedUserMessageState {
  // Order matters: send-time appends `<terminal_context>` first, then
  // `<element_context>` last. Strip element first so the (now-trailing)
  // terminal block can be matched by `extractTrailingTerminalContexts`.
  const extractedElement = extractTrailingElementContexts(prompt);
  const extractedTerminal = extractTrailingTerminalContexts(extractedElement.promptText);
  return {
    visibleText: extractedTerminal.promptText,
    copyText: prompt,
    contextCount: extractedTerminal.contextCount,
    previewTitle: extractedTerminal.previewTitle,
    contexts: extractedTerminal.contexts,
    elementContexts: extractedElement.contexts,
  };
}

function parseTerminalContextEntries(block: string): ParsedTerminalContextEntry[] {
  const entries: ParsedTerminalContextEntry[] = [];
  let current: { header: string; bodyLines: string[] } | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }
    entries.push({
      header: current.header,
      body: current.bodyLines.join("\n").trimEnd(),
    });
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      current = {
        header: headerMatch[1]!,
        bodyLines: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    if (rawLine.startsWith("  ")) {
      current.bodyLines.push(rawLine.slice(2));
      continue;
    }
    if (rawLine.length === 0) {
      current.bodyLines.push("");
    }
  }

  commitCurrent();
  return entries;
}

export function countInlineTerminalContextPlaceholders(prompt: string): number {
  let count = 0;
  for (const char of prompt) {
    if (char === INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      count += 1;
    }
  }
  return count;
}

export function ensureInlineTerminalContextPlaceholders(
  prompt: string,
  terminalContextCount: number,
): string {
  const missingCount = terminalContextCount - countInlineTerminalContextPlaceholders(prompt);
  if (missingCount <= 0) {
    return prompt;
  }
  return `${INLINE_TERMINAL_CONTEXT_PLACEHOLDER.repeat(missingCount)}${prompt}`;
}

function isInlineTerminalContextBoundaryWhitespace(char: string | undefined): boolean {
  return char === undefined || char === " " || char === "\n" || char === "\t" || char === "\r";
}

export function insertInlineTerminalContextPlaceholder(
  prompt: string,
  cursorInput: number,
): { prompt: string; cursor: number; contextIndex: number } {
  const cursor = Math.max(0, Math.min(prompt.length, Math.floor(cursorInput)));
  const needsLeadingSpace = !isInlineTerminalContextBoundaryWhitespace(prompt[cursor - 1]);
  const replacement = `${needsLeadingSpace ? " " : ""}${INLINE_TERMINAL_CONTEXT_PLACEHOLDER} `;
  const rangeEnd = prompt[cursor] === " " ? cursor + 1 : cursor;
  return {
    prompt: `${prompt.slice(0, cursor)}${replacement}${prompt.slice(rangeEnd)}`,
    cursor: cursor + replacement.length,
    contextIndex: countInlineTerminalContextPlaceholders(prompt.slice(0, cursor)),
  };
}

export function stripInlineTerminalContextPlaceholders(prompt: string): string {
  return prompt.replaceAll(INLINE_TERMINAL_CONTEXT_PLACEHOLDER, "");
}

export function removeInlineTerminalContextPlaceholder(
  prompt: string,
  contextIndex: number,
): { prompt: string; cursor: number } {
  if (contextIndex < 0) {
    return { prompt, cursor: prompt.length };
  }

  let placeholderIndex = 0;
  for (let index = 0; index < prompt.length; index += 1) {
    if (prompt[index] !== INLINE_TERMINAL_CONTEXT_PLACEHOLDER) {
      continue;
    }
    if (placeholderIndex === contextIndex) {
      return {
        prompt: prompt.slice(0, index) + prompt.slice(index + 1),
        cursor: index,
      };
    }
    placeholderIndex += 1;
  }

  return { prompt, cursor: prompt.length };
}
