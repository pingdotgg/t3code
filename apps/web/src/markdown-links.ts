import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { resolvePathLinkTarget, splitPathAndPosition } from "./terminal-links";

const WINDOWS_DRIVE_PATH_PATTERN = /^[A-Za-z]:[\\/]/;
const WINDOWS_UNC_PATH_PATTERN = /^\\\\/;
const EXTERNAL_SCHEME_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/;
const RELATIVE_PATH_PREFIX_PATTERN = /^(~\/|\.{1,2}\/)/;
const RELATIVE_FILE_PATH_PATTERN = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}$/;
const RELATIVE_FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+(?::\d+){0,2}$/;
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const POSITION_ONLY_PATTERN = /^\d+(?::\d+)?$/;
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

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function unwrapMarkdownLinkDestination(value: string): string {
  return value.startsWith("<") && value.endsWith(">") ? value.slice(1, -1) : value;
}

export function normalizeMarkdownLinkDestination(value: string): string {
  return unwrapMarkdownLinkDestination(value.trim());
}

function stripSearchAndHash(value: string): { path: string; hash: string } {
  const hashIndex = value.indexOf("#");
  const pathWithSearch = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const rawHash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const queryIndex = pathWithSearch.indexOf("?");
  const path = queryIndex >= 0 ? pathWithSearch.slice(0, queryIndex) : pathWithSearch;
  return { path, hash: rawHash };
}

function normalizeWindowsDrivePath(path: string): string {
  return /^\/[A-Za-z]:[\\/]/.test(path) ? path.slice(1) : path;
}

function decodeFileUrlPath(path: string, decodePath: boolean | undefined): string {
  return decodePath === false ? path : safeDecode(path);
}

function parseFileUrlHref(
  href: string,
  options?: { readonly decodePath?: boolean },
): { path: string; hash: string } | null {
  try {
    const parsed = new URL(href);
    if (parsed.protocol.toLowerCase() !== "file:") return null;

    const rawPath = parsed.pathname;
    if (rawPath.length === 0) return null;

    const hostname = parsed.hostname;
    if (hostname && hostname.toLowerCase() !== "localhost") {
      const uncTail = decodeFileUrlPath(rawPath, options?.decodePath).replaceAll("/", "\\");
      return { path: `\\\\${hostname}${uncTail}`, hash: parsed.hash };
    }

    const decodedPath = decodeFileUrlPath(rawPath, options?.decodePath);
    // file://///server/share/file.txt → pathname "//server/share/file.txt"
    if (decodedPath.startsWith("//")) {
      return { path: decodedPath.replaceAll("/", "\\"), hash: parsed.hash };
    }

    // Browser URL parser encodes "C:/foo" as "/C:/foo" for file URLs.
    const normalizedPath = normalizeWindowsDrivePath(decodedPath);

    return {
      path: normalizedPath,
      hash: parsed.hash,
    };
  } catch {
    return null;
  }
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const normalizedHref = normalizeMarkdownLinkDestination(href);
  const target = parseFileUrlHref(normalizedHref, { decodePath: false });
  if (target) return `${target.path}${target.hash}`;
  // Leftover `D:/...` / UNC hrefs never became file: URLs. Keep them so
  // react-markdown's urlTransform does not treat the drive letter as a protocol.
  if (
    WINDOWS_DRIVE_PATH_PATTERN.test(normalizedHref) ||
    WINDOWS_UNC_PATH_PATTERN.test(normalizedHref)
  ) {
    return normalizedHref;
  }
  return null;
}

const HAS_WINDOWS_FILESYSTEM_PATH_PATTERN = /[A-Za-z]:[\\/]|\\\\/;
const INLINE_MARKDOWN_LINK_PATTERN =
  /(!?\[[^\]]*])\(([ \t]*)(?:<([^>\n]*)>|([^ \t\n)]+))((?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?)([ \t]*)\)/g;
