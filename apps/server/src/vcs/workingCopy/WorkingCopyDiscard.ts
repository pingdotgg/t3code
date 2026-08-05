/**
 * fork: f4 — discard, implemented as a **pathspec stash backup**.
 *
 * The undo ladder's rule is that friction should be proportional to how hard
 * something is to undo, and that making an action undoable always beats making
 * it harder to do. `git stash push -- <paths>` both reverts the paths and
 * keeps them, so a confirmed discard can still offer an undo toast wired to
 * `restoreDiscardBackup`.
 *
 * Pathspec stash needs git >= 2.13. On an older git (or an unborn repository,
 * where there is nothing to stash against) no backup is possible — and that is
 * answered BEFORE anything is destroyed: the call returns
 * `requiresConfirmation` and touches nothing unless the input already carries
 * `confirmedDestructive: true`. Current clients confirm every discard before
 * sending that flag; the refusal remains load-bearing for older clients.
 */
import * as Effect from "effect/Effect";

import {
  WorkingCopyInvalidRevisionError,
  type WorkingCopyDiscardResult,
  type WorkingCopyError,
  type WorkingCopyStashEntry,
} from "@t3tools/contracts";
import * as commands from "./commands.ts";
import { chunkPathsForExec } from "./WorkingCopyStaging.ts";
import { DISCARD_BACKUP_KEEP, DISCARD_BACKUP_PREFIX, readStashList } from "./WorkingCopyStash.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";

const OPERATION = "workingCopy.discardPaths";
const GIT_VERSION = /(\d+)\.(\d+)/;

/** Pathspec stash (`git stash push -- <paths>`) landed in git 2.13. */
export function supportsPathspecStash(versionOutput: string): boolean {
  const match = GIT_VERSION.exec(versionOutput);
  if (match === null) {
    return false;
  }
  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return false;
  }
  return major > 2 || (major === 2 && minor >= 13);
}

export function backupMessage(label: string | undefined, pathCount: number): string {
  const what = label ?? (pathCount === 0 ? "all changes" : `${pathCount} path(s)`);
  return `${DISCARD_BACKUP_PREFIX} ${what}`;
}

/**
 * Drop prefixed backups past the keep limit, **highest index first** so the
 * lower indices stay valid while the loop runs. Never touches a stash the user
 * made themselves.
 */
export const pruneDiscardBackups = Effect.fn("workingCopy.pruneDiscardBackups")(function* (
  git: WorkingCopyGit,
) {
  const entries = yield* readStashList(git);
  const backups = entries.filter((entry) => entry.isDiscardBackup);
  if (backups.length <= DISCARD_BACKUP_KEEP) {
    return;
  }
  const doomed = [...backups]
    .sort((left, right) => right.index - left.index)
    .slice(0, backups.length - DISCARD_BACKUP_KEEP);
  for (const entry of doomed) {
    yield* git
      .run({
        operation: "workingCopy.pruneDiscardBackups",
        args: commands.stashDropArgs(entry.ref),
        mutating: true,
      })
      .pipe(Effect.asVoid);
  }
});

/**
 * The destructive fallback. Independent steps so an unborn repo still cleans.
 * Exported so its "back to HEAD, not to the index" semantics can be pinned
 * directly — the paths that reach it in production need an old git.
 */
export const discardDestructively = Effect.fn("workingCopy.discardDestructively")(function* (
  git: WorkingCopyGit,
  paths: ReadonlyArray<string>,
) {
  if (paths.length === 0) {
    yield* git.run({ operation: OPERATION, args: commands.resetIndexArgs(), mutating: true });
    yield* git.run({ operation: OPERATION, args: commands.checkoutAllArgs(), mutating: true });
    yield* git.ok({ operation: OPERATION, args: commands.cleanAllArgs(), mutating: true });
    return;
  }
  for (const chunk of chunkPathsForExec(paths)) {
    // fork: f4 — reset the index first, exactly like the whole-worktree branch
    // above. `checkout -- <paths>` alone restores the worktree from the INDEX,
    // so a staged+unstaged file would keep its staged half while the stash path
    // (which resets to HEAD) drops both — one button, two meanings, and a
    // confirm dialog that says "lost permanently" while half survives. Tolerant
    // of failure: an unborn HEAD has nothing to reset to and still needs clean.
    yield* git.run({
      operation: OPERATION,
      args: commands.resetPathsArgs(chunk),
      mutating: true,
    });
    yield* git.run({
      operation: OPERATION,
      args: commands.checkoutPathsArgs(chunk),
      mutating: true,
    });
    yield* git.run({ operation: OPERATION, args: commands.cleanPathsArgs(chunk), mutating: true });
  }
});

/**
 * fork: f4 — the preflight answer. Returned INSTEAD of destroying anything when
 * no backup is possible and the caller has not already confirmed.
 */
