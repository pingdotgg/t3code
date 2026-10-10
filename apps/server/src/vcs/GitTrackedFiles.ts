/**
 * GitTrackedFiles - which of some files in a project git tracks.
 *
 * Moving or deleting a project's skill or instruction file shows in git only if git tracks it, so
 * the confirmation asks. It runs one `git ls-files` for all the files, and only when a person is
 * about to confirm a change.
 *
 * @module GitTrackedFiles
 */
import * as Effect from "effect/Effect";

import type * as VcsProcess from "./VcsProcess.ts";

/**
 * The files among `files` that git tracks, as they were given. `files` are paths relative to the
 * project's real folder, written with `/`. Every file counts as not tracked when git fails or the
 * folder is not in a repository.
 */
export const trackedFiles = Effect.fn("GitTrackedFiles.trackedFiles")(function* (
  vcs: VcsProcess.VcsProcess["Service"],
  input: {
    /** Names the caller in git's process diagnostics. */
    readonly operation: string;
    readonly cwd: string;
    readonly files: ReadonlyArray<string>;
  },
) {
  if (input.files.length === 0) return new Set<string>();
  const result = yield* vcs
    .run({
      operation: input.operation,
      command: "git",
      args: [
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--cached",
        "-z",
        "--",
        ...input.files,
      ],
      cwd: input.cwd,
      allowNonZeroExit: true,
      timeoutMs: 5_000,
      maxOutputBytes: 256 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  if (result === undefined || result.exitCode !== 0) return new Set<string>();
  const listed = new Set(result.stdout.split("\0"));
  return new Set(input.files.filter((file) => listed.has(file)));
});
