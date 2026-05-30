import type { ChangeTypes, FileDiffMetadata } from "@pierre/diffs/types";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { OrchestrationCheckpointSummary, ReviewDiffPreviewSource } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";

export type ReviewSectionKind = "turn" | "working-tree" | "branch-range";

const DIRTY_WORKTREE_SECTION_ID = "git:working-tree";
const DIRTY_WORKTREE_TITLE = "Dirty worktree";
const DIRTY_WORKTREE_SUBTITLE = "Tracked, staged, and untracked worktree changes";

export interface ReviewSectionItem {
  readonly id: string;
  readonly kind: ReviewSectionKind;
  readonly title: string;
  readonly subtitle: string | null;
  readonly diff: string | null;
  readonly isLoading: boolean;
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
  readonly path: string;
  readonly previousPath: string | null;
  readonly changeType: ChangeTypes;
  readonly additions: number;
  readonly deletions: number;
  readonly languageHint: string | null;
  readonly additionLines: ReadonlyArray<string>;
  readonly deletionLines: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReviewRenderableRow>;
}

export interface ReviewFileHeaderListItem {
  readonly kind: "file-header";
  readonly id: string;
  readonly fileId: string;
  readonly file: ReviewRenderableFile;
  readonly expanded: boolean;
}

export interface ReviewFileSuppressedListItem {
  readonly kind: "file-suppressed";
  readonly id: string;
  readonly fileId: string;
  readonly message: string;
  readonly actionLabel: string | null;
}

export interface ReviewHunkListItem {
  readonly kind: "hunk";
  readonly id: string;
  readonly fileId: string;
  readonly file: ReviewRenderableFile;
  readonly row: ReviewRenderableHunkRow;
}

export interface ReviewLineListItem {
  readonly kind: "line";
  readonly id: string;
  readonly fileId: string;
  readonly file: ReviewRenderableFile;
  readonly row: ReviewRenderableLineRow;
  readonly lineIndex: number;
}

export type ReviewListItem =
  | ReviewFileHeaderListItem
  | ReviewFileSuppressedListItem
  | ReviewHunkListItem
  | ReviewLineListItem;

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

function checkpointTitle(checkpoint: OrchestrationCheckpointSummary): string {
  return `Turn ${checkpoint.checkpointTurnCount}`;
}

function checkpointSubtitle(checkpoint: OrchestrationCheckpointSummary): string {
  const fileCount = checkpoint.files.length;
  if (checkpoint.status !== "ready") {
    return `Diff ${checkpoint.status}`;
  }
  return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
}

function compareCheckpointTurnCountDescending(
  left: OrchestrationCheckpointSummary,
  right: OrchestrationCheckpointSummary,
): -1 | 0 | 1 {
  if (left.checkpointTurnCount === right.checkpointTurnCount) {
    return 0;
  }

  return left.checkpointTurnCount > right.checkpointTurnCount ? -1 : 1;
}

const readyCheckpointOrder = Order.make<OrchestrationCheckpointSummary>(
  compareCheckpointTurnCountDescending,
);

function gitSubtitle(section: ReviewDiffPreviewSource): string | null {
  if (section.kind === "working-tree") {
    return DIRTY_WORKTREE_SUBTITLE;
  }
  if (section.baseRef) {
    return `${section.baseRef} ... ${section.headRef ?? "HEAD"}`;
  }
  return "Base branch unavailable";
}

function stripGitPrefix(pathValue: string | undefined): string | null {
  if (!pathValue) {
    return null;
  }
  if (pathValue.startsWith("a/") || pathValue.startsWith("b/")) {
    return pathValue.slice(2);
  }
  return pathValue;
}

function stripTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function splitTruncationMarker(diff: string): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const trimmed = diff.trimEnd();
  if (!trimmed.endsWith("[truncated]")) {
    return { text: trimmed, truncated: false };
  }

  return {
    text: trimmed.replace(/\n*\[truncated\]\s*$/, "").trimEnd(),
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
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
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

// The flattened review list item model is inspired by pierre/diffs' iterator-first
// virtualization architecture, adapted here for React Native virtualization.
// Original project: https://github.com/pingdotgg/pierre/tree/main/packages/diffs
// Reference files:
// - src/utils/iterateOverDiff.ts
// - src/components/VirtualizedFileDiff.ts
export function buildReviewListItems(input: {
  readonly files: ReadonlyArray<ReviewRenderableFile>;
  readonly expandedFileIds: ReadonlyArray<string>;
  readonly revealedLargeFileIds: ReadonlyArray<string>;
}): ReadonlyArray<ReviewListItem> {
  const expandedFileIds = new Set(input.expandedFileIds);
  const revealedLargeFileIds = new Set(input.revealedLargeFileIds);
  const items: ReviewListItem[] = [];

  input.files.forEach((file) => {
    const expanded = expandedFileIds.has(file.id);
    items.push({
      kind: "file-header",
      id: `${file.id}:header`,
      fileId: file.id,
      file,
      expanded,
    });

    if (!expanded) {
      return;
    }

    const previewState = getReviewFilePreviewState(file);
    if (previewState.kind === "suppressed") {
      if (previewState.reason !== "large" || !revealedLargeFileIds.has(file.id)) {
        items.push({
          kind: "file-suppressed",
          id: `${file.id}:suppressed`,
          fileId: file.id,
          message: previewState.message,
          actionLabel: previewState.actionLabel,
        });
        return;
      }
    }

    let lineIndex = 0;
    file.rows.forEach((row, rowIndex) => {
      if (row.kind === "hunk") {
        items.push({
          kind: "hunk",
          id: `${file.id}:row:${rowIndex}:${row.id}`,
          fileId: file.id,
          file,
          row,
        });
        return;
      }

      items.push({
        kind: "line",
        id: `${file.id}:row:${rowIndex}:${row.id}`,
        fileId: file.id,
        file,
        row,
        lineIndex,
      });
      lineIndex += 1;
    });
  });

  return items;
}

function fallbackHunkHeader(hunk: FileDiffMetadata["hunks"][number]): string {
  return `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`;
}

function buildRenderableRows(file: FileDiffMetadata): ReadonlyArray<ReviewRenderableRow> {
  const rows: ReviewRenderableRow[] = [];
  let rowIndex = 0;

  file.hunks.forEach((hunk, hunkIndex) => {
    rows.push({
      kind: "hunk",
      id: `${file.cacheKey ?? file.name}:hunk:${hunkIndex}`,
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
            id: `${file.cacheKey ?? file.name}:row:${rowIndex++}`,
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
          id: `${file.cacheKey ?? file.name}:row:${rowIndex++}`,
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
          id: `${file.cacheKey ?? file.name}:row:${rowIndex++}`,
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

function mapRenderableFile(file: FileDiffMetadata): ReviewRenderableFile {
  const path = stripGitPrefix(file.name) ?? stripGitPrefix(file.prevName) ?? file.name;
  const previousPath = stripGitPrefix(file.prevName);
  const additions = file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0);
  const deletions = file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0);
  const cacheKey = file.cacheKey ?? `${previousPath ?? "none"}:${path}:${file.type}`;

  return {
    id: cacheKey,
    cacheKey,
    path,
    previousPath,
    changeType: file.type,
    additions,
    deletions,
    languageHint: file.lang ?? null,
    additionLines: file.additionLines,
    deletionLines: file.deletionLines,
    rows: buildRenderableRows(file),
  };
}

export function getReviewSectionIdForCheckpoint(
  checkpoint: Pick<OrchestrationCheckpointSummary, "checkpointTurnCount">,
): string {
  return `turn:${checkpoint.checkpointTurnCount}`;
}

export function getReadyReviewCheckpoints(
  checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>,
): ReadonlyArray<OrchestrationCheckpointSummary> {
  return pipe(
    checkpoints,
    Arr.filter((checkpoint) => checkpoint.status === "ready"),
    Arr.sort(readyCheckpointOrder),
  );
}

export function buildReviewSectionItems(input: {
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly gitSections: ReadonlyArray<ReviewDiffPreviewSource>;
  readonly turnDiffById: Readonly<Record<string, string | undefined>>;
  readonly loadingTurnIds: Readonly<Record<string, boolean | undefined>>;
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
        isLoading: input.loadingTurnIds[id] === true,
      };
    },
  );

  const gitItems = input.gitSections.map<ReviewSectionItem>((section) => ({
    id: `git:${section.kind}`,
    kind: section.kind,
    title: section.title,
    subtitle: gitSubtitle(section),
    diff: section.diff,
    isLoading: false,
  }));
  const hasDirtyWorktreeItem = gitItems.some((item) => item.id === DIRTY_WORKTREE_SECTION_ID);
  const visibleGitItems =
    input.loadingGitSections && !hasDirtyWorktreeItem
      ? [
          {
            id: DIRTY_WORKTREE_SECTION_ID,
            kind: "working-tree",
            title: DIRTY_WORKTREE_TITLE,
            subtitle: DIRTY_WORKTREE_SUBTITLE,
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
  return sections[0]?.id ?? null;
}

export function buildReviewParsedDiff(
  diff: string | null | undefined,
  cacheScope: string,
): ReviewParsedDiff {
  const normalized = diff?.trim();
  if (!normalized) {
    return { kind: "empty" };
  }

  const { text, truncated } = splitTruncationMarker(normalized);
  if (text.length === 0) {
    return { kind: "empty" };
  }

  const notice = truncated
    ? "Diff output hit the server size cap. Showing the available excerpt."
    : null;

  try {
    const parsedPatches = runDiffParserSilently(() =>
      parsePatchFiles(text, buildPatchCacheKey(text, cacheScope)),
    );
    const files = pipe(
      parsedPatches,
      Arr.flatMap((patch) => patch.files),
      Arr.map(mapRenderableFile),
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
