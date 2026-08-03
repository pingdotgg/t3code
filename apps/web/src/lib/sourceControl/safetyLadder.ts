/**
 * ONE safety ladder for the source-control panel.
 *
 * The rule is that friction must be proportional to how hard something is to
 * undo, and that MAKING an action undoable always beats making it harder to do:
 *
 *   stage / unstage    its own inverse                    →  nothing
 *   discard            undoable (pathspec-stash backup)   →  no dialog, undo toast
 *   commit             undoable (reset --soft HEAD~1)     →  no dialog, undo toast
 *   revert / pick      creates a new commit               →  no dialog, undo toast
 *   undo last commit   soft, changes kept staged          →  no dialog
 *   stash drop         gone                               →  confirm
 *   delete branch      gone (tip SHA printed for recovery)→  confirm, twice if unmerged
 *   dirty checkout     blocked or carried over            →  confirm + alternative
 *   hunk discard       below file granularity, no backup  →  confirm
 *   discard on old git no backup possible                 →  confirm, no undo offered
 *   reset --hard       gone, unbounded scope              →  confirm + requireTyped
 *
 * These builders are pure so each rung is testable without mounting the panel,
 * and so the same wording cannot drift between the context menu, the overflow
 * menu and the keyboard path that all reach one action.
 */

import type { WorkingCopyOperation } from "./types";

export type SourceControlConfirmTone = "danger" | "neutral";

/**
 * A confirm descriptor. Plain strings rather than nodes — this module has no
 * React dependency, and every rung's copy is text by design.
 */
export interface SourceControlConfirmOptions {
  readonly title: string;
  /** Plain English: what is lost, and whether it can be recovered. Required. */
  readonly consequence: string;
  /** Optional detail — e.g. the list of files about to be discarded. */
  readonly body?: string | undefined;
  readonly confirmLabel: string;
  readonly tone: SourceControlConfirmTone;
  /**
   * Require the user to type this exact word before confirming. For the top
   * rung only — below it this is theatre, and theatre trains people to type
   * through dialogs without reading them.
   */
  readonly requireTyped?: string;
  /**
   * A safer path to the same goal, offered as a peer of the destructive one
   * rather than making the user cancel and go do it by hand.
   */
  readonly alternative?: { readonly label: string };
  /** Ask a second time after the first confirm (unmerged branch deletion). */
  readonly repeatConfirm?: boolean;
}

const SHORT_HASH_LENGTH = 7;
const DEFAULT_LIST_LIMIT = 8;

function shortenHash(hash: string): string {
  return hash.length > 8 ? hash.slice(0, SHORT_HASH_LENGTH) : hash;
}

