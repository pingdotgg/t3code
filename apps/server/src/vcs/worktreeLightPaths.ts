// @effect-diagnostics nodeBuiltinImport:off - fs.cp is the only portable FICLONE folder copy.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as CheckoutCloner from "./CheckoutCloner.ts";

export interface WorktreeLightPathsInput {
  readonly sourcePath: string;
  readonly worktreePath: string;
  /** One folder per repository, shared by all of its worktrees. */
  readonly sharedRoot: string;
  /** The repository's `info/exclude`, which every worktree reads. */
  readonly excludeFile: string;
  readonly sharedPaths: ReadonlyArray<string>;
  readonly clonePaths: ReadonlyArray<string>;
  readonly isIgnored: (relativePath: string) => Effect.Effect<boolean>;
}

const reflinkCopy = (source: string, destination: string) =>
  Effect.tryPromise({
    try: () =>
      NodeFSP.cp(source, destination, {
        recursive: true,
        mode: NodeFS.constants.COPYFILE_FICLONE_FORCE,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        errorOnExist: true,
        force: false,
      }),
    catch: (cause) => new CheckoutCloner.CheckoutCloneError({ source, destination, cause }),
  }).pipe(
    Effect.tapError(() =>
      Effect.promise(() => NodeFSP.rm(destination, { recursive: true, force: true })),
    ),
  );

/**
 * Links each shared path to the repository's shared folder and clones each clone path from the
 * source checkout. Every path is best effort: a failure is logged and the worktree stays usable.
 */
export const prepareWorktreeLightPaths = Effect.fn("GitVcsDriver.prepareWorktreeLightPaths")(
  function* (input: WorktreeLightPathsInput) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* HostProcess.Platform;
    const clonefile = yield* CheckoutCloner.CheckoutCloner;
    const clone = clonefile ?? (platform === "linux" ? reflinkCopy : undefined);
    const toNative = (relativePath: string) => relativePath.split("/").join(path.sep);
    const lexists = (target: string) =>
      fileSystem.readLink(target).pipe(
        Effect.as(true),
        Effect.catch(() => fileSystem.exists(target)),
        Effect.orElseSucceed(() => false),
      );
    const isDirectory = (target: string) =>
      fileSystem.stat(target).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );

    const seedShared = Effect.fn("GitVcsDriver.seedSharedPath")(function* (
      source: string,
      target: string,
    ) {
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      if (clone !== undefined && (yield* isDirectory(source))) {
        // Cloned beside the target and renamed, so a concurrent worktree never sees half a seed.
        const staging = yield* fileSystem.makeTempDirectory({
          directory: path.dirname(target),
          prefix: ".seed-",
        });
        yield* clone(source, path.join(staging, "seed")).pipe(
          Effect.andThen(fileSystem.rename(path.join(staging, "seed"), target)),
          Effect.catch((cause) =>
            Effect.logDebug("could not seed a shared worktree path", { target, cause }),
          ),
          Effect.ensuring(fileSystem.remove(staging, { recursive: true }).pipe(Effect.ignore)),
        );
      }
      yield* fileSystem.makeDirectory(target, { recursive: true });
    });

    const linkShared = Effect.fn("GitVcsDriver.linkSharedPath")(function* (relativePath: string) {
      const link = path.join(input.worktreePath, toNative(relativePath));
      if (yield* lexists(link)) {
        return yield* Effect.logWarning(
          "t3.json shares a path that the worktree already has; leaving it in place",
          { relativePath },
        );
      }
      const target = path.join(input.sharedRoot, toNative(relativePath));
      if (!(yield* isDirectory(target))) {
        yield* seedShared(path.join(input.sourcePath, toNative(relativePath)), target);
      }
      yield* fileSystem.makeDirectory(path.dirname(link), { recursive: true });
      yield* fileSystem.symlink(target, link);
      // A `dir/` ignore pattern does not match a symlink, which would then show as untracked.
      if (!(yield* input.isIgnored(relativePath))) {
        const entry = `/${relativePath}`;
        const current = yield* fileSystem
          .readFileString(input.excludeFile)
          .pipe(Effect.orElseSucceed(() => ""));
        if (!current.split(/\r?\n/).includes(entry)) {
          yield* fileSystem.makeDirectory(path.dirname(input.excludeFile), { recursive: true });
          const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
          yield* fileSystem.writeFileString(input.excludeFile, `${separator}${entry}\n`, {
            flag: "a",
          });
        }
      }
    });

    const clonePath = Effect.fn("GitVcsDriver.clonePath")(function* (relativePath: string) {
      if (clone === undefined) return;
      const source = path.join(input.sourcePath, toNative(relativePath));
      const destination = path.join(input.worktreePath, toNative(relativePath));
      if (!(yield* isDirectory(source)) || (yield* lexists(destination))) return;
      yield* fileSystem.makeDirectory(path.dirname(destination), { recursive: true });
      yield* clone(source, destination);
    });

    yield* Effect.forEach(
      input.clonePaths,
      (relativePath) =>
        clonePath(relativePath).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not clone a worktree path", { relativePath, cause }),
          ),
        ),
      { discard: true },
    );
    yield* Effect.forEach(
      input.sharedPaths,
      (relativePath) =>
        linkShared(relativePath).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not share a worktree path", { relativePath, cause }),
          ),
        ),
      { discard: true },
    );
  },
);

/** Whether an ignored worktree entry is a link to a shared path, whose contents outlive the worktree. */
export const makeIsSharedPathLink = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { worktreeSharedPathsDir } = yield* ServerConfig.ServerConfig;
  return (worktreePath: string, entry: string) =>
    fileSystem.readLink(path.join(worktreePath, entry.replace(/\/+$/, ""))).pipe(
      Effect.map((target) => target.startsWith(worktreeSharedPathsDir + path.sep)),
      Effect.orElseSucceed(() => false),
    );
});
