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

export function formatInlineTerminalContextLabel(header: string): string {
  const trimmedHeader = header.trim();
  const match = TERMINAL_CONTEXT_HEADER_PATTERN.exec(trimmedHeader);
  if (!match) {
    return `@${trimmedHeader.toLowerCase().replace(/\s+/g, "-")}`;
  }

  const terminalLabel = match[1]?.trim().toLowerCase().replace(/\s+/g, "-") ?? "terminal";
  const rangeStart = match[2] ?? "";
  const rangeEnd = match[3] ?? "";
  const range = rangeEnd.length > 0 ? `${rangeStart}-${rangeEnd}` : rangeStart;
  return `@${terminalLabel}:${range}`;
}
