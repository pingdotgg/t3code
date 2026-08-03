/**
 * fork: f4 — the panel's status read.
 *
 * Deliberately **not** `VcsStatusResult`: that payload is subscribed per
 * visible sidebar thread row and is a numstat summary. This is
 * `status --porcelain=v1 -uall -z` plus the branch/upstream reads and the
 * git-dir operation markers, and only the panel pays for it.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import type { WorkingCopyError, WorkingCopyStatusResult } from "@t3tools/contracts";
import * as commands from "./commands.ts";
import { operationFromGitDirEntries } from "./operationMarkers.ts";
import { applyNumstat, parseAheadBehind, parseNumstatZ, parsePorcelainV1Z } from "./porcelain.ts";
import type { WorkingCopyGit } from "./WorkingCopyGit.ts";

const OPERATION = "workingCopy.status";

/**
 * Read the git dir's top-level entries. A missing or unreadable git dir means
 * "no operation in progress", never a failed status.
 */
const readGitDirEntries = Effect.fn("workingCopy.readGitDirEntries")(function* (gitDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readDirectory(gitDir).pipe(Effect.orElseSucceed(() => []));
});

export const readWorkingCopyStatus = Effect.fn("workingCopy.readWorkingCopyStatus")(function* (
  git: WorkingCopyGit,
): Effect.fn.Return<WorkingCopyStatusResult, WorkingCopyError, FileSystem.FileSystem> {
  const status = yield* git.ok({ operation: OPERATION, args: commands.statusArgs() });

  // `symbolic-ref --quiet` exits 1 on a detached or unborn HEAD; that is an
  // answer, not a failure.
  const branch = yield* git.run({ operation: OPERATION, args: commands.currentBranchArgs() });
  const detachedOrUnborn = branch.exitCode !== 0;
  const refName = detachedOrUnborn ? null : branch.stdout.trim() || null;

  const head = yield* git.run({ operation: OPERATION, args: commands.headHashArgs() });
  const hasHead = head.exitCode === 0;

  const upstream = yield* git.run({ operation: OPERATION, args: commands.upstreamArgs() });
  const hasUpstream = upstream.exitCode === 0 && upstream.stdout.trim().length > 0;

  // No upstream, or a `[gone]` one, means **no numbers**. Reporting 0/0 would
  // render as "in sync", which is a different and wrong statement.
  const aheadBehind = hasUpstream
    ? yield* git
        .run({ operation: OPERATION, args: commands.aheadBehindArgs() })
        .pipe(Effect.map((output) => (output.exitCode === 0 ? output.stdout : null)))
    : null;

  const stagedNumstat = hasHead
    ? yield* git.run({ operation: OPERATION, args: commands.numstatArgs(true) })
    : null;
  const unstagedNumstat = yield* git.run({
    operation: OPERATION,
    args: commands.numstatArgs(false),
  });

  const gitDir = yield* git.run({ operation: OPERATION, args: commands.absoluteGitDirArgs() });
  const entries =
    gitDir.exitCode === 0 ? yield* readGitDirEntries(gitDir.stdout.trim()) : ([] as const);

  const files = applyNumstat(
    parsePorcelainV1Z(status.stdout),
    stagedNumstat !== null && stagedNumstat.exitCode === 0
      ? parseNumstatZ(stagedNumstat.stdout)
      : [],
    unstagedNumstat.exitCode === 0 ? parseNumstatZ(unstagedNumstat.stdout) : [],
  );

  return {
    isRepo: true,
    refName,
    detached: detachedOrUnborn && hasHead,
    ...parseAheadBehind(aheadBehind),
    hasUpstream,
    files,
    operationInProgress: operationFromGitDirEntries(entries),
  } satisfies WorkingCopyStatusResult;
});
