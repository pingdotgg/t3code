import type { DesktopUpdateReleaseNote } from "@t3tools/contracts";

interface ElectronReleaseNoteInfo {
  readonly version: string;
  readonly note: string | null | undefined;
}

function isElectronReleaseNoteInfo(value: unknown): value is ElectronReleaseNoteInfo {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly version?: unknown; readonly note?: unknown };
  return (
    typeof candidate.version === "string" &&
    (typeof candidate.note === "string" || candidate.note === null || candidate.note === undefined)
  );
}

const MAX_RELEASE_NOTE_GROUPS = 6;
const MAX_RELEASE_NOTE_ITEMS_PER_GROUP = 8;
const MAX_RELEASE_NOTE_ITEM_LENGTH = 220;

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeCodePoint(codePoint: number, entity: string): string {
  // String.fromCodePoint throws RangeError outside the valid Unicode range, and
  // Number.isFinite alone lets oversized values (e.g. &#9999999999;) through.
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return `&${entity};`;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntity(entity: string): string {
  const named = HTML_ENTITY_REPLACEMENTS[entity];
  if (named) return named;
  if (entity.startsWith("#x")) {
    return decodeCodePoint(Number.parseInt(entity.slice(2), 16), entity);
  }
  if (entity.startsWith("#")) {
    return decodeCodePoint(Number.parseInt(entity.slice(1), 10), entity);
  }
  return `&${entity};`;
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) =>
    decodeHtmlEntity(entity),
  );
}

function stripMarkup(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1"),
  );
}

function truncateReleaseNoteItem(item: string): string {
  if (item.length <= MAX_RELEASE_NOTE_ITEM_LENGTH) return item;
  return `${item.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 3).trimEnd()}...`;
}

function isIgnoredReleaseNoteLine(line: string): boolean {
  const normalized = line
    .toLowerCase()
    .replace(/[*_`#]/g, "")
    .trim();
  return (
    normalized === "" ||
    normalized === "what's changed" ||
    normalized === "whats changed" ||
    normalized === "full changelog" ||
    normalized === "new contributors" ||
    normalized.startsWith("compare: ") ||
    normalized.includes("/compare/")
  );
}

function extractReleaseNoteItems(note: string | null | undefined): ReadonlyArray<string> {
  if (!note) return [];

  const items: string[] = [];
  for (const rawLine of stripMarkup(note).split("\n")) {
    const item = rawLine
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\s+/g, " ");
    if (isIgnoredReleaseNoteLine(item)) continue;
    items.push(truncateReleaseNoteItem(item));
    if (items.length >= MAX_RELEASE_NOTE_ITEMS_PER_GROUP) break;
  }
  return items;
}

export function normalizeDesktopUpdateReleaseNotes(
  releaseNotes: unknown,
  fallbackVersion: string,
): ReadonlyArray<DesktopUpdateReleaseNote> {
  const rawNotes =
    typeof releaseNotes === "string"
      ? [{ version: fallbackVersion, note: releaseNotes }]
      : Array.isArray(releaseNotes)
        ? releaseNotes.filter(isElectronReleaseNoteInfo)
        : [];

  return rawNotes
    .map((entry) => ({
      version: entry.version,
      items: extractReleaseNoteItems(entry.note),
    }))
    .filter((entry) => entry.items.length > 0)
    .slice(0, MAX_RELEASE_NOTE_GROUPS);
}
