export type ComposerTriggerKind = "path" | "slash-command" | "slash-model";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? "")) {
    index -= 1;
  }
  return index + 1;
}

function dedupePaths(paths: string[]): string[] {
  const unique = new Set<string>();
  for (const rawPath of paths) {
    const normalized = rawPath.trim();
    if (!normalized) continue;
    unique.add(normalized);
  }
  return [...unique];
}

export function detectComposerTrigger(text: string, cursorInput: number): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch) {
      const commandQuery = commandMatch[1] ?? "";
      if (commandQuery.toLowerCase() === "model") {
        return {
          kind: "slash-model",
          query: "",
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      if ("model".startsWith(commandQuery.toLowerCase())) {
        return {
          kind: "slash-command",
          query: commandQuery,
          rangeStart: lineStart,
          rangeEnd: cursor,
        };
      }
      return null;
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (!token.startsWith("@")) {
    return null;
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
}

export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

export function buildPromptInput(text: string, taggedPaths: string[]): string {
  const trimmedPrompt = text.trim();
  const normalizedPaths = dedupePaths(taggedPaths);
  if (normalizedPaths.length === 0) {
    return trimmedPrompt;
  }

  const tagBlock = `Referenced paths:\n${normalizedPaths.map((entry) => `- ${entry}`).join("\n")}`;
  if (!trimmedPrompt) {
    return tagBlock;
  }
  return `${trimmedPrompt}\n\n${tagBlock}`;
}

export function buildUserVisiblePrompt(text: string, taggedPaths: string[]): string {
  const trimmedPrompt = text.trim();
  const normalizedPaths = dedupePaths(taggedPaths);
  if (normalizedPaths.length === 0) {
    return trimmedPrompt;
  }

  const tagsSummary = normalizedPaths.map((entry) => `@${entry}`).join(" ");
  if (!trimmedPrompt) {
    return tagsSummary;
  }
  return `${trimmedPrompt}\n\n${tagsSummary}`;
}
