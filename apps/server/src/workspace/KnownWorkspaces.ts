/**
 * KnownWorkspaces - the folders a client-named cwd may act in: a T3-managed
 * worktree folder, a registered project, or a thread's worktree. Clients send
 * the thread's worktree, else the project root. A client also sets a thread's
 * worktree path, so one counts only under a managed folder or when git lists
 * it as a worktree of the thread's project.
 *
 * @module KnownWorkspaces
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isFilesystemRoot, managedWorktreesDirectories } from "../worktreesDirectory.ts";

export class UnknownWorkspaceError extends Schema.TaggedError<UnknownWorkspaceError>()(
  "UnknownWorkspaceError",
  {
    cwd: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `'${this.cwd}' is not a registered project, a managed worktree, or a thread's worktree.`;
  }
}

/** Whether `candidate` is `root` or inside it. Resolve both the same way first. */
export const isWithinRoot = (path: Path.Path, candidate: string, root: string) => {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

export class KnownWorkspaces extends Context.Service<
  KnownWorkspaces,
  {
    /** Whether a symlink-resolved path is inside a known workspace. */
    readonly contains: (realPath: string) => Effect.Effect<boolean>;
    /** Fails unless `cwd` exists and resolves inside a known workspace. */
    readonly assertContains: (cwd: string) => Effect.Effect<void, UnknownWorkspaceError>;
  }
>()("t3/workspace/KnownWorkspaces") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;

  // A root that does not exist yet keeps its lexical path. One that cannot be
  // resolved for another reason, or resolves to a filesystem root, grants nothing.
  const resolveRoot = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.succeed(cause.reason._tag === "NotFound" ? resolvedPath : null),
      }),
      Effect.map((root) => (root === null || isFilesystemRoot(root, path) ? null : root)),
    );
  };

  const contains: KnownWorkspaces["Service"]["contains"] = Effect.fn("KnownWorkspaces.contains")(
    function* (realPath) {
      const within = (root: string | null) => root !== null && isWithinRoot(path, realPath, root);
      const worktreeSettings = yield* settings.getSettings.pipe(
        Effect.orElseSucceed(() => ({ worktreesDirectory: "", previousWorktreesDirectories: [] })),
      );
      const home = yield* HostProcess.HomeDirectory;
      const managedDirectories = managedWorktreesDirectories(
        worktreeSettings,
        config.worktreesDir,
        path,
        home,
      );
      const managed = (yield* Effect.forEach(managedDirectories, resolveRoot)).filter(
        (root) => root !== null,
      );
      if (managed.some(within)) return true;

      const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
      for (const project of projects) {
        if (within(yield* resolveRoot(project.workspaceRoot))) return true;
      }

      const threads = yield* sql<{ readonly worktreePath: string; readonly projectId: string }>`
        SELECT DISTINCT
          json_extract(payload_json, '$.worktreePath') AS "worktreePath",
          project_id AS "projectId"
        FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
      `.pipe(Effect.orElseSucceed(() => []));
      const projectWorktrees = new Map<string, ReadonlyArray<string>>();
      const isProjectWorktree = Effect.fnUntraced(function* (
        projectId: string,
        worktreePath: string,
      ) {
        const project = projects.find((candidate) => candidate.id === projectId);
        if (project === undefined) return false;
        let listed = projectWorktrees.get(projectId);
        if (listed === undefined) {
          listed = yield* git.listWorktreePaths(project.workspaceRoot).pipe(
            Effect.flatMap((paths) => Effect.forEach(paths, resolveRoot)),
            Effect.map((paths) => paths.filter((listedPath) => listedPath !== null)),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          );
          projectWorktrees.set(projectId, listed);
        }
        const real = yield* resolveRoot(worktreePath);
        return real !== null && listed.includes(real);
      });
      for (const { worktreePath, projectId } of threads) {
        // A relative path would resolve against the server's own cwd. One under a
        // managed folder is still resolved: it can be a symlink to a checkout elsewhere.
        if (!path.isAbsolute(worktreePath)) continue;
        if (!within(yield* resolveRoot(worktreePath))) continue;
        const lexical = path.resolve(worktreePath);
        if (managedDirectories.some((directory) => isWithinRoot(path, lexical, directory))) {
          return true;
        }
        if (yield* isProjectWorktree(projectId, worktreePath)) return true;
      }
      return false;
    },
  );

  const assertContains: KnownWorkspaces["Service"]["assertContains"] = Effect.fn(
    "KnownWorkspaces.assertContains",
  )(function* (cwd) {
    // `..` collapses on the path as named before symlinks resolve, as the write does.
    const realCwd = yield* fileSystem
      .realPath(path.resolve(cwd))
      .pipe(Effect.mapError((cause) => new UnknownWorkspaceError({ cwd, cause })));
    if (!(yield* contains(realCwd))) return yield* new UnknownWorkspaceError({ cwd });
  });

  return KnownWorkspaces.of({ contains, assertContains });
});

export const layer = Layer.effect(KnownWorkspaces, make);
