import type { mediaKindFromPath } from "./mediaPreview.ts";
import {
  isNetworkPath,
  isWindowsAbsolutePath,
  stripSlashPrefixedWindowsDrive,
  workspaceRelativeFilePath,
} from "./path.ts";
import {
  type FilePathPosition,
  formatFilePathPosition,
  parseFileUrlHref,
  resolvePathLinkTarget,
  splitFilePathPosition,
} from "./fileLinks.ts";

const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;

// Names may use any script (`線性代數/考試.pdf`) and routing punctuation (`posts.$id.tsx`,
// `(group)/[id]/+page.svelte`, `@scope/pkg`). The final segment is optional so an explicit
// folder link may end in `/` (`patches/`, `docs/My Folder/`). A bare name with no slash still fails.
const RELATIVE_FILE_PATH_PATTERN =
  /^(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*\/)+(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+@()[\]-]+)*(?::\d+(?::\d+|-\d+)?)?)?$/u;

// No `@` here: `me@example.com` is an address, not a file.
const RELATIVE_FILE_NAME_PATTERN =
  /^[\p{L}\p{M}\p{N}._$+()[\]-]+(?: +[\p{L}\p{M}\p{N}._$+()[\]-]+)*\.[\p{L}\p{M}\p{N}_-]+(?::\d+(?::\d+|-\d+)?)?$/u;

const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;

const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+|-\d+)?$/;

const POSITION_ONLY_PATTERN = /^\d+(?::\d+|-\d+)?$/;

const INLINE_CODE_WHITESPACE_PATTERN = /\s/;

// Inline code with spaces is a file only when it is absolute and every word is a plain name:
// `/Users/me/Mobile Documents/a - b.md` is, `/usr/bin/python3 -m venv .venv` (a flag) is not.
// A space only in the last segment reads as a command (`/usr/local/bin/node server.js`), so it
// must sit under a user root, and nothing after a bin folder counts.
const SPACED_ABSOLUTE_PATH_ROOT_PATTERN = /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)/;
const SPACED_PATH_BODY_PATTERN =
  /^(?:[\p{L}\p{M}\p{N}._$+@()[\]-]+(?: (?!-+\p{L})[\p{L}\p{M}\p{N}._$+@()[\]-]+)*(?:[\\/]|$))+$/u;

function isSpacedAbsoluteFilePath(text: string): boolean {
  const root = SPACED_ABSOLUTE_PATH_ROOT_PATTERN.exec(text)?.[0];
  if (root === undefined) return false;
  const body = text.slice(root.length).replace(POSITION_SUFFIX_PATTERN, "");
  if (!SPACED_PATH_BODY_PATTERN.test(body)) return false;
  const firstSpace = body.indexOf(" ");
  const foldersBeforeSpace = body.slice(0, firstSpace).split(PATH_SEPARATOR_PATTERN).slice(0, -1);
  if (foldersBeforeSpace.some((folder) => folder === "bin" || folder === "sbin")) return false;
  const spaceInFolder = PATH_SEPARATOR_PATTERN.test(body.slice(firstSpace));
  if (root === "\\\\" && foldersBeforeSpace.length < (spaceInFolder ? 1 : 2)) return false;
  if (!spaceInFolder && root === "/" && !/^(?:Users|home)[\\/]/.test(body)) return false;
  if (PATH_SEPARATOR_PATTERN.test(body.at(-1) ?? "")) return true;
  const basename = body.split(PATH_SEPARATOR_PATTERN).at(-1) ?? "";
  return FILE_EXTENSION_PATTERN.test(basename) || EXTENSIONLESS_FILE_NAMES.has(basename);
}

const PATH_SEPARATOR_PATTERN = /[\\/]/;
// Agents shorten long paths with a `...` or `…` segment, which no file chip can open.
const ELIDED_PATH_SEGMENT_PATTERN = /(?:^|[\\/])(?:\.{3,}|…)(?:[\\/]|$)/;

const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const ANY_FILE_EXTENSION_PATTERN = /\.[^./\\]+$/;
const VERSION_SUFFIX_PATTERN = /\d\.\d[^.]*$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;

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

