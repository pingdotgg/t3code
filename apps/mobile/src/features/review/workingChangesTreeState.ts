import { orderReviewFiles } from "@t3tools/client-runtime/review-workspace";
import type { ReviewRenderableFile } from "./reviewModel";
import type { WorkingScope } from "./WorkingChangesTree";

export type WorkingChangesTreeState = {
  readonly staged: ReadonlyArray<ReviewRenderableFile>;
  readonly unstaged: ReadonlyArray<ReviewRenderableFile>;
};

/** Whole-file mutations move tree entries immediately; refreshed Git previews supply the final diff. */
export function applyWorkingChangesTreeMutation(
  current: WorkingChangesTreeState,
  mutation: {
    readonly scope: WorkingScope;
    readonly paths: ReadonlyArray<string>;
    readonly revert?: boolean;
  },
): WorkingChangesTreeState {
  const paths = new Set(mutation.paths);
  const from = current[mutation.scope];
  const moved = from.filter(
    (file) => paths.has(file.path) || (file.previousPath !== null && paths.has(file.previousPath)),
  );
  const movedFiles = new Set(moved);
  const remaining = from.filter((file) => !movedFiles.has(file));
  if (mutation.revert) return { ...current, [mutation.scope]: remaining };
  const destination = mutation.scope === "staged" ? "unstaged" : "staged";
  const destinationPaths = new Set(current[destination].map((file) => file.path));
  return {
    ...current,
    [mutation.scope]: remaining,
    [destination]: orderReviewFiles(
      [...current[destination], ...moved.filter((file) => !destinationPaths.has(file.path))],
      (file) => file.path,
    ),
  };
}