const MARKDOWN_LINK_DEFINITION_PATTERN =
  /^([ \t]{0,3}\[[^\]]+\]:[ \t]+)(?:<([^>\n]*)>|(\S+))((?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?)([ \t]*)$/gm;
const ANGLE_AUTOLINK_PATTERN = /<([^<>\n]+)>/g;
const PROTECTED_MARKDOWN_SPAN_PATTERN = /!?\[[^\]]*]\([^)]*\)|!?\[[^\]]*]\[[^\]]*]|<[^>\n]+>/g;
const BARE_WINDOWS_PATH_PATTERN =
  /(?<![A-Za-z0-9_/])(?:[A-Za-z]:[\\/][^\s<>[\]()`]+|\\\\[^\s<>[\]()`\\/]+(?:[\\/][^\s<>[\]()`]+)+)/g;
const AUTOLINK_TRAILING_PUNCTUATION_PATTERN = /[.,;:!?')\]}"]+$/;

/**
 * Rewrites Windows drive/UNC markdown destinations and bare paths to `file://`
 * URLs so rehype-sanitize does not treat `D:` as an unknown protocol.
 * Leaves fenced code, inline code, and non-file links alone.
 */
export function normalizeWindowsMarkdownFileLinks(markdown: string): string {
  if (markdown.length === 0 || !HAS_WINDOWS_FILESYSTEM_PATH_PATTERN.test(markdown)) {
    return markdown;
  }
  return mapMarkdownOutsideCode(markdown, rewriteWindowsMarkdownInText);
}

function windowsFilesystemPathToFileUrl(path: string): string | null {
  const value = unwrapMarkdownLinkDestination(path.trim());
  if (value.length === 0) return null;

  const { path: pathOnly, hash } = stripSearchAndHash(value);

  if (WINDOWS_DRIVE_PATH_PATTERN.test(pathOnly)) {
    if (!/[^\s\\/]/.test(pathOnly.slice(3))) return null;
    return `file:///${pathOnly.replaceAll("\\", "/")}${hash}`;
  }

  if (WINDOWS_UNC_PATH_PATTERN.test(pathOnly)) {
    const parts = pathOnly
      .slice(2)
      .split(/[\\/]/)
      .filter((part) => part.length > 0);
    if (parts.length < 2) return null;
    return `file://${parts.join("/")}${hash}`;
  }

  return null;
}

function rewriteInlineWindowsLinkDestinations(text: string): string {
  return text.replace(
    INLINE_MARKDOWN_LINK_PATTERN,
    (
      match,
      label: string,
      ws: string,
      angleDest: string | undefined,
      bareDest: string | undefined,
      title: string,
      trailWs: string,
    ) => {
      const fileUrl = windowsFilesystemPathToFileUrl(angleDest ?? bareDest ?? "");
      if (!fileUrl) return match;
      const dest = angleDest !== undefined ? `<${fileUrl}>` : fileUrl;
      return `${label}(${ws}${dest}${title}${trailWs})`;
    },
  );
}

function rewriteWindowsLinkDefinitions(text: string): string {
  return text.replace(
    MARKDOWN_LINK_DEFINITION_PATTERN,
    (
      match,
      prefix: string,
      angleDest: string | undefined,
      bareDest: string | undefined,
      title: string,
      trailWs: string,
    ) => {
      const fileUrl = windowsFilesystemPathToFileUrl(angleDest ?? bareDest ?? "");
      if (!fileUrl) return match;
      const dest = angleDest !== undefined ? `<${fileUrl}>` : fileUrl;
      return `${prefix}${dest}${title}${trailWs}`;
    },
  );
}

function rewriteWindowsAngleAutolinks(text: string): string {
  return text.replace(ANGLE_AUTOLINK_PATTERN, (match, dest: string) => {
    const fileUrl = windowsFilesystemPathToFileUrl(dest);
    return fileUrl ? `<${fileUrl}>` : match;
  });
}

function splitAutolinkWindowsPath(raw: string): { path: string; trailing: string } {
  if (POSITION_SUFFIX_PATTERN.test(raw)) return { path: raw, trailing: "" };
  const trimmed = raw.replace(AUTOLINK_TRAILING_PUNCTUATION_PATTERN, "");
  if (trimmed.length === 0 || trimmed === raw) return { path: raw, trailing: "" };
  if (!windowsFilesystemPathToFileUrl(trimmed)) return { path: raw, trailing: "" };
  return { path: trimmed, trailing: raw.slice(trimmed.length) };
}

function autolinkBareWindowsPaths(text: string): string {
  const slots: string[] = [];
  const withSlots = text.replace(PROTECTED_MARKDOWN_SPAN_PATTERN, (match) => {
    const token = `\0${slots.length}\0`;
    slots.push(match);
    return token;
  });

  const linked = withSlots.replace(BARE_WINDOWS_PATH_PATTERN, (raw) => {
    const { path, trailing } = splitAutolinkWindowsPath(raw);
    const fileUrl = windowsFilesystemPathToFileUrl(path);
    if (!fileUrl) return raw;
    return `[${path}](${fileUrl})${trailing}`;
  });

  if (slots.length === 0) return linked;
  return linked.replace(/\0(\d+)\0/g, (_, index: string) => slots[Number(index)] ?? "");
}

function rewriteWindowsMarkdownInText(text: string): string {
  const withDestinations = rewriteWindowsLinkDefinitions(
    rewriteInlineWindowsLinkDestinations(text),
  );
  return autolinkBareWindowsPaths(rewriteWindowsAngleAutolinks(withDestinations));
}

const FENCED_CODE_SEGMENT_PATTERN = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/;
const INLINE_CODE_SEGMENT_PATTERN = /(`[^`\n]+`)/;

function mapOutsideInlineCode(text: string, transform: (chunk: string) => string): string {
  return text
    .split(INLINE_CODE_SEGMENT_PATTERN)
    .map((segment, index) => (index % 2 === 1 ? segment : transform(segment)))
    .join("");
}

function mapMarkdownOutsideCode(markdown: string, transform: (text: string) => string): string {
  return markdown
    .split(FENCED_CODE_SEGMENT_PATTERN)
    .map((segment, index) => (index % 2 === 1 ? segment : mapOutsideInlineCode(segment, transform)))
    .join("");
}

function looksLikePosixFilesystemPath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix))) return true;
  if (POSITION_SUFFIX_PATTERN.test(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9_-]+$/.test(basename);
}

function appendLineColumnFromHash(path: string, hash: string): string {
  if (!hash || POSITION_SUFFIX_PATTERN.test(path)) return path;
  const match = hash.match(/^#L(\d+)(?:C(\d+))?$/i);
  if (!match?.[1]) return path;
  const line = match[1];
  const column = match[2];
  return `${path}:${line}${column ? `:${column}` : ""}`;
}

function isLikelyPathCandidate(path: string): boolean {
  if (WINDOWS_DRIVE_PATH_PATTERN.test(path) || WINDOWS_UNC_PATH_PATTERN.test(path)) return true;
  if (RELATIVE_PATH_PREFIX_PATTERN.test(path)) return true;
  if (path.startsWith("/")) return looksLikePosixFilesystemPath(path);
  return RELATIVE_FILE_PATH_PATTERN.test(path) || RELATIVE_FILE_NAME_PATTERN.test(path);
}

function isRelativePath(path: string): boolean {
  return (
    RELATIVE_PATH_PREFIX_PATTERN.test(path) ||
    (!path.startsWith("/") &&
      !WINDOWS_DRIVE_PATH_PATTERN.test(path) &&
      !WINDOWS_UNC_PATH_PATTERN.test(path))
  );
}

function hasExternalScheme(path: string): boolean {
  const match = path.match(EXTERNAL_SCHEME_PATTERN);
  if (!match) return false;
  const rest = match[2] ?? "";
  if (rest.startsWith("//")) return true;
  return !POSITION_ONLY_PATTERN.test(rest);
}

export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
): string | null {
  if (!href) return null;
  const rawHref = normalizeMarkdownLinkDestination(href);
  if (rawHref.length === 0 || rawHref.startsWith("#")) return null;

  const fileUrlTarget = rawHref.toLowerCase().startsWith("file:")
    ? parseFileUrlHref(rawHref)
    : null;
  const source = fileUrlTarget ?? stripSearchAndHash(rawHref);
  const decodedPath = normalizeWindowsDrivePath(
    fileUrlTarget ? source.path.trim() : safeDecode(source.path.trim()),
  );
  const decodedHash = safeDecode(source.hash.trim());

  if (decodedPath.length === 0) return null;
  if (
    !WINDOWS_DRIVE_PATH_PATTERN.test(decodedPath) &&
    !WINDOWS_UNC_PATH_PATTERN.test(decodedPath) &&
    hasExternalScheme(decodedPath)
  ) {
    return null;
  }

  if (!isLikelyPathCandidate(decodedPath)) return null;

  const pathWithPosition = appendLineColumnFromHash(decodedPath, decodedHash);
  if (!isRelativePath(pathWithPosition)) {
    return pathWithPosition;
  }

  if (!cwd) return null;
  return resolvePathLinkTarget(pathWithPosition, cwd);
}

const INLINE_CODE_DISQUALIFIER_PATTERN = /[\s`]/;
const PATH_SEPARATOR_PATTERN = /[\\/]/;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9_-]+$/;
const NUMERIC_DOTTED_PATTERN = /^\d+(?:\.\d+)+$/;
const BARE_EXTENSIONLESS_POSITION_PATTERN = /^[A-Za-z0-9_-]+(?::\d+){1,2}$/;
// Any `Name:digits` shape also matches `error:1`, `port:3000`, `TODO:12`, so
// extensionless linking is limited to conventional filenames.
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
// Allowlists, not full public-suffix detection: treating every dotted first
// segment as a host would swallow real paths like `conf.d/x.conf` or
// `Makefile.in:12`. Extensions that double as filename suffixes (`sh`, `md`,
// `ts`, `rs`, `in`, ...) are deliberately absent from both sets.
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
// Country codes collide with file extensions (`.pl` Perl, `.pt` PyTorch,
// `.es` ES modules), so they only count as host evidence when the candidate
// lacks a :line suffix — an explicit line reference marks a file and wins.
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

/** `127.0.0.1`, `localhost`, `example.com`, `1.2.3` — hosts and versions, not files. */
function looksLikeHostname(segment: string, hasPosition: boolean): boolean {
  if (segment.startsWith(".")) return false;
  const lowered = segment.toLowerCase();
  if (SINGLE_LABEL_HOSTNAMES.has(lowered)) return true;
  if (NUMERIC_DOTTED_PATTERN.test(segment)) return true;
  const labels = lowered.split(".");
  const lastLabel = labels[labels.length - 1];
  if (labels.length < 2 || lastLabel === undefined) return false;
  if (GENERIC_HOSTNAME_TLDS.has(lastLabel)) return true;
  return !hasPosition && COUNTRY_HOSTNAME_TLDS.has(lastLabel);
}

/**
 * Inline code spans mostly hold identifiers, commands, and refs (`node.meta`,
 * `origin/main`) rather than deliberate link destinations, so auto-linking
 * them demands stronger path evidence than an explicit markdown link does:
 * an unambiguous path prefix, a file extension, or a :line suffix.
 */
export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const trimmed = codeText.trim();
  if (trimmed.length === 0 || INLINE_CODE_DISQUALIFIER_PATTERN.test(trimmed)) return null;

  // Windows drive/UNC paths keep their backslashes; any other backslashes are
  // relative Windows-style paths, which neither the shape checks nor the
  // downstream resolver understand — normalize them to forward slashes.
  const candidate =
    WINDOWS_DRIVE_PATH_PATTERN.test(trimmed) || WINDOWS_UNC_PATH_PATTERN.test(trimmed)
      ? trimmed
      : trimmed.replaceAll("\\", "/");

  const hasPosition = POSITION_SUFFIX_PATTERN.test(candidate);
  if (!hasPosition && !PATH_SEPARATOR_PATTERN.test(candidate)) return null;

  const hasExplicitPathShape =
    RELATIVE_PATH_PREFIX_PATTERN.test(candidate) ||
    candidate.startsWith("/") ||
    WINDOWS_DRIVE_PATH_PATTERN.test(candidate) ||
    WINDOWS_UNC_PATH_PATTERN.test(candidate);
  if (!hasExplicitPathShape) {
    const withoutPosition = candidate.replace(POSITION_SUFFIX_PATTERN, "");
    const firstSegment = withoutPosition.split("/")[0] ?? withoutPosition;
    if (looksLikeHostname(firstSegment, hasPosition)) return null;
    if (!hasPosition && !FILE_EXTENSION_PATTERN.test(basenameOfPath(withoutPosition))) {
      return null;
    }
  }

  const resolved = resolveMarkdownFileLinkMeta(candidate, cwd);
  if (resolved) return resolved;

  // `Makefile:12` — conventional extensionless names fail the generic
  // markdown-link candidate patterns, but here the :line suffix already
  // marked the span as a file reference.
  if (
    cwd &&
    BARE_EXTENSIONLESS_POSITION_PATTERN.test(candidate) &&
    EXTENSIONLESS_FILE_NAMES.has(candidate.replace(POSITION_SUFFIX_PATTERN, ""))
  ) {
    return buildFileLinkMetaFromTarget(resolvePathLinkTarget(candidate, cwd), cwd);
  }
  return null;
}

