import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PullRequestDiffFileContentsInput,
  PullRequestDiffFileContentsResult,
  PullRequestRef,
  ReviewDiffFileContentsInput,
  ReviewDiffFileContentsResult,
  ReviewDiffPreviewSourceKind,
} from "@t3tools/contracts";

import { resolveFileDiffPath } from "./diffRendering";

interface GitDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly sourceKind: ReviewDiffPreviewSourceKind;
  readonly baseRef: string | null;
  readonly headRef: string | null;
  readonly cacheKey: string;
}

interface PullRequestDiffFileContentsSource {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly commit: string | null;
  readonly cacheKey: string;
}

type GetDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: ReviewDiffFileContentsInput;
}) => Promise<AtomCommandResult<ReviewDiffFileContentsResult, E>>;

type GetPullRequestDiffFileContents<E> = (request: {
  readonly environmentId: EnvironmentId;
  readonly input: PullRequestDiffFileContentsInput;
}) => Promise<AtomCommandResult<PullRequestDiffFileContentsResult, E>>;

// Mirrors Pierre's splitFileContents so line counts match its hydration.
function splitLines(contents: string): ReadonlyArray<string> {
  return contents === "" ? [] : contents.split(/(?<=\n)/);
}

// Whitespace-insensitive: `git diff -w` prints context lines from only one side.
function sameLine(patchLine: string | undefined, fileLine: string | undefined): boolean {
  return (
    patchLine !== undefined &&
    fileLine !== undefined &&
    patchLine.replace(/\s/g, "") === fileLine.replace(/\s/g, "")
  );
}

function hunkSideEnd(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1) + count;
}

function hunkSideMatches(
  patchLines: ReadonlyArray<string>,
  patchIndex: number,
  fileLines: ReadonlyArray<string>,
  fileIndex: number,
  count: number,
): boolean {
  for (let offset = 0; offset < count; offset++) {
    if (!sameLine(patchLines[patchIndex + offset], fileLines[fileIndex + offset])) return false;
  }
  return true;
}

function unchangedRangeMatches(
  oldLines: ReadonlyArray<string>,
  oldStart: number,
  oldEnd: number,
  newLines: ReadonlyArray<string>,
  newStart: number,
  newEnd: number,
): boolean {
  if (oldEnd - oldStart !== newEnd - newStart) return false;
  return hunkSideMatches(oldLines, oldStart, newLines, newStart, oldEnd - oldStart);
}

// Pierre hydrates a partial patch by trusting its hunk positions and shows the lines
// around hunks as unchanged context, so both must still hold for the loaded contents.
function reproducesPatch(fileDiff: FileDiffMetadata, oldContents: string, newContents: string) {
  if (fileDiff.hunks.length === 0) return true;
  const oldLines = splitLines(oldContents);
  const newLines = splitLines(newContents);
  let oldIndex = 0;
  let newIndex = 0;
  for (const hunk of fileDiff.hunks) {
    const oldEnd = hunkSideEnd(hunk.deletionStart, hunk.deletionCount);
    const newEnd = hunkSideEnd(hunk.additionStart, hunk.additionCount);
    const oldStart = oldEnd - hunk.deletionCount;
    const newStart = newEnd - hunk.additionCount;
    if (
      !unchangedRangeMatches(oldLines, oldIndex, oldStart, newLines, newIndex, newStart) ||
      !hunkSideMatches(
        fileDiff.deletionLines,
        hunk.deletionLineIndex,
        oldLines,
        oldStart,
        hunk.deletionCount,
      ) ||
      !hunkSideMatches(
        fileDiff.additionLines,
        hunk.additionLineIndex,
        newLines,
        newStart,
        hunk.additionCount,
      )
    ) {
      return false;
    }
    oldIndex = oldEnd;
    newIndex = newEnd;
  }
  return unchangedRangeMatches(
    oldLines,
    oldIndex,
    oldLines.length,
    newLines,
    newIndex,
    newLines.length,
  );
}

function createDiffFileContentsLoader(
  load: (input: {
    readonly changeType: PullRequestDiffFileContentsInput["changeType"];
    readonly oldPath: string;
    readonly newPath: string;
  }) => Promise<{ readonly oldContents: string; readonly newContents: string }>,
  cacheKey: string,
): FileDiffContentsLoader {
  return async (fileDiff) => {
    const newPath = resolveFileDiffPath(fileDiff);
    const oldPath = fileDiff.prevName
      ? resolveFileDiffPath({ ...fileDiff, name: fileDiff.prevName })
      : newPath;
    const contents = await load({ changeType: fileDiff.type, oldPath, newPath });
    const newFile = {
      name: newPath,
      contents: contents.newContents,
      cacheKey: `${cacheKey}:new:${newPath}`,
    };
    if (fileDiff.type === "rename-pure") {
      return { oldFile: null, newFile };
    }
    if (!reproducesPatch(fileDiff, contents.oldContents, contents.newContents)) {
      throw new Error(
        "This file changed since the diff was loaded. Refresh the diff to expand it.",
      );
    }
    return {
      oldFile: {
        name: oldPath,
        contents: contents.oldContents,
        cacheKey: `${cacheKey}:old:${oldPath}`,
      },
      newFile,
    };
  };
}

export function createGitDiffFileContentsLoader<E>(
  getDiffFileContents: GetDiffFileContents<E>,
  source: GitDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        cwd: source.cwd,
        sourceKind: source.sourceKind,
        changeType,
        baseRef: source.baseRef,
        headRef: source.headRef,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}

export function createPullRequestDiffFileContentsLoader<E>(
  getDiffFileContents: GetPullRequestDiffFileContents<E>,
  source: PullRequestDiffFileContentsSource,
): FileDiffContentsLoader {
  return createDiffFileContentsLoader(async ({ changeType, oldPath, newPath }) => {
    const result = await getDiffFileContents({
      environmentId: source.environmentId,
      input: {
        ...source.reference,
        ...(source.commit === null ? {} : { commit: source.commit }),
        changeType,
        oldPath,
        newPath,
      },
    });
    if (result._tag !== "Success") {
      throw squashAtomCommandFailure(result);
    }
    return result.value;
  }, source.cacheKey);
}
