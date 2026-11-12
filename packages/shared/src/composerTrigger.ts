export type ComposerTriggerKind =
  | "path"
  | "pull-request"
  | "slash-command"
  | "slash-model"
  | "skill";
export type ComposerSlashCommand = "model" | "plan" | "default";

export interface ComposerTrigger {
  kind: ComposerTriggerKind;
  query: string;
  rangeStart: number;
  rangeEnd: number;
}

function composerFileLinkBasename(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function encodeMarkdownLinkDestination(path: string): string {
  return encodeURI(path)
    .replaceAll("(", "%28")
    .replaceAll(")", "%29")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replaceAll("\\", "%5C");
}

export function serializeComposerFileLink(path: string): string {
  const label = escapeMarkdownLinkLabel(composerFileLinkBasename(path));
  return `[${label}](${encodeMarkdownLinkDestination(path)})`;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/** A second slash makes the whole word a path, even when the caret precedes that slash. */
export function isPathWord(
  text: string,
  wordStart: number,
  cursor: number,
  isWhitespaceChar: (char: string) => boolean,
): boolean {
  let wordEnd = cursor;
  while (wordEnd < text.length && !isWhitespaceChar(text[wordEnd] ?? "")) {
    wordEnd += 1;
  }
  return text.slice(wordStart + 1, wordEnd).includes("/");
}

/**
 * `$5`, `€9.99` and `$10k` are money, not skills. Matches the amounts the inline skill
 * token regexes already refuse to render as skills, plus the punctuation prose puts after
 * one (`$10k.`, `($5)`).
 */
export function isCurrencyAmountQuery(query: string): boolean {
  return /^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$/.test(query);
}

interface Fence {
  readonly marker: string;
  readonly length: number;
}

/**
 * A fence a line opens. Chat drafts often end a sentence with ``` and put the code below,
 * so a trailing unpaired backtick fence counts as an opener too.
 */
// Fences may sit inside blockquotes and list items; their markers come before the fence.
const withoutContainerMarkers = (line: string) =>
  line.replace(/^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*/, "");

function fenceOpenedBy(rawLine: string): Fence | null {
  const line = withoutContainerMarkers(rawLine);
  const opener = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
  if (opener && !(opener[1]!.startsWith("`") && opener[2]!.includes("`"))) {
    return { marker: opener[1]![0]!, length: opener[1]!.length };
  }
  const trailing = /(`{3,})[ \t]*$/.exec(line);
  if (!trailing) return null;
  const runs = line.match(/`+/g) ?? [];
  return runs.filter((run) => run.length === trailing[1]!.length).length === 1
    ? { marker: "`", length: trailing[1]!.length }
    : null;
}

function closesFence(line: string, fence: Fence): boolean {
  const closer = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(withoutContainerMarkers(line))?.[1];
  return closer !== undefined && closer[0] === fence.marker && closer.length >= fence.length;
}

/**
 * Whether `paragraph` ends inside a code span. A span may cross a newline once closed, but
 * an unclosed one only counts on the line being typed.
 */
function endsInsideCodeSpan(paragraph: string): boolean {
  const runs = [...paragraph.matchAll(/`+/g)];
  for (let index = 0; index < runs.length; index += 1) {
    const open = runs[index]!;
    const close = runs.findIndex((run, at) => at > index && run[0].length === open[0].length);
    if (close < 0) return !paragraph.slice(open.index).includes("\n");
    index = close;
  }
  return false;
}

/** Fences are tracked line by line, then code spans within the current paragraph only. */
function isInsideMarkdownCode(text: string, index: number): boolean {
  const before = text.slice(0, index);
  if (!before.includes("`") && !before.includes("~~~")) return false;
  const lines = before.split("\n");
  const current = lines.pop() ?? "";
  let fence: Fence | null = null;
  let paragraph: string[] = [];
  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    fence = fenceOpenedBy(line);
    paragraph = fence || line.trim() === "" ? [] : [...paragraph, line];
  }
  return fence !== null || endsInsideCodeSpan([...paragraph, current].join("\n"));
}

export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  isWhitespaceChar?: (char: string) => boolean,
): ComposerTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (commandMatch && isPathWord(text, lineStart, cursor, isWhitespaceChar ?? isWhitespace)) {
      return null;
    }
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
      return {
        kind: "slash-command",
        query: commandQuery,
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }

    const modelMatch = /^\/model(?:\s+(.*))?$/i.exec(linePrefix);
    if (modelMatch) {
      return {
        kind: "slash-model",
        query: (modelMatch[1] ?? "").trim(),
        rangeStart: lineStart,
        rangeEnd: cursor,
      };
    }
  }

  const wsCheck = isWhitespaceChar ?? isWhitespace;
  let tokenIdx = cursor - 1;
  while (tokenIdx >= 0 && !wsCheck(text[tokenIdx] ?? "")) {
    tokenIdx -= 1;
  }
  const tokenStart = tokenIdx + 1;

  const token = text.slice(tokenStart, cursor);
  if (token.startsWith("/")) {
    if (isPathWord(text, tokenStart, cursor, wsCheck)) return null;
    return {
      kind: "slash-command",
      query: token.slice(1),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  const pullRequestMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (pullRequestMatch)
    return {
      kind: "pull-request",
      query: pullRequestMatch[1] ?? "",
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  const skillPrefix = /^\p{Sc}/u.exec(token);
  if (skillPrefix) {
    if (isCurrencyAmountQuery(token.slice(skillPrefix[0].length))) return null;
    return {
      kind: "skill",
      query: token.slice(skillPrefix[0].length),
      rangeStart: tokenStart,
      rangeEnd: cursor,
    };
  }
  // Mentions are for prose: `@` in code stays literal.
  if (!token.startsWith("@") || isInsideMarkdownCode(text, tokenStart)) {
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

/** `/clear` as the whole message arms a fresh session instead of sending. */
export function isClearComposerCommand(text: string): boolean {
  return /^\/clear\s*$/i.test(text.trim());
}

/** `/side [prompt]`, or its alias `/btw [prompt]`, as the whole message. */
export function parseSideChatCommand(text: string): { prompt: string } | null {
  const match = /^\/(?:side|btw)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return match ? { prompt: match[1]?.trim() ?? "" } : null;
}