export const EXTENSIONLESS_FILE_NAMES: ReadonlySet<string> = new Set([
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
  "gg",
  "chat",
  "cloud",
  "site",
  "online",
  "tech",
  "store",
  "link",
]);

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
  // C++ sources end in `.cc`, so `allocator.cc:217` names a file, not a host and port.
  "cc",
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

export function inlineCodeFilePathCandidate(codeText: string): string | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || trimmed.includes("`") || /[<>]/.test(trimmed)) return null;
  if (INLINE_CODE_WHITESPACE_PATTERN.test(trimmed) && !isSpacedAbsoluteFilePath(trimmed)) {
    return null;
  }

  const candidate = isWindowsAbsolutePath(trimmed) ? trimmed : trimmed.replaceAll("\\", "/");
  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;
  if (ELIDED_PATH_SEGMENT_PATTERN.test(candidate.replace(POSITION_SUFFIX_PATTERN, ""))) return null;

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith("/") ||
    isWindowsAbsolutePath(candidate);
  if (!hasExplicitPathShape) {
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
    // Markdown destinations accept `patches/`. Inline code still needs a
    // file-shaped final segment, so a trailing slash stays plain code.
    if (withoutPosition.endsWith("/")) return null;
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    const basename =
      withoutPosition
        .replace(/[/\\]+$/, "")
        .split(/[\\/]/)
        .at(-1) ?? "";
    if (VERSION_SUFFIX_PATTERN.test(basename)) return null;
    if (!FILE_EXTENSION_PATTERN.test(basename)) {
      if (!hasPosition) return EXTENSIONLESS_FILE_NAMES.has(basename) ? candidate : null;
      // A `:line` suffix alone does not make `I/W217:220` a file reference.
      if (
        withoutPosition.includes("/") &&
        !ANY_FILE_EXTENSION_PATTERN.test(basename) &&
        !EXTENSIONLESS_FILE_NAMES.has(basename)
      ) {
        return null;
      }
    }
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
 * The decoded path a markdown destination names on the host, before any workspace resolution, or
 * null for a `file:` URL that does not parse. Clients and the guest media route both read it here.
 */
export function markdownDestinationHostPath(source: string): string | null {
  if (/^file:/i.test(source)) {
    const target = parseFileUrlHref(source);
    return target === null
      ? null
      : stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(target.path));
  }
  return stripSlashPrefixedWindowsDrive(
    safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(source).path),
  );
}

const DIRECT_IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export type MarkdownImageSource =
  | { readonly _tag: "Direct"; readonly uri: string }
  | { readonly _tag: "WorkspaceFile"; readonly path: string; readonly relative?: true }
  | { readonly _tag: "Blocked" };

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(workspaceRoot) ? "\\" : "/";
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const path = relativePath.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "");
  return `${root}${separator}${path}`;
}

/** Rendering is not a click, so a network path loads only from the project's own share. */
function hostFileSource(
  path: string,
  workspaceRoot: string | null | undefined,
): MarkdownImageSource {
  return isNetworkPath(path) && workspaceRelativeFilePath(path, workspaceRoot) === null
    ? { _tag: "Blocked" }
    : { _tag: "WorkspaceFile", path };
}

/**
 * Filesystem paths belong to the environment host and must never reach a
 * browser or native image component without first becoming a signed asset URL.
 */
export function classifyMarkdownImageSource(
  value: string | null | undefined,
  workspaceRoot?: string | null,
): MarkdownImageSource {
  if (value === null || value === undefined) return { _tag: "Blocked" };

  const source = normalizeMarkdownLinkDestination(value);
  if (source.length === 0 || source.startsWith("#") || source.startsWith("?")) {
    return { _tag: "Blocked" };
  }
  if (DIRECT_IMAGE_SOURCE_PATTERN.test(source)) {
    return { _tag: "Direct", uri: source };
  }

  const path = markdownDestinationHostPath(source);
  if (path === null) return { _tag: "Blocked" };
  if (/^file:/i.test(source)) return hostFileSource(path, workspaceRoot);
  if (path.length === 0) return { _tag: "Blocked" };
  if (path.startsWith("/") || isWindowsAbsolutePath(path)) {
    return hostFileSource(path, workspaceRoot);
  }
  if (URI_SCHEME_PATTERN.test(path) || path.startsWith("~/") || path.startsWith("~\\")) {
    return { _tag: "Blocked" };
  }
  if (!workspaceRoot) return { _tag: "Blocked" };

  return { _tag: "WorkspaceFile", path: joinWorkspacePath(workspaceRoot, path), relative: true };
}

