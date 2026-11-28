import { GitCommandError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type * as GitVcsDriver from "./GitVcsDriver.ts";

const INDEX_LIST_MAX_BYTES = 64 * 1024 * 1024;
// Git's own removal and the checks that mirror it share one bound.
export const WORKTREE_REMOVE_TIMEOUT_MS = 5 * 60_000;

/**
 * git-annex replaces a linked worktree's `.git` file with a symlink to its admin
 * directory, so its symlinks into `.git/annex` resolve. Git then refuses to remove it.
 */
const annexedAdminDir = Effect.fn("WorktreeRemoval.annexedAdminDir")(
  function* (worktreePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const adminDir = path.resolve(
      worktreePath,
      yield* fileSystem.readLink(path.join(worktreePath, ".git")),
    );
    const pointsBackTo = path.dirname(
      path.resolve(
        adminDir,
        (yield* fileSystem.readFileString(path.join(adminDir, "gitdir"))).trim(),
      ),
    );
    return (yield* fileSystem.realPath(pointsBackTo)) === (yield* fileSystem.realPath(worktreePath))
      ? Option.some(adminDir)
      : Option.none();
  },
  Effect.orElseSucceed(() => Option.none<string>()),
);

export const isLinkedWorktree = Effect.fn("WorktreeRemoval.isLinkedWorktree")(function* (
  worktreePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return (
    (yield* fileSystem.stat(path.join(worktreePath, ".git"))).type === "File" ||
    Option.isSome(yield* annexedAdminDir(worktreePath))
  );
});

/**
 * Git drops a worktree's metadata even when it fails to delete the folder partway, leaving a
 * folder no repository lists; Git for Windows before 2.54 also follows NTFS junctions. So mirror
 * Git's removal checks, delete with Node's `rm`, which unlinks junctions without following them,
 * and only then let Git remove the metadata.
 */
export const removeLinkedWorktree = Effect.fn("WorktreeRemoval.removeLinkedWorktree")(function* <
  A,
  E,
  R,
>(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly force: boolean;
  readonly execute: GitVcsDriver.GitVcsDriver["Service"]["execute"];
  readonly run: (args: ReadonlyArray<string>, cwd: string) => Effect.Effect<A, E, R>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Deleting through a symlink would only unlink the alias and leave the checkout.
  const worktreePath = yield* fileSystem
    .realPath(input.worktreePath)
    .pipe(Effect.orElseSucceed(() => input.worktreePath));
  const gitFile = path.join(worktreePath, ".git");
  // Git refuses to remove a worktree with untracked files unless forced, but
  // its check honors `status.showUntrackedFiles=no` and would delete them.
  const statusConfig = ["-c", "status.showUntrackedFiles=normal"];
  // Git's own refusals, worded the way it prints them.
  const refuse = (message: string, cause?: unknown) =>
    new GitCommandError({
      operation: input.operation,
      command: "git worktree remove",
      cwd: input.cwd,
      detail: `fatal: ${message}`,
      ...(cause === undefined ? {} : { cause }),
    });
  const annexed = yield* annexedAdminDir(worktreePath);
  if (Option.isSome(annexed)) {
    const adminDir = annexed.value;
    const writeGitFile = fileSystem.writeFileString(gitFile, `gitdir: ${adminDir}\n`);
    // A kept worktree's annexed files resolve only through the symlink; a gitdir
    // file is the fallback when it cannot be recreated.
    yield* Effect.addFinalizer(() =>
      fileSystem.exists(worktreePath).pipe(
        Effect.flatMap((kept) =>
          kept
            ? fileSystem.remove(gitFile, { force: true }).pipe(
                Effect.andThen(fileSystem.symlink(adminDir, gitFile)),
                Effect.catch(() => writeGitFile),
              )
            : Effect.void,
        ),
        Effect.ignore,
      ),
    );
    yield* fileSystem.remove(gitFile).pipe(
      Effect.andThen(writeGitFile),
      Effect.mapError((cause) => refuse(`failed to replace '${gitFile}'`, cause)),
    );
  }
  const linked = yield* fileSystem.stat(gitFile).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
  if (!linked) {
    return yield* input.run(
      [
        ...statusConfig,
        "worktree",
        "remove",
        ...(input.force ? ["--force"] : []),
        "--",
        worktreePath,
      ],
      input.cwd,
    );
  }

  const gitOutput = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    input
      .execute({
        operation: input.operation,
        cwd,
        args,
        maxOutputBytes: INDEX_LIST_MAX_BYTES,
        timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
        ...(env === undefined ? {} : { env }),
      })
      .pipe(Effect.map((result) => result.stdout));
  // Windows paths ignore case. Elsewhere two repositories' paths can differ only in case,
  // so the files themselves are compared.
  const samePath = (yield* HostProcess.isWindows)
    ? (left: string, right: string) =>
        Effect.all([fileSystem.realPath(left), fileSystem.realPath(right)]).pipe(
          Effect.map(([a, b]) => a.toLowerCase() === b.toLowerCase()),
          Effect.orElseSucceed(() => false),
        )
    : (left: string, right: string) =>
        Effect.all([fileSystem.stat(left), fileSystem.stat(right)]).pipe(
          Effect.map(
            ([a, b]) =>
              a.dev === b.dev &&
              Option.isSome(a.ino) &&
              a.ino.value === Option.getOrUndefined(b.ino),
          ),
          Effect.orElseSucceed(() => false),
        );

  // A registered worktree of this repository: its `.git` file names an admin
  // directory under the common `worktrees/`, whose `gitdir` points back.
  const notAWorktree = refuse(`'${worktreePath}' is not a working tree`);
  const adminDir = path.resolve(
    worktreePath,
    (yield* gitOutput(worktreePath, ["rev-parse", "--absolute-git-dir"]).pipe(
      Effect.mapError(() => notAWorktree),
    )).replace(/\n$/, ""),
  );
  const commonDir = path.resolve(
    input.cwd,
    (yield* gitOutput(input.cwd, ["rev-parse", "--git-common-dir"])).replace(/\n$/, ""),
  );
  const pointsBack = yield* fileSystem.readFileString(path.join(adminDir, "gitdir")).pipe(
    // Folders, not `.git` files: a hard-linked copy of the checkout shares its `.git` file.
    Effect.flatMap((gitdir) => {
      const backlink = path.resolve(adminDir, gitdir.trim());
      return path.basename(backlink) === ".git"
        ? samePath(path.dirname(backlink), worktreePath)
        : Effect.succeed(false);
    }),
    Effect.orElseSucceed(() => false),
  );
  if (!pointsBack || !(yield* samePath(path.dirname(adminDir), path.join(commonDir, "worktrees"))))
    return yield* notAWorktree;
  // Git counts the file's existence as a lock. T3 passes at most one
  // `--force`, which never removes a locked worktree. Anything but a
  // confirmed absence refuses.
  const lockFile = path.join(adminDir, "locked");
  const locked = yield* fileSystem.stat(lockFile).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(false)
        : Effect.fail(refuse(`cannot inspect the lock of '${worktreePath}'`, error)),
    ),
  );
  if (locked) {
    const reason = (yield* fileSystem.readFileString(lockFile).pipe(Effect.option)).pipe(
      Option.map((text) => text.trim()),
      Option.getOrElse(() => ""),
    );
    return yield* refuse(
      reason === ""
        ? "cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"
        : `cannot remove a locked working tree, lock reason: ${reason}\nuse 'remove -f -f' to override or unlock first`,
    );
  }
  if (!input.force) {
    // Bound like Git's own check, so `core.worktree` can't point it elsewhere.
    const boundEnv = { GIT_DIR: gitFile, GIT_WORK_TREE: worktreePath };
    const submodules = refuse("working trees containing submodules cannot be moved or removed");
    // An unreadable path counts as present, so a doubt refuses.
    const present = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true));
    if (yield* present(path.join(adminDir, "modules"))) return yield* submodules;
    const index = yield* gitOutput(worktreePath, ["ls-files", "--stage", "-z"], boundEnv);
    for (const entry of index.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const submodule = entry.slice(entry.indexOf("\t") + 1);
      if (yield* present(path.join(worktreePath, submodule, ".git"))) return yield* submodules;
    }
    const status = yield* gitOutput(
      worktreePath,
      [...statusConfig, "status", "--porcelain", "--ignore-submodules=none"],
      boundEnv,
    );
    if (status !== "")
      return yield* refuse(
        `'${worktreePath}' contains modified or untracked files, use --force to delete it`,
      );
  }

  // A file held open can stop the delete partway, so `.git` goes last and a retry still
  // finds the worktree. Node's recursive `rm` reports the first error while sibling
  // deletes still run, so `.git` must not be among them.
  const gitFileContents = yield* fileSystem
    .readFileString(gitFile)
    .pipe(Effect.mapError(() => notAWorktree));
  const failedToDelete = (cause: unknown) => refuse(`failed to delete '${worktreePath}'`, cause);
  for (const name of yield* fileSystem
    .readDirectory(worktreePath)
    .pipe(Effect.mapError(failedToDelete))) {
    if (name === ".git") continue;
    yield* fileSystem
      .remove(path.join(worktreePath, name), { recursive: true })
      .pipe(Effect.mapError(failedToDelete));
  }
  yield* fileSystem.remove(gitFile).pipe(Effect.mapError(failedToDelete));
  yield* fileSystem.remove(worktreePath, { recursive: true }).pipe(
    Effect.tapError(() => fileSystem.writeFileString(gitFile, gitFileContents).pipe(Effect.ignore)),
    Effect.mapError(failedToDelete),
  );
  // The folder is gone, so Git only drops the worktree's metadata. The caller's `cwd` may
  // have been inside it; the common Git directory survives, and is named explicitly
  // because `safe.bareRepository=explicit` refuses to discover it.
  return yield* input.run(
    [
      `--git-dir=${commonDir}`,
      "worktree",
      "remove",
      ...(input.force ? ["--force"] : []),
      "--",
      worktreePath,
    ],
    commonDir,
  );
}, Effect.scoped);
