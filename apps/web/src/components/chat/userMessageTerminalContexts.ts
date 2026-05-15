import { formatInlineTerminalContextLabel as formatInlineTerminalContextSelectionLabel } from "~/lib/terminalContext";

const TERMINAL_CONTEXT_HEADER_PATTERN = /^(.*?)\s+line(?:s)?\s+(\d+)(?:-(\d+))?$/i;

export function buildInlineTerminalContextText(
  contexts: ReadonlyArray<{
    header: string;
  }>,
): string {
  return contexts
    .map((context) => context.header.trim())
    .filter((header) => header.length > 0)
    .map(formatInlineTerminalContextLabel)
    .join(" ");
}

function visibleTerminalContextHeaders(
  contexts: ReadonlyArray<{
    header: string;
  }>,
): string[] {
  return contexts.map((context) => context.header.trim()).filter((header) => header.length > 0);
}

export function formatInlineTerminalContextLabel(header: string): string {
  const trimmedHeader = header.trim();
  const match = TERMINAL_CONTEXT_HEADER_PATTERN.exec(trimmedHeader);
  if (!match) {
    return `@${trimmedHeader.toLowerCase().replace(/\s+/g, "-")}`;
  }

  const lineStart = Number.parseInt(match[2] ?? "", 10);
  const lineEnd = Number.parseInt(match[3] ?? match[2] ?? "", 10);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) {
    return `@${trimmedHeader.toLowerCase().replace(/\s+/g, "-")}`;
  }

  return formatInlineTerminalContextSelectionLabel({
    terminalLabel: match[1]?.trim() || "terminal",
    lineStart,
    lineEnd,
  });
}

export function textContainsInlineTerminalContextLabels(
  text: string,
  contexts: ReadonlyArray<{
    header: string;
  }>,
): boolean {
  let searchStartIndex = 0;

  for (const context of contexts) {
    const label = formatInlineTerminalContextLabel(context.header);
    const matchIndex = text.indexOf(label, searchStartIndex);
    if (matchIndex === -1) {
      return false;
    }
    searchStartIndex = matchIndex + label.length;
  }

  return true;
}

export function buildRenderedUserMessageText(
  text: string,
  contexts: ReadonlyArray<{
    header: string;
  }>,
): string {
  const headers = visibleTerminalContextHeaders(contexts);
  if (headers.length === 0) {
    return text;
  }

  const visibleContexts = contexts.filter((context) => context.header.trim().length > 0);

  if (textContainsInlineTerminalContextLabels(text, visibleContexts)) {
    let cursor = 0;
    let renderedText = "";

    for (const context of visibleContexts) {
      const replacement = context.header.trim();
      const label = formatInlineTerminalContextLabel(context.header);
      const matchIndex = text.indexOf(label, cursor);
      if (matchIndex === -1) {
        return text;
      }

      renderedText += text.slice(cursor, matchIndex);
      renderedText += replacement;
      cursor = matchIndex + label.length;
    }

    return renderedText + text.slice(cursor);
  }

  return text.length > 0 ? `${headers.join(" ")} ${text}` : headers.join(" ");
}