export function shouldRenderMarkdownImageAsFileLink(
  source: MarkdownImageSource,
  mediaKind: ReturnType<typeof mediaKindFromPath>,
): boolean {
  return source._tag === "WorkspaceFile" && mediaKind === null;
}

export function isMarkdownFileLinkLabel(label: string, href: string): boolean {
  const destination = parseMarkdownFileLink(href);
  if (!destination) return false;
  const normalize = (path: string) =>
    path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const trimmed = label.trim();
  const isWindowsDestination = isWindowsAbsolutePath(destination.path);
  const destinationPath = isWindowsDestination
    ? normalize(destination.path).toLowerCase()
    : normalize(destination.path);
  const matchesLabelPosition = (labelPosition: FilePathPosition): boolean => {
    if (
      (labelPosition.line !== undefined && labelPosition.line !== destination.line) ||
      (labelPosition.column !== undefined && labelPosition.column !== destination.column) ||
      (labelPosition.endLine !== undefined && labelPosition.endLine !== destination.endLine)
    ) {
      return false;
    }
    let labelPath = normalize(labelPosition.path);
    if (labelPath.length === 0) return true;
    if (isWindowsDestination) {
      labelPath = labelPath.toLowerCase();
    }
    return destinationPath === labelPath || destinationPath.endsWith(`/${labelPath}`);
  };
  const hashIndex = trimmed.lastIndexOf("#");
  if (hashIndex >= 0) {
    const path = trimmed.slice(0, hashIndex);
    const anchored = splitFilePathPosition(path, trimmed.slice(hashIndex));
    // A `:line` suffix before the hash wins in splitFilePathPosition; only a position from the anchor counts here.
    if (anchored.line !== undefined && anchored.path === path && matchesLabelPosition(anchored)) {
      return true;
    }
  }
  return (
    matchesLabelPosition(splitFilePathPosition(trimmed)) ||
    (trimmed.length > 0 && matchesLabelPosition(splitFilePathPosition(label)))
  );
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
  return EXTENSIONLESS_FILE_NAMES.has(basename) || FILE_EXTENSION_PATTERN.test(basename.trimEnd());
}

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

export function parseMarkdownSandboxFileLink(href: string): FilePathPosition | null {
  const prefix = /^sandbox:(?=\/)/i.exec(href);
  if (!prefix) return null;

  const source = splitMarkdownLinkSearchAndHash(href.slice(prefix[0].length));
  const path = safeDecodeURIComponent(source.path);
  // A sandbox URI names a local file on the thread host, never a network share.
  if (path.length < 2 || isNetworkPath(path) || path.includes("\0") || /[\t\r\n]/.test(path)) {
    return null;
  }
  const position = splitFilePathPosition(
    stripSlashPrefixedWindowsDrive(path),
    safeDecodeURIComponent(source.hash),
  );
  return ELIDED_PATH_SEGMENT_PATTERN.test(position.path) ? null : position;
}

export function parseMarkdownFileLink(href: string): FilePathPosition | null {
  const normalized = normalizeMarkdownLinkDestination(href);
  if (normalized.length === 0 || normalized.startsWith("#") || normalized.startsWith("//")) {
    return null;
  }

  const sandboxFile = parseMarkdownSandboxFileLink(normalized);
  if (sandboxFile) return sandboxFile;

  const source =
    (normalized.toLowerCase().startsWith("file:") ? parseFileUrlHref(normalized) : null) ??
    splitMarkdownLinkSearchAndHash(normalized);
  const path = stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(source.path.trim()));
  const hash = safeDecodeURIComponent(source.hash.trim());
  if (path.length === 0 || hasExternalScheme(path)) return null;

  const position = parseFilePathLink(path, hash);
  // `src\a.ts` is Windows-relative. A link that already parses keeps its spelling, since POSIX
  // names may contain `\`; a rooted `\\host` or `\foo` would change root if rewritten.
  if (position || /^[\\/]/.test(path) || isWindowsAbsolutePath(path)) return position;
  return path.includes("\\") ? parseFilePathLink(path.replaceAll("\\", "/"), hash) : null;
}

