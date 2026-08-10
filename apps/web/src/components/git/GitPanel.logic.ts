/**
 * Pure derivations for the Git panel.
 *
 * Everything here turns a `VcsStatusResult` plus local UI state into what the
 * panel renders. Kept free of React so the partitioning and button-state rules
 * can be tested directly.
 */
import type { VcsCommit, VcsStatusResult, VcsWorkingTreeFile } from "@t3tools/contracts";

export interface GitPanelSections {
  /** Files with something in the index. */
  readonly staged: ReadonlyArray<VcsWorkingTreeFile>;
  /** Files whose working copy differs from the index, including untracked. */
  readonly unstaged: ReadonlyArray<VcsWorkingTreeFile>;
  /** Unmerged files. They cannot be committed until resolved. */
  readonly conflicted: ReadonlyArray<VcsWorkingTreeFile>;
}

/**
 * Split the working tree into the panel's three sections.
 *
 * A partially staged file — edited, staged, then edited again — belongs in
 * both `staged` and `unstaged`, because both halves are real and independently
 * actionable. Conflicts are pulled out entirely: showing them as ordinary
 * staged changes would invite committing a half-merged file.
 */
export function partitionWorkingTree(files: ReadonlyArray<VcsWorkingTreeFile>): GitPanelSections {
  const staged: VcsWorkingTreeFile[] = [];
  const unstaged: VcsWorkingTreeFile[] = [];
  const conflicted: VcsWorkingTreeFile[] = [];

  for (const file of files) {
    if (file.indexStatus === "conflicted" || file.worktreeStatus === "conflicted") {
      conflicted.push(file);
      continue;
    }
    if (file.indexStatus !== null) staged.push(file);
    if (file.worktreeStatus !== null) unstaged.push(file);
  }

  return { staged, unstaged, conflicted };
}

export interface GitPanelCommitState {
  readonly label: string;
  readonly disabled: boolean;
  /** Why the button is disabled, for the tooltip. Null when enabled. */
  readonly disabledReason: string | null;
}

/**
 * Resolve the primary commit button.
 *
 * The panel commits the index and nothing else, so "nothing staged" is a
 * disabled state rather than an implicit stage-everything.
 */
export function resolveCommitState(input: {
  readonly sections: GitPanelSections;
  readonly isBusy: boolean;
  readonly isRepo: boolean;
}): GitPanelCommitState {
  const label = "Commit Staged";
  if (!input.isRepo) {
    return { label, disabled: true, disabledReason: "This folder is not a Git repository." };
  }
  if (input.isBusy) {
    return { label, disabled: true, disabledReason: "Another Git action is running." };
  }
  if (input.sections.conflicted.length > 0) {
    return { label, disabled: true, disabledReason: "Resolve merge conflicts first." };
  }
  if (input.sections.staged.length === 0) {
    return { label, disabled: true, disabledReason: "Stage a file to commit." };
  }
  return { label, disabled: false, disabledReason: null };
}

/** Summed `+`/`-` for one section, for the counts beside each heading. */
export function summarizeSection(files: ReadonlyArray<VcsWorkingTreeFile>): {
  readonly insertions: number;
  readonly deletions: number;
} {
  let insertions = 0;
  let deletions = 0;
  for (const file of files) {
    insertions += file.insertions;
    deletions += file.deletions;
  }
  return { insertions, deletions };
}

/** Single-letter badge for a file row, matching git's own status letters. */
export function fileStatusLetter(file: VcsWorkingTreeFile, section: "staged" | "unstaged"): string {
  const status = section === "staged" ? file.indexStatus : file.worktreeStatus;
  switch (status) {
    case "added":
      return "A";
    case "modified":
      return "M";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "U";
    case "conflicted":
      return "!";
    case null:
      return "";
  }
}

/**
 * How a file row reads when it is a rename: `old → new`, but only the parts
 * that differ, so a file moved between directories does not print its whole
 * path twice.
 */
export function renameLabel(file: VcsWorkingTreeFile): string | null {
  if (!file.originalPath) return null;
  return `${file.originalPath} → ${file.path}`;
}

/**
 * Ref pills for a commit row, ordered so the local branch reads first.
 *
 * Remote-tracking refs keep their `remote/` prefix; tags keep `tag: `. The
 * ordering is stable so the list does not reshuffle between pages.
 */
export function orderCommitRefNames(refNames: ReadonlyArray<string>): ReadonlyArray<string> {
  const local: string[] = [];
  const remote: string[] = [];
  const other: string[] = [];
  for (const name of refNames) {
    if (name.startsWith("tag: ")) other.push(name);
    else if (name.includes("/")) remote.push(name);
    else local.push(name);
  }
  return [...local, ...remote, ...other];
}

/**
 * Flatten paged commit results into one list, dropping duplicates.
 *
 * Pages are offset-based, so a commit landing mid-scroll can shift rows and
 * repeat a sha across pages. Deduping by sha keeps React keys unique.
 */
export function mergeCommitPages(
  pages: ReadonlyArray<ReadonlyArray<VcsCommit>>,
): ReadonlyArray<VcsCommit> {
  const seen = new Set<string>();
  const merged: VcsCommit[] = [];
  for (const page of pages) {
    for (const commit of page) {
      if (seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      merged.push(commit);
    }
  }
  return merged;
}

/**
 * The upstream summary line: `↑2 ↓1`, or a plain description when the branch
 * has no upstream at all.
 */
export function describeUpstream(status: VcsStatusResult | null): {
  readonly ahead: number;
  readonly behind: number;
  readonly hasUpstream: boolean;
} {
  return {
    ahead: status?.aheadCount ?? 0,
    behind: status?.behindCount ?? 0,
    hasUpstream: status?.hasUpstream ?? false,
  };
}
