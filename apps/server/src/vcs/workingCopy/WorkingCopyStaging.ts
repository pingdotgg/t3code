/**
 * fork: f4 — stage / unstage / apply-patch.
 *
 * The load-bearing detail is **argv batching**. A 5 000-file stage cannot go
 * out as one `execve`, and a batch that fails on chunk 3 must still report the
 * two chunks that landed — otherwise the panel says "nothing happened" while
 * half the index moved.
 */
import * as Effect from "effect/Effect";

import type { WorkingCopyBatchResult, WorkingCopyError } from "@t3tools/contracts";
import * as commands from "./commands.ts";
import { exitError, type WorkingCopyGit } from "./WorkingCopyGit.ts";

/** Both caps are enforced; whichever bites first splits the chunk. */
export const MAX_EXEC_ARGV_BYTES = 100_000;
export const MAX_EXEC_PATHS = 1_000;

/**
 * De-duplicate first — an `MM` path appears twice in the status list, and
 * staging it twice is wasted argv budget — then split on both caps.
 */
export function chunkPathsForExec(
  paths: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
  const unique: Array<string> = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (path.length === 0 || seen.has(path)) {
      continue;
    }
    seen.add(path);
    unique.push(path);
  }

  const chunks: Array<Array<string>> = [];
  let current: Array<string> = [];
  let bytes = 0;
  for (const path of unique) {
    const size = Buffer.byteLength(path, "utf8") + 1;
    if (
      current.length > 0 &&
      (current.length >= MAX_EXEC_PATHS || bytes + size > MAX_EXEC_ARGV_BYTES)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(path);
    bytes += size;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * fork: f4 — an empty `paths` array means **everything**, exactly as
 * `WorkingCopyPathsInput` documents it. `chunkPathsForExec([])` returns no
 * chunks (that guard is correct: a genuinely-empty batch must not spawn git per
 * chunk), so the all-files case is its own single invocation with an empty
 * pathspec list — `add -A --` / `reset -q HEAD --`. Without this the composer's
 * "stage everything, then commit" path staged nothing and the commit failed on
 * an empty index.
 *
 * `staged` counts *named* paths, so an all-files batch reports 0; nothing reads
 * it as a file count.
 */
const runBatch = Effect.fn("workingCopy.runBatch")(function* (
  git: WorkingCopyGit,
  operation: string,
  paths: ReadonlyArray<string>,
  buildArgs: (chunk: ReadonlyArray<string>) => ReadonlyArray<string>,
): Effect.fn.Return<WorkingCopyBatchResult, WorkingCopyError> {
  const chunks = paths.length === 0 ? [[] as ReadonlyArray<string>] : chunkPathsForExec(paths);
  let staged = 0;
  for (const chunk of chunks) {
    const args = buildArgs(chunk);
    const output = yield* git.run({ operation, args, mutating: true });
    if (output.exitCode !== 0) {
      const failure = exitError({ operation, args }, git.cwd, output);
      return {
        staged,
        failed: { paths: chunk, detail: failure.detail },
      };
    }
    staged += chunk.length;
  }
  return { staged };
});

export const stagePaths = Effect.fn("workingCopy.stagePaths")(function* (
  git: WorkingCopyGit,
  paths: ReadonlyArray<string>,
) {
  return yield* runBatch(git, "workingCopy.stagePaths", paths, commands.stageArgs);
});

export const unstagePaths = Effect.fn("workingCopy.unstagePaths")(function* (
  git: WorkingCopyGit,
  paths: ReadonlyArray<string>,
) {
  const head = yield* git.run({
    operation: "workingCopy.unstagePaths",
    args: commands.headHashArgs(),
  });
  const hasHead = head.exitCode === 0;
  return yield* runBatch(git, "workingCopy.unstagePaths", paths, (chunk) =>
    commands.unstageArgs(chunk, { hasHead }),
  );
});

/**
 * The hunk-staging primitive. The patch is newline-terminated before it
 * reaches git; `buildHunkPatch` already guarantees that, but a hand-built
 * patch from a future caller must not silently fail to apply.
 */
export const applyPatch = Effect.fn("workingCopy.applyPatch")(function* (
  git: WorkingCopyGit,
  input: {
    readonly patch: string;
    readonly cached?: boolean | undefined;
    readonly reverse?: boolean | undefined;
  },
) {
  const patch = input.patch.endsWith("\n") ? input.patch : `${input.patch}\n`;
  yield* git.ok({
    operation: "workingCopy.applyPatch",
    args: commands.applyPatchArgs(input),
    stdin: patch,
    mutating: true,
  });
});
