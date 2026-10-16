import type { PullRequestReviewGuideExcerpt, PullRequestReviewGuideStop } from "@t3tools/contracts";
import type { ReviewGuideGenerationResult } from "@t3tools/provider-core/server/textGeneration";

const MAX_EXCERPT_LINES = 25;

interface LineRange {
  readonly start: number;
  readonly end: number;
}

interface FileHunks {
  readonly new: Array<LineRange>;
  readonly old: Array<LineRange>;
}

export interface ReviewGuideChange {
  readonly files: ReadonlyArray<string>;
  readonly hunks: ReadonlyMap<string, FileHunks>;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const hunkRange = (start: string, count: string | undefined): LineRange | null => {
  const lines = count === undefined ? 1 : Number(count);
  return lines === 0 ? null : { start: Number(start), end: Number(start) + lines - 1 };
};

export function parseReviewGuideChange(nameOnly: string, patch: string): ReviewGuideChange {
  const hunks = new Map<string, FileHunks>();
  let oldPath: string | null = null;
  let current: FileHunks | null = null;
  // Inside a file's hunks a `--- ` or `+++ ` line is a removed or added source line, not a header.
  let inHunks = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      oldPath = null;
      current = null;
      inHunks = false;
    } else if (!inHunks && line.startsWith("--- ")) {
      oldPath = line.startsWith("--- a/") ? line.slice(6) : null;
    } else if (!inHunks && line.startsWith("+++ ")) {
      const path = line.startsWith("+++ b/") ? line.slice(6) : oldPath;
      if (path === null) continue;
      current = hunks.get(path) ?? { new: [], old: [] };
      hunks.set(path, current);
    } else if (current !== null) {
      const header = HUNK_HEADER.exec(line);
      if (header === null) continue;
      inHunks = true;
      const removed = hunkRange(header[1]!, header[2]);
      const added = hunkRange(header[3]!, header[4]);
      if (removed !== null) current.old.push(removed);
      if (added !== null) current.new.push(added);
    }
  }
  return { files: nameOnly.split("\0").filter((path) => path !== ""), hunks };
}

function clampExcerpt(
  excerpt: PullRequestReviewGuideExcerpt,
  change: ReviewGuideChange,
): PullRequestReviewGuideExcerpt | null {
  const start = Math.min(excerpt.start, excerpt.end);
  const end = Math.max(excerpt.start, excerpt.end);
  const overlapping = (change.hunks.get(excerpt.path)?.[excerpt.side] ?? []).filter(
    (hunk) => hunk.start <= end && start <= hunk.end,
  );
  const first = overlapping[0];
  const last = overlapping.at(-1);
  if (first === undefined || last === undefined) return null;
  return { ...excerpt, start: Math.max(start, first.start), end: Math.min(end, last.end) };
}

function mergeExcerpts(
  excerpts: ReadonlyArray<PullRequestReviewGuideExcerpt>,
): Array<PullRequestReviewGuideExcerpt> {
  const merged: Array<PullRequestReviewGuideExcerpt> = [];
  for (const excerpt of excerpts) {
    const index = merged.findIndex(
      (other) =>
        other.path === excerpt.path &&
        other.side === excerpt.side &&
        other.start <= excerpt.end + 1 &&
        excerpt.start <= other.end + 1,
    );
    const other = merged[index];
    if (other === undefined) {
      merged.push(excerpt);
      continue;
    }
    merged[index] = {
      ...other,
      start: Math.min(other.start, excerpt.start),
      end: Math.max(other.end, excerpt.end),
      caption: other.caption || excerpt.caption,
    };
  }
  return merged.map((excerpt) => ({
    ...excerpt,
    end: Math.min(excerpt.end, excerpt.start + MAX_EXCERPT_LINES - 1),
  }));
}

const nonEmpty = (value: string) => value.trim() !== "";

export function normalizeReviewGuide(
  guide: ReviewGuideGenerationResult,
  change: ReviewGuideChange,
): ReviewGuideGenerationResult {
  const changed = new Set(change.files);
  const inChange = (path: string) => changed.has(path);

  const shaped: Array<PullRequestReviewGuideStop> = guide.stops
    .filter((stop) => nonEmpty(stop.title))
    .map((stop) => {
      const excerpts = mergeExcerpts(
        stop.excerpts.flatMap((excerpt) => {
          const clamped = inChange(excerpt.path) ? clampExcerpt(excerpt, change) : null;
          return clamped === null ? [] : [clamped];
        }),
      );
      return {
        ...stop,
        attention: stop.attention !== null && nonEmpty(stop.attention.note) ? stop.attention : null,
        excerpts,
        files: stop.files
          .filter((file) => inChange(file.path))
          .map(({ path, note }) => (note?.trim() ? { path, note } : { path })),
        notes: stop.notes.filter(
          (note) =>
            nonEmpty(note.title) &&
            excerpts.some(
              (excerpt) =>
                excerpt.path === note.path &&
                excerpt.start <= note.line &&
                note.line <= excerpt.end,
            ),
        ),
        questions: stop.questions.filter(nonEmpty),
      };
    });

  const placed = new Set(shaped.flatMap((stop) => stop.excerpts.map((excerpt) => excerpt.path)));
  const stops = shaped.map((stop) => {
    const files = stop.files.filter((file) => !placed.has(file.path));
    for (const file of files) placed.add(file.path);
    return { ...stop, files };
  });
  const unplaced = change.files.filter((path) => !placed.has(path));
  if (unplaced.length > 0) {
    stops.push({
      title: "Other files",
      summary: "Changed files the tour does not otherwise cover.",
      attention: null,
      excerpts: [],
      files: unplaced.map((path) => ({ path })),
      notes: [],
      questions: [],
    });
  }

  return { ...guide, stops };
}
