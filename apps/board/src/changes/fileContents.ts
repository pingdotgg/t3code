import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ReviewDiffPreviewSource } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { failureText } from "../settings/failureText";
import { reviewEnvironment } from "../state/changes";

// Mirrors Pierre's splitFileContents so line counts match its hydration.
const splitLines = (contents: string): ReadonlyArray<string> =>
  contents === "" ? [] : contents.split(/(?<=\n)/);

// Whitespace-insensitive: `git diff -w` prints context lines from only one side.
const sameLine = (patchLine: string | undefined, fileLine: string | undefined) =>
  patchLine !== undefined &&
  fileLine !== undefined &&
  patchLine.replace(/\s/g, "") === fileLine.replace(/\s/g, "");

const hunkSideEnd = (start: number, count: number) => start - (count === 0 ? 0 : 1) + count;

function sideMatches(
  patchLines: ReadonlyArray<string>,
  patchIndex: number,
  fileLines: ReadonlyArray<string>,
  start: number,
  count: number,
): boolean {
  const fileIndex = hunkSideEnd(start, count) - count;
  for (let offset = 0; offset < count; offset++) {
    if (!sameLine(patchLines[patchIndex + offset], fileLines[fileIndex + offset])) return false;
  }
  return true;
}

// Pierre hydrates a partial patch by trusting its hunk positions, so contents that changed since
// the patch was computed would render corrupt hunks or throw.
function reproducesPatch(file: FileDiffMetadata, oldContents: string, newContents: string) {
  const last = file.hunks.at(-1);
  if (last === undefined) return true;
  const oldLines = splitLines(oldContents);
  const newLines = splitLines(newContents);
  return (
    file.hunks.every(
      (hunk) =>
        sideMatches(
          file.deletionLines,
          hunk.deletionLineIndex,
          oldLines,
          hunk.deletionStart,
          hunk.deletionCount,
        ) &&
        sideMatches(
          file.additionLines,
          hunk.additionLineIndex,
          newLines,
          hunk.additionStart,
          hunk.additionCount,
        ),
    ) &&
    oldLines.length - hunkSideEnd(last.deletionStart, last.deletionCount) ===
      newLines.length - hunkSideEnd(last.additionStart, last.additionCount)
  );
}

/** Reads a changed file whole through T3, so the unchanged lines between and around its hunks can expand. */
export function diffContentsLoader(
  registry: AtomRegistry.AtomRegistry,
  target: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly source: ReviewDiffPreviewSource;
  },
): FileDiffContentsLoader {
  const { environmentId, cwd, source } = target;
  return async (file) => {
    const newPath = file.name;
    const oldPath = file.prevName ?? newPath;
    const result = await runAtomCommand(
      registry,
      reviewEnvironment.diffFileContents,
      {
        environmentId,
        input: {
          cwd,
          sourceKind: source.kind,
          changeType: file.type,
          baseRef: source.baseRef,
          headRef: source.headRef,
          oldPath,
          newPath,
        },
      },
      { reportFailure: false },
    );
    if (result._tag !== "Success") throw new Error(failureText(result));
    const { oldContents, newContents } = result.value;
    const newFile = {
      name: newPath,
      contents: newContents,
      cacheKey: `${source.diffHash}:new:${newPath}`,
    };
    if (file.type === "rename-pure") return { oldFile: null, newFile };
    if (!reproducesPatch(file, oldContents, newContents)) {
      throw new Error(
        "This file changed since the diff was loaded. Refresh the diff to expand it.",
      );
    }
    return {
      oldFile: {
        name: oldPath,
        contents: oldContents,
        cacheKey: `${source.diffHash}:old:${oldPath}`,
      },
      newFile,
    };
  };
}
