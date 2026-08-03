/**
 * fork: f4 — the reads that feed the existing `DiffPanel`.
 *
 * No second diff viewer is built: selecting a file in the changes list opens
 * t3's existing diff right-panel surface, which already has a worker pool,
 * virtualization and inline review comments. These reads just hand it a patch.
 */
import * as Effect from "effect/Effect";

import type {
  WorkingCopyDiffResult,
  WorkingCopyError,
  WorkingCopyFileContentResult,
} from "@t3tools/contracts";
import * as commands from "./commands.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";

export const readDiff = Effect.fn("workingCopy.readDiff")(function* (
  git: WorkingCopyGit,
  input: {
    readonly path: string;
    readonly staged: boolean;
    readonly oldPath?: string | undefined;
  },
): Effect.fn.Return<WorkingCopyDiffResult, WorkingCopyError> {
  const output = yield* git.run({
    operation: "workingCopy.diff",
    // `-M` with both sides named makes git emit a proper rename header rather
    // than a whole-file "new file" diff.
    args: commands.diffArgs(input),
  });
  if (output.exitCode === 0 && output.stdout.length > 0) {
    return { patch: output.stdout, truncated: output.stdoutTruncated };
  }

  // An empty patch is ambiguous: the file may be clean, or it may be untracked
  // and therefore invisible to `git diff`. Ask before falling back — a clean
  // *tracked* file must not be rendered as an entirely new file.
  const tracked = yield* git.run({
    operation: "workingCopy.diff",
    args: commands.isTrackedArgs(input.path),
  });
  if (tracked.exitCode === 0) {
    return { patch: output.stdout, truncated: output.stdoutTruncated };
  }

  // Untracked: there is no diff target, so `--no-index` against /dev/null is
  // the only way to get a patch. git exits 1 and the patch is on stdout.
  const untracked = yield* git.run({
    operation: "workingCopy.diff",
    args: commands.untrackedDiffArgs(input.path),
  });
  return { patch: untracked.stdout, truncated: untracked.stdoutTruncated };
});

export const readCommitFileDiff = Effect.fn("workingCopy.readCommitFileDiff")(function* (
  git: WorkingCopyGit,
  input: {
    readonly hash: string;
    readonly path: string;
    readonly oldPath?: string | undefined;
  },
): Effect.fn.Return<WorkingCopyDiffResult, WorkingCopyError> {
  const hash = yield* commands.requireHashIsh("workingCopy.commitFileDiff", input.hash);
  const output = yield* git.ok({
    operation: "workingCopy.commitFileDiff",
    args: commands.commitFileDiffArgs({ ...input, hash }),
  });
  return { patch: output.stdout, truncated: output.stdoutTruncated };
});

/** `rev` is a hash, or `":"` for the index side. */
export const readFileAtRef = Effect.fn("workingCopy.readFileAtRef")(function* (
  git: WorkingCopyGit,
  input: { readonly rev: string; readonly path: string },
): Effect.fn.Return<WorkingCopyFileContentResult, WorkingCopyError> {
  const rev =
    input.rev === ":" ? ":" : yield* commands.requireHashIsh("workingCopy.fileAtRef", input.rev);
  const output = yield* git.run({
    operation: "workingCopy.fileAtRef",
    args: commands.fileAtRefArgs(rev, input.path),
  });
  // A path that does not exist at that rev is an answer, not a failure — the
  // diff viewer renders it as an empty side.
  if (output.exitCode !== 0) {
    return { content: "", exists: false, truncated: false };
  }
  return { content: output.stdout, exists: true, truncated: output.stdoutTruncated };
});