function renderList(items: ReadonlyArray<string>, limit = DEFAULT_LIST_LIMIT): string {
  if (items.length <= limit) {
    return items.join("\n");
  }
  return `${items.slice(0, limit).join("\n")}\n…and ${items.length - limit} more`;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

// ─── Irrecoverable, bounded scope ───────────────────────────────────────────

/**
 * Deleting an unmerged branch is the one destructive git action with a genuine
 * recovery path, so the dialog names the commits at risk and the caller's toast
 * prints the tip SHA — `git checkout <sha>` gets them all back.
 */
export function confirmDeleteBranch(
  name: string,
  options: {
    readonly unmerged: boolean;
    readonly tipSha?: string;
    readonly lostCommits?: ReadonlyArray<string>;
  },
): SourceControlConfirmOptions {
  if (!options.unmerged) {
    return {
      title: `Delete branch "${name}"?`,
      consequence: "Its commits are already merged, so nothing is lost.",
      confirmLabel: "Delete branch",
      tone: "danger",
    };
  }
  const lostCount = options.lostCommits?.length ?? 0;
  return {
    title: `Delete unmerged branch "${name}"?`,
    consequence:
      lostCount > 0
        ? `${countLabel(lostCount, "commit")} on "${name}" ${lostCount === 1 ? "is" : "are"} not on any other branch. After deleting, they are only reachable by SHA.`
        : `"${name}" is not fully merged. Its commits will only be reachable by SHA.`,
    body: lostCount > 0 ? renderList(options.lostCommits ?? [], 10) : undefined,
    confirmLabel: "Delete anyway",
    tone: "danger",
    repeatConfirm: true,
  };
}

/** A dropped stash is not recoverable, and this is the panel's only such action. */
export function confirmStashDrop(stash: {
  readonly ref?: string;
  readonly message?: string;
}): SourceControlConfirmOptions {
  const label = stash.message?.trim() || stash.ref || "this stash";
  return {
    title: "Drop stash?",
    consequence: "The stashed changes are deleted. There is no undo for this.",
    body: label,
    confirmLabel: "Drop stash",
    tone: "danger",
  };
}

/** Aborting a merge/rebase throws away the conflict resolution done so far. */
export function confirmAbortOperation(
  operation: WorkingCopyOperation,
): SourceControlConfirmOptions {
  return {
    title: `Abort ${operation}?`,
    consequence: `The working tree returns to how it was before the ${operation} started. Any conflict resolution you have done is discarded.`,
    confirmLabel: `Abort ${operation}`,
    tone: "danger",
  };
}

/** Merging can conflict, but is abortable — a light, informative confirm. */
export function confirmMergeBranch(
  branch: string,
  currentBranch: string,
): SourceControlConfirmOptions {
  return {
    title: `Merge "${branch}" into "${currentBranch}"?`,
    consequence: "If it conflicts, the panel will show the conflicted files and you can abort.",
    confirmLabel: "Merge",
    tone: "neutral",
  };
}

/**
 * Hunk-level discard is sub-file, so it cannot ride the pathspec-stash backup
 * that makes whole-file discard undoable. It is the ONE discard that still asks.
 */
export function confirmDiscardHunk(filePath: string): SourceControlConfirmOptions {
  return {
    title: "Discard this hunk?",
    consequence:
      "These lines are removed from the working tree. Hunk-level discard is below file granularity, so it cannot be backed up — this one is not undoable.",
    body: filePath,
    confirmLabel: "Discard hunk",
    tone: "danger",
  };
}

/**
 * Only reachable when the server reports `recoverable: false` — a git too old
 * to take a pathspec stash. Then, and only then, discard asks first.
 */
export function confirmDiscardIrrecoverable(
  filePaths: ReadonlyArray<string> | null,
): SourceControlConfirmOptions {
  const scope =
    filePaths === null
      ? "every uncommitted change in the working tree"
      : countLabel(filePaths.length, "file");
  return {
    title: "Discard changes?",
    consequence: `This git is too old to keep a backup copy, so ${scope} will be lost permanently.`,
    body: filePaths ? renderList(filePaths) : undefined,
    confirmLabel: "Discard",
    tone: "danger",
  };
}

// ─── A safer path to the same goal ──────────────────────────────────────────

export function confirmDirtyCheckout(
  branch: string,
  dirtyCount: number,
): SourceControlConfirmOptions {
  return {
    title: `Switch to "${branch}" with uncommitted changes?`,
    consequence: `${countLabel(dirtyCount, "changed file")} will be carried over to "${branch}", and git will refuse the switch outright if any of them conflict.`,
    confirmLabel: "Switch anyway",
    alternative: { label: "Stash and switch" },
    tone: "danger",
  };
}

// ─── Irrecoverable, unbounded scope ─────────────────────────────────────────

export function confirmResetHard(hash: string, dirty: boolean): SourceControlConfirmOptions {
  return {
    title: `Hard reset to ${shortenHash(hash)}?`,
    consequence: dirty
      ? "Every commit after this one AND all uncommitted changes are destroyed. There is no reflog entry for the working tree."
      : "Every commit after this one is removed from the branch.",
    confirmLabel: "Reset --hard",
    requireTyped: "reset",
    tone: "danger",
  };
}

/** Reverting a merge picks a side; the choice is what needs stating. */
export function confirmRevertMerge(hash: string): SourceControlConfirmOptions {
  return {
    title: `Revert merge ${shortenHash(hash)}?`,
    consequence:
      "A merge has two parents, so the revert undoes it relative to the FIRST parent (mainline) — the branch you were on when you merged.",
    confirmLabel: "Revert merge",
    tone: "neutral",
  };
}

// ─── The toasts that replace a dialog when the action is undoable ───────────

export function commitToastText(shortHash: string, fileCount: number): string {
  return `Committed ${shortHash} — ${countLabel(fileCount, "file")}`;
}

export function discardToastText(filePaths: ReadonlyArray<string> | null): string {
  if (filePaths === null) {
    return "Discarded all changes";
  }
  if (filePaths.length === 1) {
    return `Discarded changes in ${filePaths[0]}`;
  }
  return `Discarded changes in ${filePaths.length} files`;
}

export function undoCommitToastText(): string {
  return "Commit undone — changes kept staged";
}

/**
 * The recovery line for a deleted branch. The SHA is the whole point: without
 * it "deleted" really is final; with it the user can `git checkout <sha>`.
 */
export function branchDeletedToastText(name: string, tipSha?: string): string {
  return tipSha
    ? `Deleted "${name}" — recover with git checkout ${shortenHash(tipSha)}`
    : `Deleted branch "${name}"`;
}

// ─── Per-repo discard recoverability ────────────────────────────────────────
//
// The server answers each discard with whether it could take a backup stash.
// ONE observation of `recoverable: false` permanently flips that repo onto the
// confirm-first ladder for the rest of the session: an old git will not get
// newer mid-session, and re-learning it per action means the first discard on
// every repo is the unguarded one.

export type DiscardRecoverabilityState = ReadonlySet<string>;

export const EMPTY_DISCARD_RECOVERABILITY: DiscardRecoverabilityState = new Set<string>();

export function noteDiscardRecoverability(
  state: DiscardRecoverabilityState,
  cwd: string,
  recoverable: boolean,
): DiscardRecoverabilityState {
  if (recoverable || state.has(cwd)) {
    return state;
  }
  return new Set([...state, cwd]);
}

/** True when discard in this repo must confirm first and offer no undo. */
export function discardRequiresConfirm(state: DiscardRecoverabilityState, cwd: string): boolean {
  return state.has(cwd);
}

/**
 * fork: f4 AI commit message — the one rung generation needs.
 *
 * A generated message replacing text the user already wrote is the only
 * destructive outcome of pressing ✨, so it asks. An empty draft is filled with
 * no dialog, and a draft edited *during* the flight is left alone entirely (the
 * result is discarded rather than queued behind a dialog the user did not
 * expect).
 */
export function confirmReplaceCommitDraft(options: {
  readonly generated: string;
}): SourceControlConfirmOptions {
  return {
    title: "Replace your commit message?",
    consequence: "Your current message is replaced by the generated one.",
    body: options.generated,
    confirmLabel: "Replace",
    tone: "neutral",
  };
}
