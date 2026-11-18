import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import type { FileDiffMetadata } from "@pierre/diffs/types";
import { parseReviewDiffFromFiles } from "@t3tools/client-runtime/review-diff-metadata";
import type {
  WorkingChangesSnapshot,
  WorkingChangesState,
} from "@t3tools/client-runtime/review-working-changes-state";
import { reviewDiffEdits } from "@t3tools/client-runtime/review-diff-context";
import { mapRenderableFile, type ReviewRenderableFile } from "./reviewModel.ts";

/** Native and desktop readers project the same patch model instead of separate staging arithmetic. */
export function nativeWorkingChangesSnapshot(
  files: ReadonlyArray<ReviewRenderableFile>,
  hunks: ReadonlyMap<string, ReadonlyArray<string>>,
): WorkingChangesSnapshot {
  return {
    files: files.map((file) => {
      const patches = hunks.get(file.path) ?? [];
      const header = patches[0]?.split(/(?=^@@ )/m)[0];
      const patch = header
        ? header + patches.map((part) => part.slice(part.indexOf("@@ "))).join("")
        : "";
      const parsed = patch ? parsePatchFiles(patch)[0]?.files[0] : undefined;
      if (parsed) return { ...parsed, cacheKey: file.path };
      return {
        ...parseReviewDiffFromFiles(
          { name: file.path, contents: "" },
          { name: file.path, contents: "" },
        ),
        type: file.changeType,
        ...(file.previousPath ? { prevName: file.previousPath } : {}),
        cacheKey: `${file.path}:pending`,
      };
    }),
    hunksByPath: hunks,
  };
}

/** Keep cleared regions, and reuse context after Git confirms identical edits. */
export function nativeWorkingReaderFiles(
  actual: WorkingChangesSnapshot,
  retained: WorkingChangesSnapshot | null,
): ReadonlyArray<FileDiffMetadata> {
  if (!retained) return actual.files;
  const previous = new Map(
    [...retained.files, ...(retained.retainedFiles ?? [])].map((file) => [file.name, file]),
  );
  const next = actual.files.map((file) => {
    const remembered = previous.get(file.name);
    return remembered &&
      (file.cacheKey?.endsWith(":pending") || reviewDiffEdits(file) === reviewDiffEdits(remembered))
      ? remembered
      : file;
  });
  for (const file of retained.retainedFiles ?? []) {
    if (
      reviewDiffEdits(file) === "[]" &&
      !actual.files.some((candidate) => candidate.name === file.name)
    )
      next.push(file);
  }
  return next;
}

export function nativeWorkingRenderableFile(
  file: FileDiffMetadata,
  original?: ReviewRenderableFile,
): ReviewRenderableFile {
  if (file.cacheKey?.endsWith(":pending") && original) return { ...original, id: file.name };
  return { ...mapRenderableFile(file), id: file.name, cacheKey: file.name };
}

/** The next staging batch starts from the regions retained through the last confirmation. */
export function nativeWorkingChangesStateForMutation(
  current: WorkingChangesState,
  previous: WorkingChangesState | null,
): WorkingChangesState {
  const retain = (scope: "staged" | "unstaged") => ({
    ...current[scope],
    files: nativeWorkingReaderFiles(current[scope], previous?.[scope] ?? null).filter((file) =>
      current[scope].files.some((actual) => actual.name === file.name),
    ),
    ...(previous?.[scope].retainedFiles ? { retainedFiles: previous[scope].retainedFiles } : {}),
  });
  return { staged: retain("staged"), unstaged: retain("unstaged") };
}
