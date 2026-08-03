/**
 * fork: f4 — the panel's own commit path.
 *
 * **This exists because `git.runStackedAction` cannot be reused.** Its
 * `prepareCommitContext` runs `git reset` and then `add -A` (or a bare
 * `add -A` when no paths are given) on *every* commit that arrives without a
 * pre-resolved suggestion — including one where the user supplied the message.
 * A user who carefully stages three hunks and presses Commit would have their
 * index reset and replaced. A staging UI and that commit path are mutually
 * exclusive.
 *
 * So: `commit -F -`, message over **stdin**, and **no `add` at all**.
 */
import * as Effect from "effect/Effect";

import type { WorkingCopyCommitResult, WorkingCopyError } from "@t3tools/contracts";
import * as commands from "./commands.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";

const readCommitResult = Effect.fn("workingCopy.readCommitResult")(function* (
  git: WorkingCopyGit,
  operation: string,
): Effect.fn.Return<WorkingCopyCommitResult, WorkingCopyError> {
  const summary = yield* git.ok({ operation, args: commands.headCommitSummaryArgs() });
  const [hash = "", shortHash = ""] = summary.stdout.trim().split(commands.LOG_FIELD_SEPARATOR);
  const files = yield* git.run({
    operation,
    args: commands.commitFileCountArgs(hash),
  });
  const filesChanged =
    files.exitCode === 0
      ? files.stdout.split("\0").filter((entry) => entry.trim().length > 0).length
      : 0;
  return { hash, shortHash, filesChanged };
});

export const commitStaged = Effect.fn("workingCopy.commitStaged")(function* (
  git: WorkingCopyGit,
  message: string,
) {
  yield* git.ok({
    operation: "workingCopy.commitStaged",
    args: commands.commitStagedArgs(),
    stdin: message,
    mutating: true,
  });
  return yield* readCommitResult(git, "workingCopy.commitStaged");
});

export const amendCommit = Effect.fn("workingCopy.amendCommit")(function* (
  git: WorkingCopyGit,
  message: string | undefined,
) {
  yield* git.ok({
    operation: "workingCopy.amendCommit",
    args: commands.amendCommitArgs({ hasMessage: message !== undefined }),
    mutating: true,
    ...(message !== undefined ? { stdin: message } : {}),
  });
  return yield* readCommitResult(git, "workingCopy.amendCommit");
});

/** The undo-toast target. Soft, so the index and worktree are untouched. */
export const undoLastCommit = Effect.fn("workingCopy.undoLastCommit")(function* (
  git: WorkingCopyGit,
) {
  yield* git.ok({
    operation: "workingCopy.undoLastCommit",
    args: commands.undoLastCommitArgs(),
    mutating: true,
  });
});

/** Prefills the amend toggle. An unborn repository answers `null`, not an error. */
export const lastCommitMessage = Effect.fn("workingCopy.lastCommitMessage")(function* (
  git: WorkingCopyGit,
) {
  const output = yield* git.run({
    operation: "workingCopy.lastCommitMessage",
    args: commands.lastCommitMessageArgs(),
  });
  return { message: output.exitCode === 0 ? output.stdout.replace(/\n+$/, "") : null };
});