function basenameOfPath(path: string): string {
  // A trailing separator is a valid way to write a directory, so trim it before
  // taking the final segment. Without this the segment reads as empty and the
  // chip renders with no label at all.
  const trimmed = path.replace(/[/\\]+$/, "") || path;
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex >= 0 ? trimmed.slice(separatorIndex + 1) : trimmed;
}

function workspaceRelativePath(path: string, workspaceRoot: string | undefined): string | null {
  if (!workspaceRoot) return null;
  const normalizedPath = normalizeWindowsDrivePath(path.replaceAll("\\", "/"));
  const normalizedRoot = normalizeWindowsDrivePath(workspaceRoot.replaceAll("\\", "/")).replace(
    /\/+$/,
    "",
  );
  const pathForCompare = normalizedPath.toLowerCase();
  const rootForCompare = normalizedRoot.toLowerCase();
  if (!pathForCompare.startsWith(`${rootForCompare}/`)) return null;
  return normalizedPath.slice(normalizedRoot.length + 1);
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd);
  if (!targetPath) return null;
  return buildFileLinkMetaFromTarget(targetPath, cwd);
}

function buildFileLinkMetaFromTarget(targetPath: string, cwd?: string): MarkdownFileLinkMeta {
  const { path, line, column } = splitPathAndPosition(targetPath);
  const parsedLine = line ? Number.parseInt(line, 10) : Number.NaN;
  const parsedColumn = column ? Number.parseInt(column, 10) : Number.NaN;
  const lineNumber = Number.isFinite(parsedLine) ? parsedLine : undefined;
  const columnNumber = Number.isFinite(parsedColumn) ? parsedColumn : undefined;

  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativePath(path, cwd),
    basename: basenameOfPath(path),
    ...(lineNumber !== undefined ? { line: lineNumber } : {}),
    ...(columnNumber !== undefined ? { column: columnNumber } : {}),
  };
}
