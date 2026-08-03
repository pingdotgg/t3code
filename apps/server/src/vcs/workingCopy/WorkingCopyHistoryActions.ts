/**
 * fork: f4 — the commit context menu's mutations.
 *
 * Every one of these takes a hash straight from the client, so every one of
 * them validates it before it reaches git as positional argv.
 */
import * as Effect from "effect/Effect";

import type { WorkingCopyResetMode } from "@t3tools/contracts";
import * as commands from "./commands.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";
import { commitStaged } from "./WorkingCopyCommit.ts";

/** Cherry-pick and revert both create a commit, so both are undo-toastable. */
export const cherryPick = Effect.fn("workingCopy.cherryPick")(function* (
  git: WorkingCopyGit,
  hash: string,
) {
  const validated = yield* commands.requireHashIsh("workingCopy.cherryPick", hash);
  yield* git.ok({
    operation: "workingCopy.cherryPick",
    args: commands.cherryPickArgs(validated),
    mutating: true,
  });
  return yield* readHeadCommit(git, "workingCopy.cherryPick");
});

export const revertCommit = Effect.fn("workingCopy.revertCommit")(function* (
  git: WorkingCopyGit,
  input: { readonly hash: string; readonly mainline?: number | undefined },
) {
  const hash = yield* commands.requireHashIsh("workingCopy.revertCommit", input.hash);
  yield* git.ok({
    operation: "workingCopy.revertCommit",
    args: commands.revertCommitArgs({ ...input, hash }),
    mutating: true,
  });
  return yield* readHeadCommit(git, "workingCopy.revertCommit");
});

export const checkoutCommit = Effect.fn("workingCopy.checkoutCommit")(function* (
  git: WorkingCopyGit,
  hash: string,
) {
  const validated = yield* commands.requireHashIsh("workingCopy.checkoutCommit", hash);
  yield* git.ok({
    operation: "workingCopy.checkoutCommit",
    args: commands.checkoutCommitArgs(validated),
    mutating: true,
  });
});

/**
 * `--hard` is the one rung the ladder gates behind a typed confirmation
 * client-side; the server just runs what it is asked.
 */
export const resetToCommit = Effect.fn("workingCopy.resetToCommit")(function* (
  git: WorkingCopyGit,
  input: { readonly hash: string; readonly mode: WorkingCopyResetMode },
) {
  const hash = yield* commands.requireHashIsh("workingCopy.resetToCommit", input.hash);
  yield* git.ok({
    operation: "workingCopy.resetToCommit",
    args: commands.resetToCommitArgs(hash, input.mode),
    mutating: true,
  });
});

export const tagCommit = Effect.fn("workingCopy.tagCommit")(function* (
  git: WorkingCopyGit,
  input: {
    readonly hash: string;
    readonly name: string;
    readonly message?: string | undefined;
  },
) {
  const hash = yield* commands.requireHashIsh("workingCopy.tagCommit", input.hash);
  // fork: f4 — the tag name is positional argv too. `-d` would delete a tag and
  // `-F<path>` would read an arbitrary file into the tag message.
  const name = yield* commands.requireRefName("workingCopy.tagCommit", input.name);
  yield* git.ok({
    operation: "workingCopy.tagCommit",
    args: commands.tagCommitArgs({ ...input, hash, name }),
    mutating: true,
  });
});

const readHeadCommit = Effect.fn("workingCopy.readHeadCommit")(function* (
  git: WorkingCopyGit,
  operation: string,
) {
  const summary = yield* git.ok({ operation, args: commands.headCommitSummaryArgs() });
  const [hash = "", shortHash = ""] = summary.stdout.trim().split(commands.LOG_FIELD_SEPARATOR);
  const files = yield* git.run({ operation, args: commands.commitFileCountArgs(hash) });
  return {
    hash,
    shortHash,
    filesChanged:
      files.exitCode === 0
        ? files.stdout.split("\0").filter((entry) => entry.trim().length > 0).length
        : 0,
  };
});

// Re-exported so callers that need "commit whatever is staged" after a manual
// conflict resolution do not reach for `runStackedAction`.
export { commitStaged };
