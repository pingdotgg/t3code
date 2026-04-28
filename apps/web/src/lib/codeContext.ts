import { type ThreadId } from "@forma/contracts";
import { basenameOfPath } from "../vscode-icons";
import {
  countInlineComposerContextPlaceholders,
  ensureInlineComposerContextPlaceholders,
  insertInlineComposerContextPlaceholder,
  removeInlineComposerContextPlaceholder,
  stripInlineComposerContextPlaceholders,
} from "./inlineComposerContextPlaceholders";

export interface CodeContextSelection {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  text: string;
}

export interface CodeContextDraft extends CodeContextSelection {
  id: string;
  threadId: ThreadId;
  createdAt: string;
}

export interface ParsedCodeContextEntry {
  header: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  body: string;
}

export interface ExtractedCodeContexts {
  promptText: string;
  contextCount: number;
  previewTitle: string | null;
  contexts: ParsedCodeContextEntry[];
}

export const INLINE_CODE_CONTEXT_PLACEHOLDER = "\uFFF1";
export const MAX_CODE_CONTEXT_LINES = 200;
export const MAX_CODE_CONTEXT_CHARACTERS = 12_000;

const TRAILING_CODE_CONTEXT_BLOCK_PATTERN = /\n*<code_context>\n([\s\S]*?)\n<\/code_context>\s*$/;
const CODE_CONTEXT_HEADER_PATTERN = /^(.+?)\s+line(?:s)?\s+(\d+)(?:-(\d+))?$/i;

export function normalizeCodeContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
}

export function hasCodeContextText(context: { text: string }): boolean {
  return normalizeCodeContextText(context.text).length > 0;
}

export function filterCodeContextsWithText<T extends { text: string }>(
  contexts: ReadonlyArray<T>,
): T[] {
  return contexts.filter((context) => hasCodeContextText(context));
}

