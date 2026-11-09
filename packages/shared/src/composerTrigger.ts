export type ComposerTriggerKind =
  | "path"
  | "file"
  | "thread"
  | "pull-request"
  | "jira"
  | "issue"
  | "figma"
  | "hash"
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

const AT_MENTION_KIND_BY_ALIAS = {
  file: "file",
  thread: "thread",
  pr: "pull-request",
  jira: "jira",
  issue: "issue",
  figma: "figma",
} as const satisfies Record<string, ComposerTriggerKind>;

export type DetectComposerTriggerOptions = {
  readonly isWhitespaceChar?: (char: string) => boolean;
  /** Labs: mention index. Off keeps classic bare `@` / `#` without typed filters. */
  readonly mentionIndexEnabled?: boolean;
};

/**
 * Bare `@` keeps the classic mixed menu (threads, machines, files).
 * With the mention-index labs flag on, `@file:` / `@thread:` / `@pr:` / `@jira:` /
 * `@issue:` / `@figma:` filter by type, and `#` opens PRs + issues together.
 */
export function detectAtMentionTrigger(
  token: string,
  tokenStart: number,
  cursor: number,
  mentionIndexEnabled = false,
): ComposerTrigger | null {
  if (!token.startsWith("@")) return null;

  if (mentionIndexEnabled) {
    const scoped = /^@(file|thread|pr|jira|issue|figma):(.*)$/iu.exec(token);
    if (scoped) {
      const alias = scoped[1]!.toLowerCase() as keyof typeof AT_MENTION_KIND_BY_ALIAS;
      const query = scoped[2] ?? "";
      return {
        kind: AT_MENTION_KIND_BY_ALIAS[alias],
        query,
        rangeStart: tokenStart,
        rangeEnd: cursor,
      };
    }
  }

  return {
    kind: "path",
    query: token.slice(1),
    rangeStart: tokenStart,
    rangeEnd: cursor,
  };
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

export function detectComposerTrigger(
  text: string,
  cursorInput: number,
  options?: DetectComposerTriggerOptions | ((char: string) => boolean),
): ComposerTrigger | null {
  const opts: DetectComposerTriggerOptions =
    typeof options === "function" ? { isWhitespaceChar: options } : (options ?? {});
  const mentionIndexEnabled = opts.mentionIndexEnabled === true;
  const cursor = clampCursor(text, cursorInput);
  const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
  const linePrefix = text.slice(lineStart, cursor);

  if (linePrefix.startsWith("/")) {
    const commandMatch = /^\/(\S*)$/.exec(linePrefix);
    if (
      commandMatch &&
      isPathWord(text, lineStart, cursor, opts.isWhitespaceChar ?? isWhitespace)
    ) {
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

  const wsCheck = opts.isWhitespaceChar ?? isWhitespace;
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
  const hashMatch = /^#([\p{L}\p{N}][\p{L}\p{N}_-]*)?$/u.exec(token);
  if (hashMatch)
    return {
      kind: mentionIndexEnabled ? "hash" : "pull-request",
      query: hashMatch[1] ?? "",
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
  return detectAtMentionTrigger(token, tokenStart, cursor, mentionIndexEnabled);
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