function parseFilePathLink(path: string, hash: string): FilePathPosition | null {
  const position = splitFilePathPosition(path, hash);
  return !ELIDED_PATH_SEGMENT_PATTERN.test(position.path) && looksLikeFilePath(position.path, path)
    ? position
    : null;
}

const BACKTICK_RUN_PATTERN = /`+/g;

function collectLineCodeSpans(line: string, spans: string[]) {
  const runs = line.includes("`") ? [...line.matchAll(BACKTICK_RUN_PATTERN)] : [];
  if (runs.length < 2) return;
  const runsByLength = new Map<number, number[]>();
  for (const [i, run] of runs.entries()) {
    const indexes = runsByLength.get(run[0].length);
    if (indexes) indexes.push(i);
    else runsByLength.set(run[0].length, [i]);
  }
  const cursorByLength = new Map<number, number>();
  let textStart = 0;
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!;
    let backslashes = 0;
    while (run.index - backslashes > textStart && line[run.index - backslashes - 1] === "\\") {
      backslashes += 1;
    }
    // An escaped backtick is literal outside code spans; only closers keep backslashes literal.
    const length = run[0].length - (backslashes % 2);
    const candidates = runsByLength.get(length) ?? [];
    let cursor = cursorByLength.get(length) ?? 0;
    while (cursor < candidates.length && candidates[cursor]! <= i) cursor += 1;
    cursorByLength.set(length, cursor);
    const close = candidates[cursor];
    if (length === 0 || close === undefined) continue;
    const span = line.slice(run.index + run[0].length, runs[close]!.index).trim();
    if (span) spans.push(span);
    i = close;
    textStart = runs[close]!.index + runs[close]![0].length;
  }
}

// A backtick fence's info string cannot contain a backtick: "```a```" is a code span.
const FENCE_OPENER_PATTERN = /^(`{3,}(?![^`]*`)|~{3,})/;
const FENCE_CLOSER_PATTERN = /^(`{3,}|~{3,}) *$/;
const LIST_MARKER_PATTERN = /^(?:[-+*]|(\d{1,9})[.)])( +|$)/;
const THEMATIC_BREAK_PATTERN = /^([-*_]) *(?:\1 *){2,}$/;
const ATX_HEADING_PATTERN = /^#{1,6}(?: |$)/;
const SETEXT_UNDERLINE_PATTERN = /^(?:=+|-+) *$/;
// What ends a paragraph, so a line starting with one is never its lazy continuation.
const PARAGRAPH_INTERRUPTION_PATTERN =
  /^(?:>|`{3,}(?![^`]*`)|~{3,}|(?:[-+*]|\d{1,9}[.)])(?: |$)|#{1,6}(?: |$)|([-*_]) *(?:\1 *){2,}$)/;

const FOOTNOTE_DEFINITION_PATTERN = /^\[\^(?:\\[\\[\]]|\\(?![\\[\]])|[^\s\\[\]]){1,999}\]: */;
const TABLE_DELIMITER_PATTERN = /^\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

const BLOCKQUOTE = 0;
// A recovered list block continues within the original code block's four-column prefix.
const RECOVERED_LIST_CODE = -4;

function tableColumnCount(row: string): number {
  const trimmed = row.trimEnd();
  let columns = 1;
  for (const match of trimmed.matchAll(/\\[\\|]|\|/g)) {
    if (match[0] === "|" && match.index > 0 && match.index < trimmed.length - 1) columns += 1;
  }
  return columns;
}

// Normalize lone CR without changing offsets or splitting CRLF into two line endings.
function normalizeLoneCarriageReturns(text: string): string {
  return text.replace(/\r(?!\n)/g, "\n");
}

export function extractInlineCodeSpans(text: string): string[] {
  if (!text.includes("`")) return [];
  const spans: string[] = [];
  visitMarkdownLines(normalizeLoneCarriageReturns(text), (line, _start, code) => {
    if (!code) collectLineCodeSpans(line, spans);
  });
  return spans;
}

/**
 * Visits text and code lines. Blockquotes and list items are tracked line by line as
 * CommonMark nests them, because a fence closes only at its own container's indentation and ends
 * with that container. A full parse would be exact but costs about 100x this scan, which runs on
 * every streamed chunk.
 */
