import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  isFilesystemRoot,
  isGitDirectoryName,
  managedWorktreesDirectories,
  parseRelativeWorktreesDirectory,
} from "../worktreesDirectory.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { parseWorktreeList } from "./worktreeList.ts";

interface WorktreeLocationSettings {
  readonly worktreesDirectory: string;
  readonly previousWorktreesDirectories: ReadonlyArray<string>;
}

/**
 * Where the server may have placed a project's worktrees. Thread paths are untrusted, so callers
 * pass the thread's persisted project: an in-project folder counts only inside that project's own
 * main checkout, never because another repository uses the same layout.
 */
export const makeManagedWorktreePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  // Windows folders ignore case, as creation's own containment checks do there.
  const windows = yield* HostProcess.isWindows;
  const pathKey = (target: string) => (windows ? target.toLowerCase() : target);

  // Match Git's symlink-following location: nearest real ancestor plus missing path components.
  const realLocation = (target: string): Effect.Effect<string> =>
    fileSystem.realPath(target).pipe(
      Effect.catch(() => {
        const parent = path.dirname(target);
        return parent === target
          ? Effect.succeed(target)
          : Effect.map(realLocation(parent), (real) => path.join(real, path.basename(target)));
      }),
    );

  // git resolves a relative path against the project, not the server cwd, and Git and
  // realPath disagree on `..` after symlink traversal, so only normalized absolute paths count.
  const isNormalizedAbsolute = (target: string) =>
    path.isAbsolute(target) && path.resolve(target) === target;

  // The first entry is the main checkout, wherever the project sits; a bare repository has none.
  const readMainCheckout = Effect.fn("ManagedWorktreePaths.readMainCheckout")(
    function* (projectRoot: string) {
      const run = (args: ReadonlyArray<string>) =>
        git.execute({
          operation: "ManagedWorktreePaths.readMainCheckout",
          cwd: projectRoot,
          args: ["worktree", "list", "--porcelain", ...args],
          allowNonZeroExit: true,
        });
      let result = yield* run(["-z"]);
      // Pre-2.36 Git rejects -z; its line output carries the same records.
      if (result.exitCode !== 0) {
        const lines = yield* run([]);
        result = { ...lines, stdout: lines.stdout.replaceAll("\n", "\0") };
      }
      const main = parseWorktreeList(result.stdout)[0];
      if (
        result.exitCode !== 0 ||
        result.stdoutTruncated ||
        main === undefined ||
        main.bare ||
        !path.isAbsolute(main.path)
      ) {
        return null;
      }
      return yield* realLocation(path.resolve(main.path));
    },
    // Unreadable repositories have no in-project folders; fail closed.
    Effect.orElseSucceed(() => null),
  );

  /** True when `worktreePath` is one folder directly inside an in-project worktree folder. */
  const isProjectWorktreePath = Effect.fn("ManagedWorktreePaths.isProjectWorktreePath")(
    function* (input: {
      readonly worktreePath: string;
      readonly projectRoot: string;
      readonly settings: WorktreeLocationSettings;
    }) {
      if (!isNormalizedAbsolute(input.worktreePath)) return false;
      const storages = [
        input.settings.worktreesDirectory,
        ...input.settings.previousWorktreesDirectories,
      ].flatMap((setting) => {
        const segments = parseRelativeWorktreesDirectory(setting);
        return segments === null ? [] : [segments];
      });
      if (storages.length === 0) return false;
      const main = yield* readMainCheckout(input.projectRoot);
      if (main === null) return false;
      // Resolved through links, so a linked storage folder or worktree leads out and never matches.
      const candidate = yield* realLocation(input.worktreePath);
      return (
        !isGitDirectoryName(path.basename(candidate)) &&
        storages.some(
          (storage) => pathKey(path.dirname(candidate)) === pathKey(path.join(main, ...storage)),
        )
      );
    },
  );

  const isManagedWorktreePath = Effect.fn("ManagedWorktreePaths.isManagedWorktreePath")(
    function* (input: { readonly worktreePath: string; readonly projectRoot: string }) {
      if (!isNormalizedAbsolute(input.worktreePath)) return false;
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.orElseSucceed(() => ({ worktreesDirectory: "", previousWorktreesDirectories: [] })),
      );
      const roots = yield* Effect.forEach(
        managedWorktreesDirectories(
          settings,
          serverConfig.worktreesDir,
          path,
          yield* HostProcess.HomeDirectory,
        ),
        realLocation,
      );
      const candidate = yield* realLocation(input.worktreePath);
      // Absolute folders hold <root>/<repository>/<branch> for every project.
      const inAbsoluteRoot = roots.some((root) => {
        if (isFilesystemRoot(root, path)) return false;
        const relative = path.relative(root, candidate);
        const segments = relative.split(path.sep);
        return (
          !path.isAbsolute(relative) &&
          segments.length === 2 &&
          segments.every((segment) => segment !== "" && segment !== "..")
        );
      });
      return inAbsoluteRoot || (yield* isProjectWorktreePath({ ...input, settings }));
    },
  );

  return { isManagedWorktreePath, isProjectWorktreePath };
});
