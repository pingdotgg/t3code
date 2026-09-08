import { formatInlineTerminalContextLabel as formatInlineTerminalContextSelectionLabel } from "./terminalContext.ts";

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

type TerminalContextSegment<Context> =
  | { readonly kind: "text"; readonly text: string; readonly start: number }
  | { readonly kind: "terminal"; readonly context: Context; readonly start: number };

/** Returns null when labels cannot be replaced in context order, leaving the prompt intact. */
export function splitUserMessageTerminalContexts<Context extends { readonly header: string }>(
  text: string,
  contexts: ReadonlyArray<Context>,
): TerminalContextSegment<Context>[] | null {
  const segments: TerminalContextSegment<Context>[] = [];
  let cursor = 0;
  for (const context of contexts) {
    const label = formatInlineTerminalContextLabel(context.header);
    const index = text.indexOf(label, cursor);
    if (index === -1) return null;
    if (index > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, index), start: cursor });
    }
    segments.push({ kind: "terminal", context, start: index });
    cursor = index + label.length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor), start: cursor });
  }
  return segments;
}
