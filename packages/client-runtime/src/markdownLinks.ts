import { isWindowsAbsolutePath } from "@t3tools/shared/path";

const SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN = /^\/[A-Za-z]:[\\/]/;
// Alt text carries escapes and one level of balanced brackets, both of which
// CommonMark allows; `[^\]]*` alone leaves `![see \[this\]](…)` unrepaired.
const IMAGE_OPEN_PATTERN = new RegExp(
  String.raw`!\[(?:[^\][\\\n]|\\.|\[(?:[^\][\\\n]|\\.)*\])*\]\(`,
  "g",
);
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/;
// CommonMark's block tag list, which is what separates an HTML block from a
// paragraph that happens to open with a tag.
const HTML_BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";
const HTML_BLOCKS = [
  {
    start: /^ {0,3}<\/?(?:pre|script|style|textarea)(?:[\s/>]|$)/i,
    end: /<\/(?:pre|script|style|textarea)>/i,
  },
  { start: /^ {0,3}<!--/, end: /-->/ },
  { start: /^ {0,3}<\?/, end: /\?>/ },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/ },
  { start: /^ {0,3}<![A-Za-z]/, end: />/ },
  { start: new RegExp(`^ {0,3}</?(?:${HTML_BLOCK_TAGS})(?:[\\s/>]|$)`, "i"), end: "blank" },
] as const;
// A complete tag alone on its line is a block too, but only where a block can
// start — inside a paragraph it is ordinary inline HTML.
const HTML_BLOCK_STANDALONE_TAG_PATTERN =
  /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>]*?)?\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/;
// A heading or a thematic break is a leaf block: it ends on its own line, so
// the paragraph it looked like it was continuing is closed after it.
const PARAGRAPH_ENDING_LINE_PATTERN =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|=+[ \t]*$|(?:\*[ \t]*){3,}$|(?:-[ \t]*){3,}$|(?:_[ \t]*){3,}$)/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\/)+[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN =
  /^[A-Za-z0-9._-]+(?: +[A-Za-z0-9._-]+)*\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_SUFFIX_CAPTURE_PATTERN = /:(\d+)(?::(\d+))?$/;
const POSITION_HASH_PATTERN = /^#L(\d+)(?:C(\d+))?$/i;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;
// Standard OS and dev-container roots; deliberately excludes app-route-ish
// prefixes like /app/ or /chat/ so SPA routes never read as files.
const POSIX_FILE_ROOT_PREFIXES = [
  "/Users/",
  "/home/",
  "/tmp/",
  "/var/",
  "/etc/",
  "/opt/",
  "/mnt/",
  "/Volumes/",
  "/private/",
  "/root/",
  "/usr/",
  "/bin/",
  "/sbin/",
  "/lib/",
  "/lib64/",
  "/srv/",
  "/dev/",
  "/proc/",
  "/sys/",
  "/run/",
  "/boot/",
  "/media/",
  "/workspace/",
  "/workspaces/",
] as const;
// `Name:digits` also matches `error:1`, `port:3000`, and `TODO:12`.
const EXTENSIONLESS_FILE_NAMES = new Set([
  "Makefile",
  "makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "Brewfile",
  "Caddyfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Podfile",
  "Fastfile",
  "BUILD",
  "WORKSPACE",
  "LICENSE",
  "LICENCE",
  "COPYING",
  "NOTICE",
  "AUTHORS",
  "CONTRIBUTORS",
  "CHANGELOG",
  "README",
  "CODEOWNERS",
]);
const SINGLE_LABEL_HOSTNAMES = new Set(["localhost"]);
// These allowlists avoid classifying dotted directories such as `conf.d/`
// or filenames such as `Makefile.in:12` as hosts.
const GENERIC_HOSTNAME_TLDS = new Set([
  "com",
  "net",
  "org",
  "io",
  "dev",
  "app",
  "ai",
  "co",
  "edu",
  "gov",
  "mil",
  "info",
  "biz",
  "xyz",
  "me",
  "tv",
  "cc",
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);
// Country codes also name file extensions. A :line suffix makes `.pl`
// and `.pt` files more likely than hostnames.
const COUNTRY_HOSTNAME_TLDS = new Set([
  "uk",
  "de",
  "fr",
  "nl",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "ch",
  "at",
  "be",
  "es",
  "it",
  "pt",
  "eu",
  "us",
  "ca",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "br",
  "ru",
  "mx",
  "ie",
  "cz",
  "tr",
  "sg",
  "hk",
]);

function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels.at(-1);
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

/**
 * Picks path-shaped inline code for the client's markdown file-link resolver.
 * It does not resolve paths or turn plain prose and fenced code into links.
 */
export function inlineCodeFilePathCandidate(codeText: string): string | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed)) return null;

  const candidate = isWindowsAbsolutePath(trimmed) ? trimmed : trimmed.replaceAll("\\", "/");
  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith("/") ||
    isWindowsAbsolutePath(candidate);
  if (!hasExplicitPathShape) {
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    const basename =
      withoutPosition
        .replace(/[/\\]+$/, "")
        .split(/[\\/]/)
        .at(-1) ?? "";
    if (!hasPosition && !FILE_EXTENSION_PATTERN.test(basename)) return null;
  }
  return candidate;
}