function visitMarkdownLines(
  text: string,
  visit: (line: string, start: number, code: boolean) => void,
) {
  // Open containers, outermost first: blockquotes, indented content, and recovered list code.
  const containers: number[] = [];
  let fence: { marker: string; indented: boolean } | null = null;
  // Whether the previous line left a paragraph open, and whether indented code is still open:
  // micromark lets neither be interrupted by an empty list item or one not numbered 1.
  let paragraph = false;
  let indentedCode = false;
  // A table has a header candidate until its delimiter row opens the body.
  let table: { depth: number; header?: string } | undefined;
  // Depth of an item that has only its marker so far; a blank line next ends it.
  let emptyItemDepth = 0;
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const previousTable = table;
    table = undefined;
    const start = lineStart;
    lineStart += line.length + 1;
    let source = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (source.includes("\t")) {
      let column = 0;
      source = source.replace(/\t|[^\t]+/g, (part) => {
        const expanded = part === "\t" ? " ".repeat(4 - (column % 4)) : part;
        column += expanded.length;
        return expanded;
      });
    }
    let position = 0;
    let indent = 0;
    let content = "";
    const readIndent = () => {
      indent = 0;
      while (source[position + indent] === " ") indent += 1;
      content = source.slice(position + indent);
    };
    const enterBlockquote = () => {
      position += indent + 1;
      if (source[position] === " ") position += 1;
    };

    const blankEndsItemAt = emptyItemDepth - 1;
    emptyItemDepth = 0;
    const containerCount = containers.length;
    let matched = 0;
    for (; matched < containers.length; matched += 1) {
      const container = containers[matched]!;
      readIndent();
      if (container === BLOCKQUOTE) {
        if (indent > 3 || content[0] !== ">") break;
        enterBlockquote();
      } else if (content === "") {
        if (matched === blankEndsItemAt) break;
      } else if (indent >= Math.abs(container)) {
        position += Math.abs(container);
      } else {
        break;
      }
    }
    readIndent();

    if (fence) {
      if (matched === containers.length) {
        if (content === "") continue;
        // A fence written inside indented code ends with that code.
        if (!fence.indented || indent >= 4) {
          visit(line, start, true);
          const closer = FENCE_CLOSER_PATTERN.exec(content)?.[1];
          if (
            closer?.startsWith(fence.marker[0]!) &&
            closer.length >= fence.marker.length &&
            (fence.indented || indent <= 3)
          ) {
            fence = null;
            paragraph = false;
          }
          continue;
        }
      }
      fence = null;
      paragraph = false;
    }

    if (matched < containers.length) {
      if (
        paragraph &&
        content !== "" &&
        containers.lastIndexOf(RECOVERED_LIST_CODE) < matched &&
        (indent >= 4 ||
          (!PARAGRAPH_INTERRUPTION_PATTERN.test(content) &&
            !FOOTNOTE_DEFINITION_PATTERN.test(content)))
      ) {
        visit(line, start, false);
        continue;
      }
      containers.length = matched;
      paragraph = false;
      indentedCode = false;
    }
    // micromark decides this once per line, and not at all on a line that closed a container.
    const interrupts = paragraph || indentedCode;
    const closedContainer = matched < containerCount;

    for (;;) {
      if (content === "") {
        paragraph = false;
        break;
      }
      const opener = FENCE_OPENER_PATTERN.exec(content)?.[1];
      if (indent >= 4) {
        if (!paragraph && !closedContainer) indentedCode = true;
        // Inside a paragraph an indented line is text, where only a backtick run opens code (a span).
        if (opener && (!paragraph || opener[0] === "`")) {
          fence = { marker: opener, indented: true };
          visit(line, start, true);
        } else {
          visit(line, start, !paragraph);
        }
        break;
      }
      indentedCode = false;
      if (opener) {
        fence = { marker: opener, indented: false };
        visit(line, start, true);
        break;
      }
      if (content[0] === ">") {
        containers.push(BLOCKQUOTE);
        enterBlockquote();
        paragraph = false;
        readIndent();
        continue;
      }
      if (THEMATIC_BREAK_PATTERN.test(content)) {
        paragraph = false;
        break;
      }
      const footnote = FOOTNOTE_DEFINITION_PATTERN.exec(content);
      if (footnote) {
        containers.push(4);
        position += indent + footnote[0].length;
        paragraph = false;
        readIndent();
        continue;
      }
      const item = LIST_MARKER_PATTERN.exec(content);
      const emptyItem = item?.[0].length === content.length;
      // Only a non-empty item, numbered 1 if ordered, starts a list in the middle of a block.
      if (
        item &&
        !(interrupts && (emptyItem || (item[1] !== undefined && Number(item[1]) !== 1)))
      ) {
        const padding = item[2]!.length;
        const width = item[0].length - padding + (emptyItem || padding > 4 ? 1 : padding);
        containers.push(indent + width);
        if (emptyItem) emptyItemDepth = containers.length;
        position += indent + width;
        paragraph = false;
        readIndent();
        // The renderer recovers same-line indented list code with whitespace left in its value.
        if (!emptyItem && padding > 5) {
          containers.push(RECOVERED_LIST_CODE);
          visit(line, start, false);
          paragraph = true;
          break;
        }
        continue;
      }
      visit(line, start, false);
      if (
        ATX_HEADING_PATTERN.test(content) ||
        (paragraph && SETEXT_UNDERLINE_PATTERN.test(content))
      ) {
        paragraph = false;
      } else if (
        previousTable?.depth === containers.length &&
        !closedContainer &&
        (previousTable.header === undefined ||
          (previousTable.header.trimEnd() !== "|" &&
            /[|:]/.test(content) &&
            TABLE_DELIMITER_PATTERN.test(content) &&
            tableColumnCount(content) === tableColumnCount(previousTable.header)))
      ) {
        table = { depth: containers.length };
        paragraph = false;
      } else {
        table = { depth: containers.length, header: content };
        paragraph = true;
      }
      break;
    }
  }
}