const REQUIRES_CONFIRMATION: WorkingCopyDiscardResult = {
  recoverable: false,
  discardedPaths: [],
  requiresConfirmation: true,
};

export const discardPaths = Effect.fn("workingCopy.discardPaths")(function* (
  git: WorkingCopyGit,
  input: {
    readonly paths: ReadonlyArray<string>;
    readonly label?: string | undefined;
    /** fork: f4 — "no backup is possible, do it anyway"; see the contract. */
    readonly confirmedDestructive?: boolean | undefined;
  },
): Effect.fn.Return<WorkingCopyDiscardResult, WorkingCopyError> {
  const version = yield* git.run({ operation: OPERATION, args: commands.versionArgs() });
  const recoverableGit = version.exitCode === 0 && supportsPathspecStash(version.stdout);
  // An unborn HEAD has nothing to stash against.
  const head = yield* git.run({ operation: OPERATION, args: commands.headHashArgs() });
  const chunks = chunkPathsForExec(input.paths);

  if (!recoverableGit || head.exitCode !== 0 || chunks.length > 1) {
    // fork: f4 — answer recoverability BEFORE destroying. Previously this ran
    // the destructive path and only *then* reported `recoverable: false`, so on
    // a fresh `git init` (unborn HEAD) the very first discard deleted untracked
    // files with no dialog, no backup and no undo.
    if (input.confirmedDestructive !== true) {
      return REQUIRES_CONFIRMATION;
    }
    yield* discardDestructively(git, input.paths);
    return { recoverable: false, discardedPaths: input.paths };
  }

  const stashed = yield* git.run({
    operation: OPERATION,
    args: commands.stashPushArgs({
      message: backupMessage(input.label, input.paths.length),
      includeUntracked: true,
      ...(chunks[0] !== undefined ? { paths: chunks[0] } : {}),
    }),
    mutating: true,
  });

  if (stashed.exitCode !== 0) {
    if (input.confirmedDestructive !== true) {
      return REQUIRES_CONFIRMATION;
    }
    yield* discardDestructively(git, input.paths);
    return { recoverable: false, discardedPaths: input.paths };
  }

  // `stash push` with nothing to save exits 0 and creates no entry, so the
  // backup ref is read back rather than assumed.
  const entries = yield* readStashList(git);
  const backup = entries.find((entry) => entry.isDiscardBackup && entry.index === 0);
  if (backup === undefined) {
    return { recoverable: true, discardedPaths: input.paths };
  }

  yield* pruneDiscardBackups(git);

  return {
    recoverable: true,
    // fork: f4 — the STABLE handle. `stash@{0}` is positional: a second discard
    // within the undo toast's 10s window renumbers the stack, and popping
    // `stash@{0}` would then restore the *other* discard and drop its backup.
    backupRef: backup.commit ?? backup.ref,
    discardedPaths: input.paths,
  };
});

export const listDiscardBackups = Effect.fn("workingCopy.listDiscardBackups")(function* (
  git: WorkingCopyGit,
): Effect.fn.Return<ReadonlyArray<WorkingCopyStashEntry>, WorkingCopyError> {
  const entries = yield* readStashList(git);
  return entries.filter((entry) => entry.isDiscardBackup);
});

/**
 * Undo. `stash pop` restores the bytes and removes the backup in one step.
 *
 * fork: f4 — the handle may be either a `stash@{n}` (what the Stashes list
 * renders right now) or a stash **commit** (what `discardPaths` hands the undo
 * toast). A commit is re-resolved to its current index immediately before the
 * pop, and fails loudly if the entry is gone — a silent fallback to
 * `stash@{0}` is exactly the bug this exists to prevent.
 */
const OPERATION_RESTORE = "workingCopy.restoreDiscardBackup";

export const restoreDiscardBackup = Effect.fn("workingCopy.restoreDiscardBackup")(function* (
  git: WorkingCopyGit,
  ref: string,
) {
  const target = yield* resolveBackupRef(git, ref);
  yield* git.ok({
    operation: OPERATION_RESTORE,
    args: commands.stashPopArgs(target),
    mutating: true,
  });
});

const resolveBackupRef = Effect.fn("workingCopy.resolveBackupRef")(function* (
  git: WorkingCopyGit,
  ref: string,
) {
  if (commands.isStashRef(ref)) {
    return ref;
  }
  const commit = yield* commands.requireHashIsh(OPERATION_RESTORE, ref);
  const entries = yield* readStashList(git);
  const match = entries.find(
    (entry) =>
      entry.commit !== undefined &&
      (entry.commit === commit ||
        entry.commit.startsWith(commit) ||
        commit.startsWith(entry.commit)),
  );
  if (match === undefined) {
    return yield* new WorkingCopyInvalidRevisionError({ operation: OPERATION_RESTORE, rev: ref });
  }
  return match.ref;
});