export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeMarkdownLinkDestination(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
}

/** Browser URL parsers write `C:/foo` as `/C:/foo` for file URLs. */
export function stripSlashPrefixedWindowsDrive(path: string): string {
  return SLASH_PREFIXED_WINDOWS_DRIVE_PATTERN.test(path) ? path.slice(1) : path;
}

export function splitMarkdownLinkSearchAndHash(value: string): {
  readonly path: string;
  readonly hash: string;
} {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  return {
    path: queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch,
    hash,
  };
}

/**
 * Turns a `file:` URL into a host path, still percent-encoded so callers that
 * decode every destination in one place do not decode file URLs twice. A
 * non-localhost authority becomes a UNC share.
 */
export function parseFileUrlHref(
  href: string,
): { readonly path: string; readonly hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const uncHostname = parsed.hostname.toLowerCase() === "localhost" ? "" : parsed.hostname;
    const path = uncHostname
      ? `\\\\${uncHostname}${parsed.pathname.replaceAll("/", "\\")}`
      : parsed.pathname;
    if (path.length === 0) return null;
    return { path: stripSlashPrefixedWindowsDrive(path), hash: parsed.hash };
  } catch {
    return null;
  }
}

export interface FilePathPosition {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
}

export function splitFilePathPosition(path: string, hash = ""): FilePathPosition {
  const suffixMatch = path.match(POSITION_SUFFIX_CAPTURE_PATTERN);
  const match = suffixMatch ?? hash.match(POSITION_HASH_PATTERN);
  if (!match?.[1]) return { path };

  const line = Number.parseInt(match[1], 10);
  const column = match[2] === undefined ? undefined : Number.parseInt(match[2], 10);
  return {
    path: suffixMatch ? path.slice(0, -suffixMatch[0].length) : path,
    ...(line > 0 ? { line } : {}),
    ...(column !== undefined && column > 0 ? { column } : {}),
  };
}

export function formatFilePathPosition(position: FilePathPosition): string {
  if (!position.line) return position.path;
  return `${position.path}:${position.line}${position.column ? `:${position.column}` : ""}`;
}

export function isRelativeFilePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") && !isWindowsAbsolutePath(path))
  );
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return EXTENSIONLESS_FILE_NAMES.has(basename) || FILE_EXTENSION_PATTERN.test(basename);
}

/**
 * Decides whether a decoded link destination is a file path rather than a route
 * or prose. Only a `:line` suffix the author wrote counts as evidence; a `#L`
 * anchor never turns `/chat/settings` into a file.
 */
function looksLikeFilePath(path: string, authoredPath: string): boolean {
  if (isWindowsAbsolutePath(path) || RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(authoredPath);
  if (EXTENSIONLESS_FILE_NAMES.has(path)) return true;
  return RELATIVE_FILE_PATH_PATTERN.test(authoredPath) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function hasExternalScheme(path: string): boolean {
  if (isWindowsAbsolutePath(path)) return false;
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function parseMarkdownFileLink(href: string): FilePathPosition | null {
  const normalized = normalizeMarkdownLinkDestination(href);
  if (normalized.length === 0 || normalized.startsWith("#") || normalized.startsWith("//")) {
    return null;
  }

  const source =
    (normalized.toLowerCase().startsWith("file:") ? parseFileUrlHref(normalized) : null) ??
    splitMarkdownLinkSearchAndHash(normalized);
  // A percent-encoded drive colon (`/c%3A/`) only becomes strippable once decoded.
  const path = stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(source.path.trim()));
  const hash = safeDecodeURIComponent(source.hash.trim());
  if (path.length === 0 || hasExternalScheme(path)) return null;

  const position = splitFilePathPosition(path, hash);
  return looksLikeFilePath(position.path, path) ? position : null;
}

export function fileBasename(path: string): string {
  // A trailing separator is a valid way to write a directory. Trim it before
  // taking the final segment so the label is never empty.
  const trimmed = path.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) return path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

export function workspaceRelativeFilePath(
  path: string,
  workspaceRoot: string | null | undefined,
): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = stripSlashPrefixedWindowsDrive(path.replaceAll("\\", "/"));
  const normalizedRoot = stripSlashPrefixedWindowsDrive(
    workspaceRoot.replaceAll("\\", "/"),
  ).replace(/\/+$/, "");
  const caseInsensitive = isWindowsAbsolutePath(stripSlashPrefixedWindowsDrive(workspaceRoot));
  const pathForCompare = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

interface CodeSpan {
  readonly start: number;
  readonly end: number;
}

function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end += 1;
  return end;
}

/** Index of the run that closes a code span: one of exactly its own length. */
function closingBacktickRun(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const end = backtickRunEnd(text, index);
    if (end - index === length) return index;
    index = end;
  }
  return -1;
}

