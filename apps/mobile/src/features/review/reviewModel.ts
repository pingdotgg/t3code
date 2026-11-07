import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { ChangeTypes, FileDiffMetadata } from "@pierre/diffs/types";
import {
  checkpointFileTotals,
  type ThreadCheckpointSummary,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import type { ReviewDiffPreviewSource } from "@t3tools/contracts";
import { quoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";

export type ReviewSectionKind = "turn" | "working-tree" | "branch-range";

const CHANGES_SECTION_ID = "git:branch-range";
const CHANGES_TITLE = "Changes";
const UNCOMMITTED_SUBTITLE = "Staged, unstaged, and untracked files";

export interface ReviewSectionItem {
  readonly id: string;
  readonly kind: ReviewSectionKind;
  readonly title: string;
  readonly subtitle: string | null;
  readonly diff: string | null;
  readonly isLoading: boolean;
  readonly files?: ReviewDiffPreviewSource["files"];
  readonly truncated?: boolean;
  readonly source?: ReviewDiffPreviewSource;
}

export interface ReviewRenderableHunkRow {
  readonly kind: "hunk";
  readonly id: string;
  readonly header: string;
  readonly context: string | null;
}

export interface ReviewRenderableLineRow {
  readonly kind: "line";
  readonly id: string;
  readonly change: "context" | "add" | "delete";
  readonly oldLineNumber: number | null;
  readonly newLineNumber: number | null;
  readonly content: string;
  readonly additionTokenIndex: number | null;
  readonly deletionTokenIndex: number | null;
  readonly comparison: {
    readonly change: "add" | "delete";
    readonly tokenIndex: number;
  } | null;
}

export type ReviewRenderableRow = ReviewRenderableHunkRow | ReviewRenderableLineRow;

export interface ReviewRenderableFile {
  readonly id: string;
  readonly cacheKey: string;
  readonly notice?: string;
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeType: ChangeTypes;
  readonly additions: number;
  readonly deletions: number;
  readonly languageHint: string | null;
  readonly additionLines: ReadonlyArray<string>;
  readonly deletionLines: ReadonlyArray<string>;
  // Only populated after validating the entire raw file block against its original hunk count.
  readonly completePatchSource?: () => {
    readonly oldContents: string;
    readonly newContents: string;
  };
  readonly noEOFCRAdditions?: boolean;
  readonly noEOFCRDeletions?: boolean;
  readonly rows: ReadonlyArray<ReviewRenderableRow>;
}

export type ReviewFilePreviewState =
  | {
      readonly kind: "render";
    }
  | {
      readonly kind: "suppressed";
      readonly reason: "non-text" | "large";
      readonly title: string;
      readonly message: string;
      readonly actionLabel: string | null;
    };

export type ReviewParsedDiff =
  | {
      readonly kind: "empty";
    }
  | {
      readonly kind: "raw";
      readonly text: string;
      readonly reason: string;
      readonly notice: string | null;
    }
  | {
      readonly kind: "files";
      readonly files: ReadonlyArray<ReviewRenderableFile>;
      readonly fileCount: number;
      readonly additions: number;
      readonly deletions: number;
      readonly notice: string | null;
    };

function checkpointTitle(checkpoint: ThreadCheckpointSummary): string {
  return `Turn ${checkpoint.checkpointTurnCount}`;
}

function checkpointSubtitle(checkpoint: ThreadCheckpointSummary): string {
  const fileCount = checkpointFileTotals(checkpoint).count;
  if (checkpoint.status !== "ready") {
    return `Diff ${checkpoint.status}`;
  }
  return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
}

function compareCheckpointTurnCountDescending(
  left: ThreadCheckpointSummary,
  right: ThreadCheckpointSummary,
): -1 | 0 | 1 {
  if (left.checkpointTurnCount === right.checkpointTurnCount) {
    return 0;
  }

  return left.checkpointTurnCount > right.checkpointTurnCount ? -1 : 1;
}

const readyCheckpointOrder = Order.make<ThreadCheckpointSummary>(
  compareCheckpointTurnCountDescending,
);

function gitSubtitle(section: ReviewDiffPreviewSource): string | null {
  if (section.kind === "working-tree") {
    return UNCOMMITTED_SUBTITLE;
  }
  if (section.baseRef) {
    return `${section.baseRef} ... ${section.headRef ?? "HEAD"}`;
  }
  return "Base branch unavailable";
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function splitTruncationMarker(diff: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const marker = /(?:(?:\r?\n){1,2}|^)\[truncated\]\s*$/.exec(diff);
  if (!marker) {
    return { text: diff, truncated: false };
  }

  return {
    text: diff.slice(0, marker.index),
    truncated: true,
  };
}

function runDiffParserSilently<T>(callback: () => T): T {
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    return callback();
  } finally {
    console.error = originalConsoleError;
  }
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;
const LARGE_DIFF_LINE_THRESHOLD = 400;
const LARGE_DIFF_CHARACTER_THRESHOLD = 24_000;
const NON_TEXT_FILE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "icns",
  "avif",
  "heic",
  "tif",
  "tiff",
  "mp3",
  "wav",
  "flac",
  "ogg",
  "m4a",
  "aac",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "webm",
  "pdf",
  "zip",
  "gz",
  "tgz",
  "bz2",
  "7z",
  "rar",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "wasm",
  "exe",
  "dll",
  "so",
  "dylib",
]);

function fnv1a32(input: string, seed: number, multiplier: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

function buildPatchCacheKey(patch: string, scope: string): string {
  const primary = fnv1a32(patch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(patch, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER).toString(36);
  return `${scope}:${patch.length}:${primary}:${secondary}`;
}

// Re-parsing an unchanged page must preserve selection/collapse state. Intern only
// its cache key (never patch contents), keeping scoped Pierre keys off every UI row.
const reviewPatchIds = new Map<string, string>();

function getReviewPatchId(cacheKey: string): string {
  let id = reviewPatchIds.get(cacheKey);
  if (id === undefined) {
    id = `p${reviewPatchIds.size.toString(36)}`;
    reviewPatchIds.set(cacheKey, id);
  }
  return id;
}

function getFileExtension(path: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match?.[1]?.toLowerCase() ?? null;
}

function countReviewRenderableLineRows(file: ReviewRenderableFile): number {
  return file.rows.reduce((total, row) => total + (row.kind === "line" ? 1 : 0), 0);
}

function countReviewRenderableCharacters(file: ReviewRenderableFile): number {
  return file.rows.reduce(
    (total, row) => total + (row.kind === "line" ? row.content.length : row.header.length),
    0,
  );
}

export function getReviewFilePreviewState(file: ReviewRenderableFile): ReviewFilePreviewState {
  const extension = getFileExtension(file.path);
  if (extension && NON_TEXT_FILE_EXTENSIONS.has(extension)) {
    return {
      kind: "suppressed",
      reason: "non-text",
      title: "Non-text file",
      message: "Diff preview is not available for this file format.",
      actionLabel: null,
    };
  }

  const lineCount = countReviewRenderableLineRows(file);
  const characterCount = countReviewRenderableCharacters(file);
  if (lineCount > LARGE_DIFF_LINE_THRESHOLD || characterCount > LARGE_DIFF_CHARACTER_THRESHOLD) {
    return {
      kind: "suppressed",
      reason: "large",
      title: "Large diff",
      message: "Large diffs are not rendered by default.",
      actionLabel: "Load diff",
    };
  }

  return { kind: "render" };
}

function fallbackHunkHeader(hunk: FileDiffMetadata["hunks"][number]): string {
  return `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`;
}

function buildRenderableRows(
  file: FileDiffMetadata,
  fileId: string,
): ReadonlyArray<ReviewRenderableRow> {
  const rows: ReviewRenderableRow[] = [];
  let rowIndex = 0;

  file.hunks.forEach((hunk, hunkIndex) => {
    rows.push({
      kind: "hunk",
      id: `${fileId}:hunk:${hunkIndex}`,
      header: fallbackHunkHeader(hunk),
      context: hunk.hunkContext ? stripTrailingNewline(hunk.hunkContext) : null,
    });

    let deletionLineNumber = hunk.deletionStart;
    let additionLineNumber = hunk.additionStart;
    let deletionTokenIndex = hunk.deletionLineIndex;
    let additionTokenIndex = hunk.additionLineIndex;

    hunk.hunkContent.forEach((segment) => {
      if (segment.type === "context") {
        for (let index = 0; index < segment.lines; index += 1) {
          rows.push({
            kind: "line",
            id: `${fileId}:row:${rowIndex++}`,
            change: "context",
            oldLineNumber: deletionLineNumber,
            newLineNumber: additionLineNumber,
            content: stripTrailingNewline(
              file.additionLines[additionTokenIndex] ??
                file.deletionLines[deletionTokenIndex] ??
                "",
            ),
            additionTokenIndex,
            deletionTokenIndex,
            comparison: null,
          });
          deletionLineNumber += 1;
          additionLineNumber += 1;
          deletionTokenIndex += 1;
          additionTokenIndex += 1;
        }
        return;
      }

      const pairedLineCount = Math.min(segment.deletions, segment.additions);
      const deletionTokenIndexStart = deletionTokenIndex;
      const additionTokenIndexStart = additionTokenIndex;

      for (let index = 0; index < segment.deletions; index += 1) {
        rows.push({
          kind: "line",
          id: `${fileId}:row:${rowIndex++}`,
          change: "delete",
          oldLineNumber: deletionLineNumber,
          newLineNumber: null,
          content: stripTrailingNewline(file.deletionLines[deletionTokenIndex] ?? ""),
          additionTokenIndex: null,
          deletionTokenIndex,
          comparison:
            index < pairedLineCount
              ? {
                  change: "add",
                  tokenIndex: additionTokenIndexStart + index,
                }
              : null,
        });
        deletionLineNumber += 1;
        deletionTokenIndex += 1;
      }

      for (let index = 0; index < segment.additions; index += 1) {
        rows.push({
          kind: "line",
          id: `${fileId}:row:${rowIndex++}`,
          change: "add",
          oldLineNumber: null,
          newLineNumber: additionLineNumber,
          content: stripTrailingNewline(file.additionLines[additionTokenIndex] ?? ""),
          additionTokenIndex,
          deletionTokenIndex: null,
          comparison:
            index < pairedLineCount
              ? {
                  change: "delete",
                  tokenIndex: deletionTokenIndexStart + index,
                }
              : null,
        });
        additionLineNumber += 1;
        additionTokenIndex += 1;
      }
    });
  });

  return rows;
}

function completePatchSource(file: FileDiffMetadata, rawPatch: string | null | undefined) {
  if (!rawPatch || (file.type !== "new" && file.type !== "deleted") || file.hunks.length !== 1) {
    return undefined;
  }
  const added = file.type === "new";
  const a = quoteGitPatchPath(`a/${file.name}`);
  const b = quoteGitPatchPath(`b/${file.name}`);
  const lines = rawPatch.split("\n");
  if (lines.pop() !== "" || rawPatch.includes("\0")) return undefined;
  let index = 0;
  if (lines[index++] !== `diff --git ${a} ${b}`) return undefined;
  if (
    !new RegExp(`^${added ? "new" : "deleted"} file mode 100(644|755)$`).test(lines[index++] ?? "")
  ) {
    return undefined;
  }
  if (lines[index]?.startsWith("index ")) {
    if (!/^index [0-9a-f]+\.\.[0-9a-f]+(?: 100(?:644|755))?$/.test(lines[index++] ?? "")) {
      return undefined;
    }
  }
  if (lines[index++] !== `--- ${added ? "/dev/null" : a}`) return undefined;
  if (lines[index++] !== `+++ ${added ? b : "/dev/null"}`) return undefined;
  // Pierre repairs both underfull and overfull hunks. Its resulting counts cannot
  // prove that patch lines cover the whole file; read the original header instead.
  const header = lines[index++] ?? "";
  // GitCafe's structured hunks can start the empty side at 1 instead of git's 0.
  // Its explicit zero count still proves that side contributes no source lines.
  const match = (added ? /^@@ -[01],0 \+1(?:,(\d+))? @@$/ : /^@@ -1(?:,(\d+))? \+[01],0 @@$/).exec(
    header,
  );
  if (!match) return undefined;
  const count = Number(match[1] ?? 1);
  if (!Number.isSafeInteger(count) || count <= 0) return undefined;
  const hunk = file.hunks[0]!;
  if (
    hunk.hunkSpecs !== `${header}\n` ||
    (added ? hunk.additionCount : hunk.deletionCount) !== count ||
    (added ? file.additionLines : file.deletionLines).length !== count ||
    (added ? file.deletionLines : file.additionLines).length !== 0
  )
    return undefined;
  const bodyStart = lines.slice(0, index).reduce((length, line) => length + line.length + 1, 0);
  const prefix = added ? "+" : "-";
  for (let line = 0; line < count; line++) {
    if (!lines[index++]?.startsWith(prefix)) return undefined;
  }
  let bodyEnd = rawPatch.length;
  if (lines[index] === "\\ No newline at end of file") {
    // Only the patch's LF is synthetic, including when the source ends in a bare CR.
    bodyEnd -= "\\ No newline at end of file\n".length + 1;
    index++;
  }
  if (index !== lines.length) return undefined;
  // Keep reconstruction lazy so only requested source enters the bounded source cache.
  return () => {
    const contents = rawPatch.slice(bodyStart + 1, bodyEnd).replace(/\n[+-]/g, "\n");
    return added
      ? { oldContents: "", newContents: contents }
      : { oldContents: contents, newContents: "" };
  };
}

function mapRenderableFile(
  file: FileDiffMetadata,
  id: string,
  rawPatch?: string | null,
): ReviewRenderableFile {
  const path = file.name || file.prevName || "";
  const previousPath = file.prevName || null;
  const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
  const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
  const cacheKey = file.cacheKey ?? `${previousPath ?? "none"}:${path}:${file.type}`;

  return {
    id,
    cacheKey,
    path,
    previousPath,
    changeType: file.type,
    additions,
    deletions,
    languageHint: file.lang ?? null,
    additionLines: file.additionLines,
    deletionLines: file.deletionLines,
    completePatchSource: completePatchSource(file, rawPatch),
    noEOFCRAdditions: file.hunks.some((hunk) => hunk.noEOFCRAdditions),
    noEOFCRDeletions: file.hunks.some((hunk) => hunk.noEOFCRDeletions),
    rows: buildRenderableRows(file, id),
  };
}

export function getReviewSectionIdForCheckpoint(
  checkpoint: Pick<ThreadCheckpointSummary, "checkpointTurnCount">,
): string {
  return `turn:${checkpoint.checkpointTurnCount}`;
}

export function getReadyReviewCheckpoints(
  checkpoints: ReadonlyArray<ThreadCheckpointSummary>,
): ReadonlyArray<ThreadCheckpointSummary> {
  return pipe(
    checkpoints,
    Arr.filter((checkpoint) => checkpoint.status === "ready"),
    Arr.sort(readyCheckpointOrder),
  );
}

export function reviewTurnDiffsBySectionId(
  checkpoints: ReadonlyArray<Pick<ThreadCheckpointSummary, "checkpointTurnCount">>,
  diffByTurnCount: Readonly<Record<number, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    checkpoints.map((checkpoint) => [
      getReviewSectionIdForCheckpoint(checkpoint),
      diffByTurnCount[checkpoint.checkpointTurnCount],
    ]),
  );
}

export function buildReviewSectionItems(input: {
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
  readonly gitSections: ReadonlyArray<ReviewDiffPreviewSource>;
  readonly turnDiffById: Readonly<Record<string, string | undefined>>;
  readonly loadingGitSections: boolean;
}): ReadonlyArray<ReviewSectionItem> {
  const turnItems = getReadyReviewCheckpoints(input.checkpoints).map<ReviewSectionItem>(
    (checkpoint) => {
      const id = getReviewSectionIdForCheckpoint(checkpoint);
      return {
        id,
        kind: "turn",
        title: checkpointTitle(checkpoint),
        subtitle: checkpointSubtitle(checkpoint),
        diff: input.turnDiffById[id] ?? null,
        isLoading: false,
      };
    },
  );

  const gitItems = input.gitSections
    .filter(
      (section): section is typeof section & { kind: ReviewSectionKind } =>
        section.kind !== "commit",
    )
    .map<ReviewSectionItem>((section) => ({
      id: `git:${section.kind}`,
      kind: section.kind,
      title: section.title,
      subtitle: gitSubtitle(section),
      diff: section.diff,
      source: section,
      ...(section.files ? { files: section.files } : {}),
      truncated: section.truncated,
      isLoading: false,
    }));
  const hasChangesItem = gitItems.some((item) => item.id === CHANGES_SECTION_ID);
  const visibleGitItems =
    input.loadingGitSections && !hasChangesItem
      ? [
          {
            id: CHANGES_SECTION_ID,
            kind: "branch-range",
            title: CHANGES_TITLE,
            subtitle: null,
            diff: null,
            isLoading: true,
          } satisfies ReviewSectionItem,
          ...gitItems,
        ]
      : gitItems;

  return [...turnItems, ...visibleGitItems];
}

export function getDefaultReviewSectionId(
  sections: ReadonlyArray<ReviewSectionItem>,
): string | null {
  return (sections.find((section) => section.id === CHANGES_SECTION_ID) ?? sections[0])?.id ?? null;
}

/**
 * The store holds only the user's pick. While that section is missing (still loading, or the
 * working tree went clean) the default shows, and the pick returns once the section does: the
 * thread-feed entry relies on this, as it selects a section before the sections have loaded.
 */
export function resolveReviewSelectedSectionId(
  sections: ReadonlyArray<ReviewSectionItem>,
  storedSectionId: string | null,
): string | null {
  return storedSectionId !== null && sections.some((section) => section.id === storedSectionId)
    ? storedSectionId
    : getDefaultReviewSectionId(sections);
}

export function buildReviewParsedDiff(
  diff: string | null | undefined,
  cacheScope: string,
): ReviewParsedDiff {
  if (!diff?.trim()) {
    return { kind: "empty" };
  }

  const { text, truncated } = splitTruncationMarker(diff);
  if (text.length === 0) {
    return { kind: "empty" };
  }

  const notice = truncated
    ? "Diff output hit the server size cap. Showing the available excerpt."
    : null;

  try {
    const cacheKey = buildPatchCacheKey(text, cacheScope);
    const patchId = getReviewPatchId(cacheKey);
    const parsedPatches = runDiffParserSilently(() => parsePatchFiles(text, cacheKey));
    const rawFiles = new Map<string, string | null>();
    if (!truncated) {
      for (const rawFile of text.split(/(?=^diff --git )/m)) {
        const header = rawFile.slice(0, rawFile.indexOf("\n"));
        rawFiles.set(header, rawFiles.has(header) ? null : rawFile);
      }
    }
    const files = pipe(
      parsedPatches,
      Arr.flatMap((patch) => patch.files),
      Arr.map((file, index) =>
        mapRenderableFile(
          file,
          `${patchId}:f${index.toString(36)}`,
          rawFiles.get(
            `diff --git ${quoteGitPatchPath(`a/${file.name}`)} ${quoteGitPatchPath(`b/${file.name}`)}`,
          ),
        ),
      ),
    );

    if (files.length === 0) {
      return {
        kind: "raw",
        text,
        reason: truncated
          ? "Diff was truncated before it could be parsed completely. Showing the raw excerpt."
          : "Unsupported diff format. Showing raw patch.",
        notice,
      };
    }

    return {
      kind: "files",
      files,
      fileCount: files.length,
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      notice,
    };
  } catch {
    return {
      kind: "raw",
      text,
      reason: truncated
        ? "Diff was truncated before it could be parsed completely. Showing the raw excerpt."
        : "Failed to parse patch. Showing raw patch.",
      notice,
    };
  }
}

export function applyReviewDiffMetadata(
  previewDiff: ReviewParsedDiff,
  selectedSection: Pick<ReviewSectionItem, "files" | "truncated"> | null,
): ReviewParsedDiff {
  if (previewDiff.kind === "empty") return previewDiff;
  const notice = selectedSection?.truncated
    ? `This preview exceeds the size limit. Changes shown are incomplete.${selectedSection.files ? " Counts include all changes." : ""}`
    : previewDiff.notice;
  if (previewDiff.kind !== "files" || !selectedSection?.files) return { ...previewDiff, notice };
  const totals = selectedSection.files.reduce(
    (total, file) => ({
      additions: total.additions + file.additions,
      deletions: total.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
  const stats = new Map(selectedSection.files.map((file) => [file.path, file]));
  const files = previewDiff.files.map((file) => {
    const stat = stats.get(file.path);
    return stat ? { ...file, additions: stat.additions, deletions: stat.deletions } : file;
  });
  return { ...previewDiff, ...totals, files, fileCount: selectedSection.files.length, notice };
}
