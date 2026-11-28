import { parseFileUrlHref, resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { isMacPlatform } from "./lib/utils";

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
  /**
   * `text` cut after its `:line:col`, or with its closing `(line,col)` or `:[line,col]`, or its
   * closing `:line` and the number after it, read as one. Only the filesystem can tell grep's
   * `./a.js:1:function` or MSBuild's `/a.cs(1,2)` from a name that holds those characters, so
   * this stands in when `text` as a whole is not a file.
   */
  fallback?: { text: string; end: number };
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
}

export interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number;
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface WrappedTerminalLinkLine {
  text: string;
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/giu;
// The default PowerShell prompt delimits its unquoted path with `PS ` and `>`.
const POWERSHELL_PROMPT_PATH_PATTERN = /^PS ((?:[A-Za-z]:[\\/]|\\\\|\/)[^>\r\n]*)>/u;
// Bare paths start only at a segment boundary: hover detection runs this on
// every frame, so separator-free output must not be rescanned at every suffix.
// Parenthesized path segments need a following slash to distinguish compiler locations.
// A bare `name.ext` needs `:line:col` or a TS location after it, so prose and `host:port` stay text.
const FILE_PATH_PATTERN =
  /(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|(?<![\p{L}\p{M}\p{N}._$+@-])[\p{L}\p{M}\p{N}._$+@-]+(?:(?:[\\/](?:[\p{L}\p{M}\p{N}._$+@-]|\[{1,2}[\p{L}\p{M}\p{N}._-]+\]{1,2}|\([\p{L}\p{M}\p{N}._-]+\)(?=[\\/]))+)+|\.\p{L}[\p{L}\p{M}\p{N}_-]*(?=:\d+:\d|\(\d+,\d+\):\s+(?:error|warning) TS\d+:))(?:(?::\d+){1,2}|\(\d+,\d+\)(?=:\s+(?:error|warning) TS\d+:))?/gu;
const QUOTED_FILE_PATH_PATTERN =
  /(["'`])(?<path>(?:~[\\/]|\.{1,2}[\\/]|\/|[A-Za-z]:[\\/]|\\\\|[\p{L}\p{M}\p{N}._ -]+[\\/])[^\r\n]*?|[\p{L}\p{M}\p{N}._ -]+\.[\p{L}\p{M}\p{N}_-]+(?::\d+){0,2})\1(?<position>(?::\d+){0,2})/gu;
// The `:line` or `:line:col` that grep, ripgrep and Ruby backtraces follow with a colon and text.
const POSITION_BEFORE_TEXT_PATTERN = /^.+?(?::\d+){1,2}(?=:)/u;
const POSITIONS_ONLY_PATTERN = /^(?::\d+)+$/u;
// The `(line)` or `(line,col)` that MSBuild, MSVC and PHP stack frames put right after a file name.
const PARENTHESIZED_POSITION_PATTERN = /(?<![\\/])\((\d+)(?:,(\d+))?\)$/u;
// The `:[line]` or `:[line,col]` that Maven's compiler plugin puts there instead.
const BRACKETED_POSITION_PATTERN = /(?<![\\/]):\[(\d+)(?:,(\d+))?\]$/u;
// The `:line 29` that .NET stack frames put there; the candidate stops at the space, so the
// number is read from the text after it.
const LINE_WORD_PATTERN = /(?<![\\/]):line$/u;
const NUMBER_AFTER_LINE_WORD_PATTERN = /^ (\d+)\b/u;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;
// Paths also drop a trailing colon: compilers end `file:line:col:` with one.
const TRAILING_PATH_PUNCTUATION_PATTERN = /[.,;:!?]+$/;
// A question mark is legal in filenames; only exclude query-bearing request targets.
const REQUEST_ROUTE_PATTERN =
  /(?:^|[\s"'`])(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE|proxying)\s+["'`]?(?:\/|[A-Za-z0-9_-]+\/)[^\s?]*\?\S*/g;
// The tail of `redis://host/0` or `file:///a.mjs` is not a path. One-letter schemes stay drives,
// a diff's `+` or `-` may lead, and the lookbehind keeps runs from being rescanned at every suffix.
const SCHEME_URL_PATTERN = /(?<![A-Za-z\d+.-])[+-]?[A-Za-z][A-Za-z\d+.-]+:\/\/[^\s"'`<>]+/gu;
// Nor is the tail of an SCP-style Git remote such as `git@github.com:acme/widgets.git`. Only a
// path wholly inside the tail is dropped, so `src/contact@support.vue:12:3` keeps its link.
const SCP_REMOTE_PATTERN = /(?<![\w.@-])[\w.-]+@[\w.-]+:[^\s"'`<>]+/gu;

function trimClosingDelimiters(value: string, kind: TerminalLinkKind): string {
  const output = value.replace(
    kind === "path" ? TRAILING_PATH_PUNCTUATION_PATTERN : TRAILING_PUNCTUATION_PATTERN,
    "",
  );
  if (output.length === 0) return output;
  let end = output.length;

  const trimUnbalanced = (open: string, close: string) => {
    if (output[end - 1] !== close) return;
    let excess = output.split(close).length - output.split(open).length;
    while (excess > 0 && output[end - 1] === close) {
      end -= 1;
      excess -= 1;
    }
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output.slice(0, end);
}

function toPosition(_: string, row: string, column?: string): string {
  return column === undefined ? `:${row}` : `:${row}:${column}`;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const quotedPath = rawMatch.groups?.path;
    const raw =
      quotedPath === undefined ? rawMatch[0] : quotedPath + (rawMatch.groups?.position ?? "");
    const start = rawMatch.index + (quotedPath === undefined ? 0 : 1);
    if (start < 0 || raw.length === 0) continue;

    const trimmed = quotedPath === undefined ? trimClosingDelimiters(raw, kind) : raw;
    if (trimmed.length === 0) continue;
    if (kind === "path" && isTerminalUrl(trimmed)) continue;

    const cut =
      kind === "path" && quotedPath === undefined
        ? POSITION_BEFORE_TEXT_PATTERN.exec(trimmed)?.[0]
        : undefined;
    // What follows `main.c:10` in `main.c:10:5` is its column, not text.
    const fallback =
      cut !== undefined && !POSITIONS_ONLY_PATTERN.test(trimmed.slice(cut.length))
        ? cut
        : undefined;
    const text =
      kind === "path" && /^:\s+(?:error|warning) TS\d+:/u.test(line.slice(start + trimmed.length))
        ? trimmed.replace(/\((\d+),(\d+)\)$/, ":$1:$2")
        : trimmed;
    const located =
      kind === "path" && quotedPath === undefined
        ? text
            .replace(PARENTHESIZED_POSITION_PATTERN, toPosition)
            .replace(BRACKETED_POSITION_PATTERN, toPosition)
            .replace(LINE_WORD_PATTERN, (word) => {
              const row = NUMBER_AFTER_LINE_WORD_PATTERN.exec(line.slice(start + trimmed.length));
              return row ? `:${row[1]}` : word;
            })
        : text;
    const candidate: TerminalLinkMatch = {
      kind,
      text,
      start,
      // A position outside quotes spans the closing quote in the terminal buffer.
      end: start + trimmed.length + (rawMatch.groups?.position ? 1 : 0),
      ...(fallback !== undefined
        ? { fallback: { text: fallback, end: start + fallback.length } }
        : located !== text
          ? { fallback: { text: located, end: start + trimmed.length } }
          : {}),
    };

    const collides = [...existing, ...matches].some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const promptPath = POWERSHELL_PROMPT_PATH_PATTERN.exec(line)?.[1];
  const promptMatches: TerminalLinkMatch[] = promptPath
    ? [{ kind: "path", text: promptPath, start: 3, end: 3 + promptPath.length }]
    : [];
  const nonPathRanges = Array.from(
    [...line.matchAll(REQUEST_ROUTE_PATTERN), ...line.matchAll(SCHEME_URL_PATTERN)],
    (match) => ({ start: match.index, end: match.index + match[0].length }),
  );
  const remoteTails = Array.from(line.matchAll(SCP_REMOTE_PATTERN), (match) => ({
    start: match.index + match[0].indexOf(":") + 1,
    end: match.index + match[0].length,
  }));
  const urlMatches = collectMatches(line, "url", URL_PATTERN, promptMatches);
  const quotedMatches = collectMatches(line, "path", QUOTED_FILE_PATH_PATTERN, [
    ...promptMatches,
    ...urlMatches,
  ]);
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, [
    ...promptMatches,
    ...urlMatches,
    ...quotedMatches,
  ]);
  return [...promptMatches, ...urlMatches, ...quotedMatches, ...pathMatches]
    .filter(
      (match) =>
        match.kind === "url" ||
        (!nonPathRanges.some((range) => overlaps(match, range)) &&
          !remoteTails.some((tail) => match.start >= tail.start && match.end <= tail.end)),
    )
    .toSorted((a, b) => a.start - b.start);
}

export function isTerminalUrl(value: string): boolean {
  return /^https?:\/\//iu.test(value);
}

/**
 * Explicit OSC 8 targets may be `file://` URIs; everything else is a path relative to `cwd`.
 * `hostname` is the terminal's environment's, which producers such as GNU `ls` put in the URI.
 * A URI's path is the exact filename, so only its `#L12C3` hash is a position.
 */
export function resolveTerminalLinkTarget(text: string, cwd: string, hostname?: string): string {
  const fileUrl = /^file:\/\//iu.test(text) ? parseFileUrlHref(text, hostname) : null;
  if (!fileUrl) return resolvePathLinkTarget(text, cwd);
  // Keep URI identity until consumers decode the filename, separately from its position.
  const uri = new URL(text);
  if (!fileUrl.path.startsWith("\\")) uri.hostname = "";
  return uri.href;
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;

  while (startBufferLineNumber > 1 && startLine.isWrapped) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) return null;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;

  while (true) {
    const currentLine = getLine(currentBufferLineNumber - 1);
    if (!currentLine) break;

    const nextLine = getLine(currentBufferLineNumber);
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    const text = currentLine.translateToString(!hasWrappedContinuation);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