function markdownRunEndFinder(markdown: string, delimiter: RegExp) {
  let runStart = -1;
  let runEnd = -1;
  return (start: number) => {
    if (start >= runStart && start <= runEnd) return runEnd;
    delimiter.lastIndex = start;
    runStart = start;
    let match = delimiter.exec(markdown);
    while (match?.[0].length === 2 && match[0][0] === "\\") match = delimiter.exec(markdown);
    runEnd = match?.index ?? markdown.length;
    return runEnd;
  };
}

function markdownLinkTailScanner(markdown: string) {
  // A blank line ends the paragraph, so no part of a link's tail runs past one.
  const whitespaceEnd = markdownRunEndFinder(markdown, /\S|\n[ \t\r]*\n/g);
  // Escape pairs (`\"`, `\\`) match so the finder can skip them.
  const doubleQuoteEnd = markdownRunEndFinder(markdown, /\\[\\"]|"|\n[ \t\r]*\n/g);
  const singleQuoteEnd = markdownRunEndFinder(markdown, /\\[\\']|'|\n[ \t\r]*\n/g);
  const parenthesisEnd = markdownRunEndFinder(markdown, /\\[\\()]|[()]|\n[ \t\r]*\n/g);
  const titleWhitespaceEnd = markdownRunEndFinder(markdown, /\S|\n[ \t\r]*\n/g);
  return (start: number) => {
    const end = whitespaceEnd(start);
    const quote = markdown[end];
    if (quote === ")") return end + 1;
    if (end === start || (quote !== '"' && quote !== "'" && quote !== "(")) return null;
    const titleEnd =
      quote === '"' ? doubleQuoteEnd : quote === "'" ? singleQuoteEnd : parenthesisEnd;
    const quoteEnd = titleEnd(end + 1);
    if (markdown[quoteEnd] !== (quote === "(" ? ")" : quote)) return null;
    const close = titleWhitespaceEnd(quoteEnd + 1);
    return markdown[close] === ")" ? close + 1 : null;
  };
}

// micromark's own nesting limit. It also keeps link scanning linear: a scan only runs past another
// link's opening parenthesis while that parenthesis counts toward this depth.
const MAX_BARE_DESTINATION_PAREN_DEPTH = 32;

function bareMarkdownLinkDestinationEnd(markdown: string, start: number): number | null {
  const delimiter = /[\s()\\]/g;
  delimiter.lastIndex = start;
  let depth = 0;
  while (true) {
    const index = delimiter.exec(markdown)?.index ?? markdown.length;
    const char = markdown[index];
    if (char === "\\") {
      if (/[()\\]/.test(markdown[index + 1] ?? "")) delimiter.lastIndex = index + 2;
    } else if (char === "(") {
      if (depth === MAX_BARE_DESTINATION_PAREN_DEPTH) return null;
      depth += 1;
    } else if (char === ")" && depth > 0) {
      depth -= 1;
    } else {
      return depth === 0 ? index : null;
    }
  }
}

export function markdownLinkDestinationScanner(markdown: string) {
  const whitespaceEnd = markdownRunEndFinder(markdown, /\S/g);
  const angleEnd = markdownRunEndFinder(markdown, /\\[\\<>]|[<>\r\n]/g);
  // Separate caches keep scans moving forward when angle destinations fall back to bare ones.
  const angleTail = markdownLinkTailScanner(markdown);
  const bareTail = markdownLinkTailScanner(markdown);
  return (start: number) => {
    if (markdown[start] !== "(") return null;
    const hrefStart = whitespaceEnd(start + 1);
    if (markdown[hrefStart] === "<") {
      const hrefEnd = angleEnd(hrefStart + 1);
      if (hrefEnd > hrefStart + 1 && markdown[hrefEnd] === ">") {
        const end = angleTail(hrefEnd + 1);
        if (end !== null) return { hrefStart: hrefStart + 1, hrefEnd, end };
      }
    }
    const hrefEnd = bareMarkdownLinkDestinationEnd(markdown, hrefStart);
    if (hrefEnd === null) return null;
    const end = bareTail(hrefEnd);
    return end === null ? null : { hrefStart, hrefEnd, end };
  };
}

// Code block lines become spaces, keeping every offset.
function blankCodeBlocks(text: string): string {
  if (!/ {4}|\t|```|~~~/.test(text)) return text;
  let blanked = "";
  let copied = 0;
  visitMarkdownLines(text, (line, start, code) => {
    if (!code) return;
    blanked += text.slice(copied, start) + line.replace(/[^\r]/g, " ");
    copied = start + line.length;
  });
  return blanked + text.slice(copied);
}

// Labels may nest balanced brackets (`[the [docs] guide](...)`), and the composer escapes them
// (`[\[id\].tsx](...)`), so `\[` and `\]` never count. A blank line ends the paragraph and its labels.
export function extractMarkdownLinkHrefs(text: string): string[] {
  const markdown = blankCodeBlocks(normalizeLoneCarriageReturns(text));
  const hrefs: string[] = [];
  const scanDestination = markdownLinkDestinationScanner(markdown);
  const paragraphEnd = markdownRunEndFinder(markdown, /\n[ \t\r]*\n/g);
  // A code span closes at the next run of as many backticks in its paragraph.
  const closersByLength = new Map<number, { ends: number[]; next: number }>();
  for (const run of markdown.matchAll(/`+/g)) {
    const closers = closersByLength.get(run[0].length) ?? { ends: [], next: 0 };
    closers.ends.push(run.index + run[0].length);
    closersByLength.set(run[0].length, closers);
  }
  const bracket = /!\[|[[\]\\]|`+|\n[ \t\r]*\n/g;
  const openers: boolean[] = [];
  for (let match = bracket.exec(markdown); match; match = bracket.exec(markdown)) {
    if (match[0] === "\\") {
      bracket.lastIndex = match.index + 2;
    } else if (match[0].startsWith("`")) {
      const length = match[0].length;
      const closers = closersByLength.get(length) ?? { ends: [], next: 0 };
      while ((closers.ends[closers.next] ?? Infinity) - length < bracket.lastIndex) closers.next++;
      const end = closers.ends[closers.next];
      if (end !== undefined && end - length <= paragraphEnd(bracket.lastIndex)) {
        bracket.lastIndex = end;
      }
    } else if (match[0].startsWith("\n")) {
      openers.length = 0;
    } else if (match[0].endsWith("[")) {
      openers.push(match[0] === "![");
    } else if (openers.length > 0) {
      const image = openers.pop();
      const destination = scanDestination(match.index + 1);
      if (!destination) continue;
      // A link cannot contain a link, but it can contain an image.
      if (!image) openers.length = 0;
      bracket.lastIndex = destination.end;
      const href = markdown.slice(destination.hrefStart, destination.hrefEnd).trim();
      if (href) hrefs.push(href);
    }
  }
  return hrefs;
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  return resolveMarkdownFileLink(href, cwd, baseDir)?.targetPath ?? null;
}

