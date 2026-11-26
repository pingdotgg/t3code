import { parseMarkdownFileLink } from "./markdownLinks.ts";

export interface CodexFileCitationLink {
  readonly path: string;
  readonly href: string;
  readonly label: string;
  readonly lineRangeStart?: number;
}

export type CodexFileCitationAttributes = Readonly<Record<string, string | null | undefined>>;

function positiveInteger(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function citationLabel(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized || "File";
}

const ABSOLUTE_OR_URI_PATH_PATTERN =
  /^(?:[a-z]:[\\/]|[\\/]|[a-z][a-z\d+.-]*:\/\/|(?:file|sandbox):\/)/i;
const COLON_BEFORE_SLASH_PATTERN = /^[^/]*:/;

function markdownDestinationPath(path: string): string {
  const destination = path
    .replaceAll("%", "%25")
    .replaceAll("#", "%23")
    .replaceAll("?", "%3F")
    .replace(/^\s+|\s+$/g, (whitespace) => encodeURIComponent(whitespace));
  if (/^\/\/[^/\\]+[\\/][^/\\]/.test(path)) {
    return `\\\\${destination.slice(2).replaceAll("/", "\\")}`;
  }
  if (ABSOLUTE_OR_URI_PATH_PATTERN.test(path)) return destination;
  // Relative paths with a colon before the first slash look like URI schemes to HTML sanitizers.
  return COLON_BEFORE_SLASH_PATTERN.test(path) || !parseMarkdownFileLink(destination)
    ? `./${destination}`
    : destination;
}

export function resolveCodexFileCitationLink(
  attributes: CodexFileCitationAttributes | null | undefined,
): CodexFileCitationLink | null {
  const path = attributes?.path;
  if (!path?.trim()) return null;

  const lineRangeStart = positiveInteger(attributes?.line_range_start);
  const destinationPath = markdownDestinationPath(path);
  return {
    path,
    href: lineRangeStart === undefined ? destinationPath : `${destinationPath}#L${lineRangeStart}`,
    label: citationLabel(path),
    ...(lineRangeStart === undefined ? {} : { lineRangeStart }),
  };
}

function markdownLabel(value: string): string {
  return value.replace(/[\\[\]*_`~<&|]/g, "\\$&");
}

function markdownDestination(value: string): string {
  return value
    .replaceAll("\\", "%5C")
    .replaceAll("&", "%26")
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E")
    .replaceAll("|", "%7C")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export function codexFileCitationMarkdown(citation: CodexFileCitationLink): string {
  return `[${markdownLabel(citation.label)}](<${markdownDestination(citation.href)}>)`;
}
