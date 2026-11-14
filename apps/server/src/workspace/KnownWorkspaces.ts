// Client-supplied worktrees count only under managed folders or when Git lists them for the
// project, or for a repository in the project's folder that a thread attached.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
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

/** Resolve candidate and root consistently before checking containment. */
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
    /** Takes a symlink-resolved path. */
    readonly contains: (realPath: string) => Effect.Effect<boolean>;
    /** Fails unless `cwd` exists and resolves inside a known workspace. */
    readonly assertContains: (cwd: string) => Effect.Effect<void, UnknownWorkspaceError>;
  }
>()("t3/workspace/KnownWorkspaces") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;

  // Missing roots keep lexical paths; other resolution failures and filesystem roots grant nothing.
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
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.orElseSucceed(() => []),
      );
      // Keyed by repository path: a folder project holds several repositories.
      const listedWorktrees = new Map<string, ReadonlyArray<string>>();
      const isListedWorktree = Effect.fnUntraced(function* (repository: string, worktree: string) {
        let listed = listedWorktrees.get(repository);
        if (listed === undefined) {
          listed = yield* git.listWorktreePaths(repository).pipe(
            Effect.flatMap((paths) => Effect.forEach(paths, resolveRoot)),
            Effect.map((paths) => paths.filter((listedPath) => listedPath !== null)),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          );
          listedWorktrees.set(repository, listed);
        }
        return listed.includes(worktree);
      });
      const projectRoot = (projectId: string) => {
        const project = projects.find((candidate) => candidate.id === projectId);
        return project === undefined ? Effect.succeed(null) : resolveRoot(project.workspaceRoot);
      };
      for (const { worktreePath, projectId } of threads) {
        // Relative paths use server cwd; managed paths still need resolution to reject symlinks elsewhere.
        if (!path.isAbsolute(worktreePath)) continue;
        const worktree = yield* resolveRoot(worktreePath);
        if (worktree === null || !within(worktree)) continue;
        const lexical = path.resolve(worktreePath);
        if (managedDirectories.some((directory) => isWithinRoot(path, lexical, directory))) {
          return true;
        }
        const project = projects.find((candidate) => candidate.id === projectId);
        if (project !== undefined && (yield* isListedWorktree(project.workspaceRoot, worktree))) {
          return true;
        }
      }

      const attachments = yield* sql<{
        readonly repositoryPath: string;
        readonly worktreePath: string;
        readonly projectId: string;
      }>`
        SELECT DISTINCT
          json_extract(r.value, '$.repositoryPath') AS "repositoryPath",
          json_extract(r.value, '$.worktreePath') AS "worktreePath",
          t.project_id AS "projectId"
        FROM orchestration_v2_projection_threads t, json_each(t.payload_json, '$.repoWorktrees') r
        WHERE t.deleted_at IS NULL
          AND json_extract(r.value, '$.repositoryPath') IS NOT NULL
          AND json_extract(r.value, '$.worktreePath') IS NOT NULL
      `.pipe(
        NodeSqliteClient.readOnly,
        Effect.orElseSucceed(() => []),
      );
      // The record alone grants nothing: its repository must sit in the project's
      // folder, and Git must list the worktree for that repository.
      for (const { repositoryPath, worktreePath, projectId } of attachments) {
        if (!path.isAbsolute(repositoryPath) || !path.isAbsolute(worktreePath)) continue;
        const worktree = yield* resolveRoot(worktreePath);
        if (worktree === null || !within(worktree)) continue;
        const root = yield* projectRoot(projectId);
        const repository = yield* resolveRoot(repositoryPath);
        if (root === null || repository === null || !isWithinRoot(path, repository, root)) continue;
        if (yield* isListedWorktree(repository, worktree)) return true;
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
