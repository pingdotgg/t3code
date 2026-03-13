import { type ThreadId } from "@t3tools/contracts";

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
}

const TRAILING_TERMINAL_CONTEXT_BLOCK_PATTERN =
  /\n*<terminal_context>\n([\s\S]*?)\n<\/terminal_context>\s*$/;

function normalizeTerminalContextText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
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

export function buildTerminalContextPreviewTitle(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string | null {
  if (contexts.length === 0) {
    return null;
  }
  return contexts
    .map((context) => {
      const normalized = normalizeTerminalContextSelection(context);
      if (!normalized) {
        return null;
      }
      const preview = previewTerminalContextText(normalized.text);
      return preview.length > 0
        ? `${formatTerminalContextLabel(normalized)}\n${preview}`
        : formatTerminalContextLabel(normalized);
    })
    .filter((value): value is string => value !== null)
    .join("\n\n");
}

function buildTerminalContextBodyLines(selection: TerminalContextSelection): string[] {
  return normalizeTerminalContextText(selection.text)
    .split("\n")
    .map((line, index) => `  ${selection.lineStart + index} | ${line}`);
}

export function buildTerminalContextBlock(
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const normalizedContexts = contexts
    .map((context) => normalizeTerminalContextSelection(context))
    .filter((context): context is TerminalContextSelection => context !== null);
  if (normalizedContexts.length === 0) {
    return "";
  }
  const lines: string[] = [];
  for (let index = 0; index < normalizedContexts.length; index += 1) {
    const context = normalizedContexts[index]!;
    lines.push(`- ${formatTerminalContextLabel(context)}:`);
    lines.push(...buildTerminalContextBodyLines(context));
    if (index < normalizedContexts.length - 1) {
      lines.push("");
    }
  }
  return ["<terminal_context>", ...lines, "</terminal_context>"].join("\n");
}

export function appendTerminalContextsToPrompt(
  prompt: string,
  contexts: ReadonlyArray<TerminalContextSelection>,
): string {
  const trimmedPrompt = prompt.trim();
  const contextBlock = buildTerminalContextBlock(contexts);
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
  };
}

function parseTerminalContextEntries(block: string): Array<{ header: string; body: string }> {
  const entries: Array<{ header: string; body: string }> = [];
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