/** Resolves the displayed position and the editor target, which opens at the start line. */
export function resolveMarkdownFileLink(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): { sourcePath: string; targetPath: string; position: FilePathPosition } | null {
  const source = href ? parseMarkdownFileLink(href) : null;
  if (!source) return null;

  const targetPath = resolveParsedFileLinkTarget(source, cwd, baseDir);
  if (!targetPath) return null;
  return {
    sourcePath: source.path,
    targetPath,
    position: {
      ...splitFilePathPosition(targetPath),
      ...(source.endLine !== undefined ? { endLine: source.endLine } : {}),
    },
  };
}

function resolveParsedFileLinkTarget(
  target: FilePathPosition,
  cwd: string | undefined,
  baseDir: string | undefined,
): string | null {
  const pathWithPosition = formatFilePathPosition(target);
  if (!isRelativeFilePath(pathWithPosition)) {
    // Opening a network path makes Windows sign in to its host with the user's
    // NTLM credentials, so only the project's own share becomes a file link.
    return isNetworkPath(target.path) && workspaceRelativeFilePath(target.path, cwd) === null
      ? null
      : pathWithPosition;
  }
  if (!baseDir) return null;
  return resolvePathLinkTarget(pathWithPosition, baseDir);
}

export function isWindowsDrivePathHref(href: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(safeDecodeURIComponent(href));
}

