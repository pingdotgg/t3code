import { parsePatchFiles, type ChangeTypes, type FileDiffMetadata } from "@pierre/diffs/utils";
import type { GitReviewDiffSection, OrchestrationCheckpointSummary } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export type ReviewSectionKind = "turn" | "dirty" | "base";

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

function gitSubtitle(section: GitReviewDiffSection): string | null {
  if (section.kind === "dirty") {
    return "Tracked, staged, and untracked worktree changes";
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
          });
          deletionLineNumber += 1;
          additionLineNumber += 1;
          deletionTokenIndex += 1;
          additionTokenIndex += 1;
        }
        return;
      }

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
  return Arr.sort(
    checkpoints.filter((checkpoint) => checkpoint.status === "ready"),
    readyCheckpointOrder,
  );
}

export function buildReviewSectionItems(input: {
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly gitSections: ReadonlyArray<GitReviewDiffSection>;
  readonly turnDiffById: Readonly<Record<string, string | undefined>>;
  readonly loadingTurnIds: Readonly<Record<string, boolean | undefined>>;
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

  return [...turnItems, ...gitItems];
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
    const files = parsedPatches.flatMap((patch) => patch.files).map(mapRenderableFile);

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