/**
 * The code spans in one block of Markdown. Scanned over the whole block and
 * not a line, because a span opened on one line closes on another; an opener
 * that never closes is a literal backtick, so it covers nothing.
 */
function inlineCodeSpans(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    const runEnd = backtickRunEnd(text, index);
    const length = runEnd - index;
    const close = closingBacktickRun(text, runEnd, length);
    if (close < 0) {
      index = runEnd;
      continue;
    }
    spans.push({ start: index, end: close + length });
    index = close + length;
  }
  return spans;
}

/** Whether an odd run of backslashes escapes the character at `index`. */
function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let scan = index - 1; scan >= 0 && text[scan] === "\\"; scan -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Index of the `)` closing a link destination, or -1. An escaped character is
 * stepped over, so a parenthesis escaped inside a path belongs to the path,
 * and a line ending ends the search: a destination never spans lines.
 */
function linkDestinationEnd(text: string, openParenIndex: number): number {
  let depth = 1;
  for (let index = openParenIndex + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "\n") return -1;
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function isRepairableImageDestination(destination: string): boolean {
  // Only a whitespace-bearing path shape is repaired; a destination that
  // already parses, quotes a title, or reads as prose is left as written
  // rather than guessed at.
  if (!/\s/.test(destination)) return false;
  if (destination.includes('"') || destination.includes("'")) return false;
  if (destination.includes("<") || destination.includes(">")) return false;
  return destination.includes("/") || destination.includes("\\");
}

/**
 * A literal path written as a destination a parser reads back unchanged.
 * Angle brackets are what holds a space; doubling the backslashes is what
 * keeps `\.claude` and `\_next` whole, since a backslash before punctuation
 * is an escape inside a destination too — `<C:\shots\.cache\a b.png>` parses
 * as `C:\shots.cache\a b.png` and resolves to nothing.
 */
export function markdownImageDestination(destination: string): string {
  if (!/\s/.test(destination)) return destination;
  const escaped = destination
    .replaceAll("\\", "\\\\")
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>");
  return `<${escaped}>`;
}

function repairImageDestinationsInBlock(text: string): string {
  const codeSpans = inlineCodeSpans(text);
  let output = "";
  let copiedFrom = 0;
  let repaired = false;
  IMAGE_OPEN_PATTERN.lastIndex = 0;
  let match = IMAGE_OPEN_PATTERN.exec(text);
  while (match !== null) {
    const matchIndex = match.index;
    const openParenIndex = matchIndex + match[0].length - 1;
    const closeParenIndex = linkDestinationEnd(text, openParenIndex);
    const inCode = codeSpans.some((span) => matchIndex >= span.start && matchIndex < span.end);
    if (closeParenIndex >= 0 && !inCode && !isEscapedAt(text, matchIndex)) {
      const destination = text.slice(openParenIndex + 1, closeParenIndex);
      if (isRepairableImageDestination(destination)) {
        const opening = text.slice(copiedFrom, openParenIndex + 1);
        output += `${opening}${markdownImageDestination(destination)}`;
        copiedFrom = closeParenIndex;
        repaired = true;
        IMAGE_OPEN_PATTERN.lastIndex = closeParenIndex + 1;
      }
    }
    match = IMAGE_OPEN_PATTERN.exec(text);
  }
  return repaired ? output + text.slice(copiedFrom) : text;
}

interface OpenFence {
  readonly character: string;
  readonly length: number;
}

/**
 * The fence a line opens, or null when it only looks like one: a backtick
 * fence's info string may not itself contain a backtick, so a line of three
 * backticks followed by one opens nothing and the Markdown under it is
 * ordinary text.
 */
function fenceOpener(line: string): OpenFence | null {
  const match = FENCE_LINE_PATTERN.exec(line);
  const marker = match?.[1];
  const character = marker?.[0];
  if (marker === undefined || character === undefined) return null;
  if (character === "`" && (match?.[2] ?? "").includes("`")) return null;
  return { character, length: marker.length };
}

function closesFence(line: string, fence: OpenFence): boolean {
  const marker = FENCE_CLOSE_PATTERN.exec(line)?.[1];
  if (marker === undefined) return false;
  return marker[0] === fence.character && marker.length >= fence.length;
}

type HtmlBlockEnd = RegExp | "blank";

/**
 * The condition that ends the raw HTML block this line opens, or null. All
 * seven CommonMark forms: Markdown inside any of them is shown as written, so
 * repairing there would rewrite what the reader is meant to see.
 */
function htmlBlockEnd(line: string, insideParagraph: boolean): HtmlBlockEnd | null {
  for (const block of HTML_BLOCKS) {
    if (block.start.test(line)) return block.end;
  }
  if (!insideParagraph && HTML_BLOCK_STANDALONE_TAG_PATTERN.test(line)) return "blank";
  return null;
}

/**
 * Angle-quotes image destinations a parser would reject. CommonMark ends an
 * unquoted destination at the first space, so an agent writing
 * `![shot](C:\dir with spaces\a.png)` delivers the whole line as literal
 * text — the renderer never sees an image, and every workspace-path relay
 * and preview this app already builds for that destination goes unused. An
 * angle-quoted destination is the CommonMark form that holds spaces, and
 * both clients already unwrap `<...>` when classifying, so the rewrite is
 * invisible downstream. Everywhere Markdown is shown literally — fenced and
 * indented code, code spans, raw HTML blocks, an escaped `\!` — is left
 * exactly as written, as are destinations that parse on their own; link
 * syntax is left for a separate pass.
 */
export function repairMarkdownImageDestinations(markdown: string): string {
  if (!markdown.includes("![") || !/\s/.test(markdown)) return markdown;

  const lines = markdown.split("\n");
  const repairedLines = [...lines];
  let blockLines: number[] = [];
  let fence: OpenFence | null = null;
  let htmlEnd: HtmlBlockEnd | null = null;
  let inIndentedCode = false;
  let repaired = false;

  // A code span may cross lines but never a blank one, so each run of text
  // lines is repaired as one block.
  const flushBlock = (): void => {
    if (blockLines.length === 0) return;
    const text = blockLines.map((index) => lines[index] ?? "").join("\n");
    const next = repairImageDestinationsInBlock(text);
    if (next !== text) {
      const nextLines = next.split("\n");
      blockLines.forEach((lineIndex, offset) => {
        repairedLines[lineIndex] = nextLines[offset] ?? lines[lineIndex] ?? "";
      });
      repaired = true;
    }
    blockLines = [];
  };

  for (const [index, rawLine] of lines.entries()) {
    // A CRLF document keeps its `\r`; the line patterns must not see it, and
    // the line itself keeps it so the text is rewritten and not reformatted.
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (fence !== null) {
      if (closesFence(line, fence)) fence = null;
      continue;
    }
    if (htmlEnd !== null) {
      if (htmlEnd === "blank" ? line.trim() === "" : htmlEnd.test(line)) htmlEnd = null;
      continue;
    }
    if (line.trim() === "") {
      flushBlock();
      inIndentedCode = false;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener !== null) {
      flushBlock();
      fence = opener;
      inIndentedCode = false;
      continue;
    }
    const html = htmlBlockEnd(line, blockLines.length > 0);
    if (html !== null) {
      flushBlock();
      htmlEnd = html !== "blank" && html.test(line) ? null : html;
      inIndentedCode = false;
      continue;
    }
    // Four spaces are code only where a block can start; the same indent
    // under a paragraph is a continuation line, and that is ordinary text.
    // An unindented line ends the code block it was carrying.
    if (!INDENTED_CODE_PATTERN.test(line)) inIndentedCode = false;
    if (inIndentedCode || (blockLines.length === 0 && INDENTED_CODE_PATTERN.test(line))) {
      inIndentedCode = true;
      continue;
    }
    blockLines.push(index);
    // A heading can hold an image, so it is repaired — but nothing after it is
    // a continuation of it, and the next line may open a block of its own.
    if (PARAGRAPH_ENDING_LINE_PATTERN.test(line)) flushBlock();
  }
  flushBlock();

  return repaired ? repairedLines.join("\n") : markdown;
}