// Punctuation and symbols from CJK Symbols and Punctuation and from Halfwidth and Fullwidth Forms,
// plus the Arabic-script comma, semicolon, question mark, and full stop.
export const SCRIPT_PUNCTUATION = /(?=[　-〿＀-￯،؛؟۔])[\p{P}\p{S}]/u;

/** Where ASCII text runs into such a mark, or -1. Unicode before it may make the mark part of the text. */
export function scriptPunctuationAfterAscii(text: string): number {
  const index = text.search(/[^!-~]/u);
  return index > 0 && SCRIPT_PUNCTUATION.test(text.charAt(index)) ? index : -1;
}

// Bare prose paths need a filesystem root or a position, so `/api/users.json` stays a route,
// and a file-shaped last segment.
export function absoluteFilePathMatches(text: string): Array<{ index: number; path: string }> {
  const paths: Array<{ index: number; path: string }> = [];
  for (const match of text.matchAll(/(^|[\s(["'])(\/[^\s<>"'`]+)/g)) {
    const cut = scriptPunctuationAfterAscii(match[2]!);
    const source = cut > 0 ? match[2]!.slice(0, cut) : match[2]!;
    let parentheses = 0;
    let brackets = 0;
    for (const character of source) {
      if (character === "(") parentheses += 1;
      if (character === ")") parentheses -= 1;
      if (character === "[") brackets += 1;
      if (character === "]") brackets -= 1;
    }
    let end = source.length;
    while (end > 0) {
      const character = source[end - 1]!;
      if (character === ")" && parentheses < 0) parentheses += 1;
      else if (character === "]" && brackets < 0) brackets += 1;
      else if (!".,;!?:".includes(character)) break;
      end -= 1;
    }
    const path = source.slice(0, end);
    // Trimming `/tmp/a/....` to `/tmp/a/` would hide its elided segment.
    if (path.endsWith("/") && source.startsWith("...", end)) continue;
    if (
      !POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
      !POSITION_SUFFIX_PATTERN.test(path)
    )
      continue;
    // Prose ends a path at whitespace, so `/Users/me/Library/Application Support/...` must not link.
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (
      !POSITION_SUFFIX_PATTERN.test(path) &&
      !FILE_EXTENSION_PATTERN.test(basename) &&
      !EXTENSIONLESS_FILE_NAMES.has(basename)
    )
      continue;
    if (!parseMarkdownFileLink(path)) continue;
    paths.push({ index: match.index + match[1]!.length, path });
  }
  return paths;
}

// A drive path that has not reached whitespace yet: `C:`, `C:\Users\me`, `C:/work`.
export const UNFINISHED_DRIVE_PATH = /(?:^|\W)[A-Za-z]:(?:[\\/]\S*)?$/;