function previewCodeContextText(text: string): string {
  const normalized = normalizeCodeContextText(text);
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

export function normalizeCodeContextSelection(
  selection: CodeContextSelection,
): CodeContextSelection | null {
  const text = normalizeCodeContextText(selection.text);
  const filePath = selection.filePath.trim();
  if (text.length === 0 || filePath.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(selection.lineStart));
  const lineCount = text.split("\n").length;
  return {
    filePath,
    lineStart,
    lineEnd: Math.max(lineStart, lineStart + lineCount - 1),
    text,
  };
}

export function formatCodeContextRange(selection: { lineStart: number; lineEnd: number }): string {
  return selection.lineStart === selection.lineEnd
    ? `line ${selection.lineStart}`
    : `lines ${selection.lineStart}-${selection.lineEnd}`;
}

export function formatCodeContextLabel(selection: {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return `${selection.filePath} ${formatCodeContextRange(selection)}`;
}

export function formatInlineCodeContextLabel(selection: {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}): string {
  const range =
    selection.lineStart === selection.lineEnd
      ? `${selection.lineStart}`
      : `${selection.lineStart}-${selection.lineEnd}`;
  return `#${selection.filePath}:${range}`;
}

export function buildCodeContextPreviewTitle(
  contexts: ReadonlyArray<CodeContextSelection>,
): string | null {
  if (contexts.length === 0) {
    return null;
  }
  const previews = contexts
    .map((context) => {
      const normalized = normalizeCodeContextSelection(context);
      if (!normalized) {
        return null;
      }
      const preview = previewCodeContextText(normalized.text);
      return preview.length > 0
        ? `${formatCodeContextLabel(normalized)}\n${preview}`
        : formatCodeContextLabel(normalized);
    })
    .filter((value): value is string => value !== null)
    .join("\n\n");
  return previews.length > 0 ? previews : null;
}

function buildCodeContextBodyLines(selection: CodeContextSelection): string[] {
  return normalizeCodeContextText(selection.text)
    .split("\n")
    .map((line, index) => `  ${selection.lineStart + index} | ${line}`);
}

export function buildCodeContextBlock(contexts: ReadonlyArray<CodeContextSelection>): string {
  const normalizedContexts = contexts
    .map((context) => normalizeCodeContextSelection(context))
    .filter((context): context is CodeContextSelection => context !== null);
  if (normalizedContexts.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (let index = 0; index < normalizedContexts.length; index += 1) {
    const context = normalizedContexts[index]!;
    lines.push(`- ${formatCodeContextLabel(context)}:`);
    lines.push(...buildCodeContextBodyLines(context));
    if (index < normalizedContexts.length - 1) {
      lines.push("");
    }
  }
  return ["<code_context>", ...lines, "</code_context>"].join("\n");
}

export function materializeInlineCodeContextPrompt(
  prompt: string,
  contexts: ReadonlyArray<{
    filePath: string;
    lineStart: number;
    lineEnd: number;
  }>,
): string {
  let nextContextIndex = 0;
  let result = "";

  for (const char of prompt) {
    if (char !== INLINE_CODE_CONTEXT_PLACEHOLDER) {
      result += char;
      continue;
    }
    const context = contexts[nextContextIndex] ?? null;
    nextContextIndex += 1;
    if (!context) {
      continue;
    }
    result += formatInlineCodeContextLabel(context);
  }

  return result;
}

export function appendCodeContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<CodeContextSelection>,
): string {
  const trimmedPrompt = materializeInlineCodeContextPrompt(prompt, contexts).trim();
  const contextBlock = buildCodeContextBlock(contexts);
  if (contextBlock.length === 0) {
    return trimmedPrompt;
  }
  return trimmedPrompt.length > 0 ? `${trimmedPrompt}\n\n${contextBlock}` : contextBlock;
}

export function extractTrailingCodeContexts(prompt: string): ExtractedCodeContexts {
  const match = TRAILING_CODE_CONTEXT_BLOCK_PATTERN.exec(prompt);
  if (!match) {
    return {
      promptText: prompt,
      contextCount: 0,
      previewTitle: null,
      contexts: [],
    };
  }
  const promptText = prompt.slice(0, match.index).replace(/\n+$/, "");
  const parsedContexts = parseCodeContextEntries(match[1] ?? "");
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

function parseCodeContextHeader(header: string): {
  filePath: string;
  lineStart: number;
  lineEnd: number;
} | null {
  const trimmedHeader = header.trim();
  const match = CODE_CONTEXT_HEADER_PATTERN.exec(trimmedHeader);
  if (!match) {
    return null;
  }
  const lineStart = Number.parseInt(match[2] ?? "", 10);
  const lineEnd = Number.parseInt(match[3] ?? match[2] ?? "", 10);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) {
    return null;
  }
  const filePath = match[1]?.trim() ?? "";
  if (filePath.length === 0) {
    return null;
  }
  return {
    filePath,
    lineStart,
    lineEnd,
  };
}

function parseCodeContextEntries(block: string): ParsedCodeContextEntry[] {
  const entries: ParsedCodeContextEntry[] = [];
  let current: {
    header: string;
    bodyLines: string[];
    filePath: string;
    lineStart: number;
    lineEnd: number;
  } | null = null;

  const commitCurrent = () => {
    if (!current) {
      return;
    }
    entries.push({
      header: current.header,
      filePath: current.filePath,
      lineStart: current.lineStart,
      lineEnd: current.lineEnd,
      body: current.bodyLines.join("\n").trimEnd(),
    });
    current = null;
  };

  for (const rawLine of block.split("\n")) {
    const headerMatch = /^- (.+):$/.exec(rawLine);
    if (headerMatch) {
      commitCurrent();
      const parsedHeader = parseCodeContextHeader(headerMatch[1] ?? "");
      if (!parsedHeader) {
        continue;
      }
      current = {
        header: headerMatch[1]!,
        bodyLines: [],
        ...parsedHeader,
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

export function countInlineCodeContextPlaceholders(prompt: string): number {
  return countInlineComposerContextPlaceholders(prompt, INLINE_CODE_CONTEXT_PLACEHOLDER);
}

export function ensureInlineCodeContextPlaceholders(
  prompt: string,
  codeContextCount: number,
): string {
  return ensureInlineComposerContextPlaceholders(
    prompt,
    codeContextCount,
    INLINE_CODE_CONTEXT_PLACEHOLDER,
  );
}

export function insertInlineCodeContextPlaceholder(
  prompt: string,
  cursorInput: number,
): { prompt: string; cursor: number; contextIndex: number } {
  return insertInlineComposerContextPlaceholder(
    prompt,
    cursorInput,
    INLINE_CODE_CONTEXT_PLACEHOLDER,
  );
}

export function stripInlineCodeContextPlaceholders(prompt: string): string {
  return stripInlineComposerContextPlaceholders(prompt, [INLINE_CODE_CONTEXT_PLACEHOLDER]);
}

export function removeInlineCodeContextPlaceholder(
  prompt: string,
  contextIndex: number,
): { prompt: string; cursor: number } {
  return removeInlineComposerContextPlaceholder(
    prompt,
    INLINE_CODE_CONTEXT_PLACEHOLDER,
    contextIndex,
  );
}

export function isCodeContextSelectionWithinLimits(selection: { text: string }): boolean {
  const normalized = normalizeCodeContextText(selection.text);
  if (normalized.length === 0) {
    return true;
  }
  return (
    normalized.split("\n").length <= MAX_CODE_CONTEXT_LINES &&
    normalized.length <= MAX_CODE_CONTEXT_CHARACTERS
  );
}

export function getCodeContextSelectionLimitMessage(selection: { text: string }): string | null {
  return isCodeContextSelectionWithinLimits(selection)
    ? null
    : `Selections are limited to ${MAX_CODE_CONTEXT_LINES} lines or ${MAX_CODE_CONTEXT_CHARACTERS.toLocaleString()} characters.`;
}

export function buildCodeContextInlineChipLabel(selection: {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}): string {
  return `${basenameOfPath(selection.filePath)} ${formatCodeContextRange(selection)}`;
}
