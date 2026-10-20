import type { PullRequestReviewGuideExcerpt, PullRequestReviewGuideStop } from "@t3tools/contracts";
import type { ReviewGuideGenerationResult } from "@t3tools/provider-core/server/textGeneration";
import { reviewFileGroup } from "@t3tools/shared/reviewFileClassification";

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

/**
 * GitHub tracks viewed state for whole files. Keep every excerpt and note for a file in one
 * chapter, preferring the first chapter that actually shows it over a files-only mention.
 * Also used for guides stored before generation enforced this rule.
 */
export function groupReviewGuideFiles(
  stops: ReadonlyArray<PullRequestReviewGuideStop>,
): Array<PullRequestReviewGuideStop> {
  const owners = new Map<string, number>();
  stops.forEach((stop, index) => {
    for (const excerpt of stop.excerpts) {
      if (!owners.has(excerpt.path)) owners.set(excerpt.path, index);
    }
  });
  stops.forEach((stop, index) => {
    for (const file of stop.files) {
      if (!owners.has(file.path)) owners.set(file.path, index);
    }
  });

  const chapters = stops.map((stop) => ({
    ...stop,
    excerpts: [] as Array<PullRequestReviewGuideExcerpt>,
    files: [] as Array<PullRequestReviewGuideStop["files"][number]>,
    notes: [] as Array<PullRequestReviewGuideStop["notes"][number]>,
  }));
  const excerpted = new Set(stops.flatMap((stop) => stop.excerpts.map((excerpt) => excerpt.path)));
  const listed = new Set<string>();
  for (const stop of stops) {
    for (const excerpt of stop.excerpts) {
      chapters[owners.get(excerpt.path)!]!.excerpts.push(excerpt);
    }
    for (const file of stop.files) {
      if (excerpted.has(file.path) || listed.has(file.path)) continue;
      chapters[owners.get(file.path)!]!.files.push(file);
      listed.add(file.path);
    }
    for (const note of stop.notes) {
      const owner = owners.get(note.path);
      if (owner !== undefined) chapters[owner]!.notes.push(note);
    }
  }
  return chapters.map((chapter) => {
    // Preserve every range and caption, grouping by first appearance without expanding or
    // merging ranges from other chapters, which could discard a later note's anchor.
    const paths = [...new Set(chapter.excerpts.map((excerpt) => excerpt.path))];
    return {
      ...chapter,
      excerpts: paths.flatMap((path) =>
        chapter.excerpts.filter((excerpt) => excerpt.path === path),
      ),
    };
  });
}

/**
 * Holds a generated guide to the change it describes. A model's line numbers and ids are
 * suggestions: excerpts are clamped to changed lines, notes must sit inside what is left, and any
 * changed file the tour skipped lands in a closing skim stop.
 */
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

  const stops = groupReviewGuideFiles(shaped);
  const placed = new Set(
    stops.flatMap((stop) => [
      ...stop.excerpts.map((excerpt) => excerpt.path),
      ...stop.files.map((file) => file.path),
    ]),
  );
  const unplaced = change.files.filter((path) => !placed.has(path));
  const unplacedSource = unplaced.filter((path) => reviewFileGroup(path) !== "generated");
  if (unplacedSource.length > 0) {
    stops.push({
      title: "Other files",
      summary: "Changed files the tour does not otherwise cover.",
      attention: null,
      excerpts: [],
      files: unplacedSource.map((path) => ({ path })),
      notes: [],
      questions: [],
    });
  }
  // Keep generated output apart even when a model mixes it into a chapter or omits it.
  const generatedPaths = change.files.filter((path) => reviewFileGroup(path) === "generated");
  if (generatedPaths.length === 0) return { ...guide, stops };
  const generated = new Set(generatedPaths);
  const generatedOnly = (stop: PullRequestReviewGuideStop) => {
    const paths = [
      ...stop.files.map((file) => file.path),
      ...stop.excerpts.map((excerpt) => excerpt.path),
    ];
    return paths.length > 0 && paths.every((path) => generated.has(path));
  };
  const chapters = stops
    .filter((stop) => !generatedOnly(stop))
    .map((stop) => ({
      ...stop,
      files: stop.files.filter((file) => !generated.has(file.path)),
      excerpts: stop.excerpts.filter((excerpt) => !generated.has(excerpt.path)),
      notes: stop.notes.filter((note) => !generated.has(note.path)),
    }));
  const generatedChapters = stops.filter(generatedOnly);
  const covered = new Set(
    generatedChapters.flatMap((stop) => [
      ...stop.files.map((file) => file.path),
      ...stop.excerpts.map((excerpt) => excerpt.path),
    ]),
  );
  const missing = generatedPaths.filter((path) => !covered.has(path));
  if (missing.length > 0) {
    const missingSet = new Set(missing);
    const excerpts = stops.flatMap((stop) =>
      stop.excerpts.filter((excerpt) => missingSet.has(excerpt.path)),
    );
    const excerpted = new Set(excerpts.map((excerpt) => excerpt.path));
    generatedChapters.push({
      title: "Generated files",
      summary:
        "Generated output and lockfiles. Review these alongside the source changes that produce them.",
      attention: null,
      excerpts,
      files: missing.filter((path) => !excerpted.has(path)).map((path) => ({ path })),
      notes: stops.flatMap((stop) => stop.notes.filter((note) => missingSet.has(note.path))),
      questions: [],
    });
  }
  return { ...guide, stops: [...chapters, ...generatedChapters] };
}
