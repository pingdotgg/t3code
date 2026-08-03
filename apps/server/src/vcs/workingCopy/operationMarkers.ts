/**
 * fork: f4 — pure git-dir marker classification.
 *
 * `operationInProgress` is derived from the presence of entries in the git
 * dir, not from parsing any command output. This is what lets the panel say
 * "you are mid-rebase" without asking git anything extra.
 */
import type { WorkingCopyOperation } from "@t3tools/contracts";

/**
 * The git-dir entry names worth reading, most specific first. Order matters:
 * an interactive rebase that stops on a conflicted pick leaves both
 * `rebase-merge` and (for some git versions) a cherry-pick-shaped head, and
 * "rebase" is the answer the user needs.
 */
export const WORKING_COPY_OPERATION_MARKERS: ReadonlyArray<
  readonly [entry: string, operation: WorkingCopyOperation]
> = [
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

export function isOperationMarkerEntry(entry: string): boolean {
  return WORKING_COPY_OPERATION_MARKERS.some(([name]) => name === entry);
}

/**
 * Map the git dir's top-level entry names onto the operation in progress.
 * Unknown entries answer `null`, never a guess.
 */
export function operationFromGitDirEntries(
  entries: ReadonlyArray<string>,
): WorkingCopyOperation | null {
  const present = new Set(entries);
  for (const [entry, operation] of WORKING_COPY_OPERATION_MARKERS) {
    if (present.has(entry)) {
      return operation;
    }
  }
  return null;
}
