import type { DesktopUpdateChannel, DesktopUpdateReleaseNote } from "@t3tools/contracts";

import { desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";

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

function stripMarkup(input: string, keepBold = false): string {
  const markdown = decodeHtmlEntities(
    input
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n${"#".repeat(Number(level))} `)
      .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
      .replace(/<\/?(?:strong|b)\b[^>]*>/gi, "**")
      .replace(/<[^>]*>/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1"),
  );
  return keepBold ? markdown : markdown.replace(/\*\*([^*]+)\*\*/g, "$1");
}

function truncateReleaseNoteItem(item: string): string {
  if (item.length <= MAX_RELEASE_NOTE_ITEM_LENGTH) return item;
  return `${item.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 3).trimEnd()}...`;
}

function normalizeReleaseNoteLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[*_`#]/g, "")
    .trim();
}

function isIgnoredReleaseNoteLine(line: string): boolean {
  const normalized = normalizeReleaseNoteLine(line);
  return (
    normalized === "" ||
    normalized === "what's changed" ||
    normalized === "whats changed" ||
    normalized.startsWith("compare: ") ||
    normalized.includes("/compare/") ||
    // The feed's HTML footer loses its compare URL to stripMarkup, leaving only the range.
    /^full changelog: \S+\.\.\.\S+$/.test(normalized)
  );
}

type ExtractedReleaseNoteItems = Omit<DesktopUpdateReleaseNote, "version" | "releasedAt">;

/** Older generated notes have a highlights paragraph followed by a separate list of fixes. */
function extractReleaseNoteSummary(summary: string): ExtractedReleaseNoteItems {
  let stats: string | undefined;
  let footer: string | undefined;
  const intro: string[] = [];
  const items: string[] = [];
  for (const rawLine of stripMarkup(summary, true).split("\n")) {
    const line = rawLine
      .trim()
      .replace(/\s+/g, " ")
      .replace(/\s*\((?:#\d+(?:,\s*)?)+\)\.?$/, "")
      .trim();
    const plain = line.replace(/\*\*([^*]+)\*\*/g, "$1");
    if (/^### Plus \d+ more /.test(plain)) {
      footer = plain.slice(4);
      continue;
    }
    if (plain === "" || /^#{1,6}\s+/.test(plain)) continue;
    if (stats === undefined && /^v\S+ · /.test(plain)) {
      stats = plain.slice(plain.indexOf(" · ") + 3);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      items.push(line.replace(/^[-*]\s+/, ""));
    } else {
      intro.push(plain);
    }
  }
  return {
    items,
    totalItems: items.length + intro.length,
    ...(intro.length > 0 ? { intro: intro.join(" ") } : {}),
    ...(stats ? { stats } : {}),
    ...(footer ? { footer } : {}),
  };
}

function extractReleaseNoteItems(note: string | null | undefined): ExtractedReleaseNoteItems {
  if (!note) return { items: [], totalItems: 0 };

  // Generated summaries fold GitHub's full list under this exact <details> block.
  const summaryEnd = note.search(/<details>\s*<summary>\s*Full changelog\s*<\/summary>/i);
  if (summaryEnd >= 0) return extractReleaseNoteSummary(note.slice(0, summaryEnd));
  const items: string[] = [];
  let totalItems = 0;
  for (const rawLine of stripMarkup(note).split("\n")) {
    const item = rawLine
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\s+/g, " ");
    const normalized = normalizeReleaseNoteLine(item);
    if (normalized === "new contributors" || normalized === "full changelog") break;
    if (/^#{1,6}\s+/.test(item)) continue;
    if (isIgnoredReleaseNoteLine(item)) continue;
    totalItems += 1;
    items.push(truncateReleaseNoteItem(item));
    if (items.length > MAX_RELEASE_NOTE_ITEMS_PER_GROUP) items.shift();
  }
  return { items: items.toReversed(), totalItems };
}

// The update feed dates only the offered version; prerelease versions carry their UTC build day.
const PRERELEASE_BUILD_DAY = /-(?:nightly|preview)\.(\d{4})(\d{2})(\d{2})\.\d+$/;

function resolveReleasedAt(version: string, offeredVersion: string, releaseDate?: string) {
  if (version === offeredVersion && releaseDate) return releaseDate;
  const day = PRERELEASE_BUILD_DAY.exec(version);
  return day ? `${day[1]}-${day[2]}-${day[3]}` : undefined;
}

interface NormalizedDesktopUpdateReleaseNotes {
  readonly releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>;
  readonly omittedReleaseCount: number;
}

/** fullChangelog includes all greater semvers, so preview cuts sort above nightlies of the same base version. */
export function normalizeDesktopUpdateReleaseNotes(
  releaseNotes: unknown,
  fallbackVersion: string,
  channel: DesktopUpdateChannel,
  releaseDate?: string,
): NormalizedDesktopUpdateReleaseNotes {
  const rawNotes = (
    typeof releaseNotes === "string"
      ? [{ version: fallbackVersion, note: releaseNotes }]
      : Array.isArray(releaseNotes)
        ? releaseNotes.filter(isElectronReleaseNoteInfo)
        : []
  ).filter((entry) => desktopUpdateChannelOf(entry.version) === channel);

  const normalizedNotes = rawNotes.flatMap((entry) => {
    const note = extractReleaseNoteItems(entry.note);
    if (note.totalItems === 0 && !note.stats) return [];
    const releasedAt = resolveReleasedAt(entry.version, fallbackVersion, releaseDate);
    return [
      {
        version: entry.version,
        ...note,
        ...(releasedAt ? { releasedAt } : {}),
      },
    ];
  });

  return {
    releaseNotes: normalizedNotes.slice(0, MAX_RELEASE_NOTE_GROUPS),
    omittedReleaseCount: Math.max(0, normalizedNotes.length - MAX_RELEASE_NOTE_GROUPS),
  };
}
