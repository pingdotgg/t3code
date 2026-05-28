import { formatInlineTerminalContextLabel as formatInlineTerminalContextSelectionLabel } from "~/lib/terminalContext";

const TERMINAL_CONTEXT_HEADER_PATTERN = /^(.*?)\s+line(?:s)?\s+(\d+)(?:-(\d+))?$/i;

export function buildInlineTerminalContextText(
  contexts: ReadonlyArray<{
    header: string;
  }>,
): string {
  const labels: Array<string> = [];
  for (const context of contexts) {
    const header = context.header.trim();
    if (header.length > 0) {
      labels.push(formatInlineTerminalContextLabel(header));
    }
  }
  return labels.join(" ");
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
