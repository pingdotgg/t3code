import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as KnownWorkspaces from "./KnownWorkspaces.ts";

const makeLayer = (options?: {
  readonly projects?: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
  readonly gitWorktrees?: ReadonlyMap<string, ReadonlyArray<string>>;
}) =>
  KnownWorkspaces.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerSettings.layerTest(),
        SqlitePersistence.layerMemory,
        Layer.mock(ProjectStore.ProjectStoreV2)({
          listShells: () =>
            Effect.succeed(
              (options?.projects ?? []).map((project) => ({
                id: project.id,
                workspaceRoot: project.workspaceRoot,
                trackedFolders: [],
              })) as never,
            ),
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          listWorktreePaths: (cwd) => Effect.succeed([...(options?.gitWorktrees?.get(cwd) ?? [])]),
        }),
      ),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-known-workspaces-" })),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const insertActiveThreadWorktree = (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string;
  },
) =>
  sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id,
      project_id,
      title,
      default_provider,
      runtime_mode,
      interaction_mode,
      created_at,
      updated_at,
      payload_json
    ) VALUES (
      ${input.threadId},
      ${input.projectId},
      ${"Greendale study group"},
      ${"codex"},
      ${"full-access"},
      ${"default"},
      ${"2026-01-01T00:00:00.000Z"},
      ${"2026-01-01T00:00:00.000Z"},
      ${JSON.stringify({ worktreePath: input.worktreePath })}
    )
  `;

it.effect.skipIf(!symlinksSupported)(
  "rejects an outside directory targeted through a symlink inside managed worktrees recorded on an active thread",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const sql = yield* SqlClient.SqlClient;
      const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

      const outsideDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-known-workspaces-outside-",
      });
      const managedProjectDir = path.join(config.worktreesDir, "greendale");
      yield* fileSystem.makeDirectory(managedProjectDir, { recursive: true });
      const escapeLink = path.join(managedProjectDir, "escape");
      yield* fileSystem.symlink(outsideDir, escapeLink);

      yield* insertActiveThreadWorktree(sql, {
        threadId: ThreadId.make("thread:escape"),
        projectId: ProjectId.make("project:greendale"),
        worktreePath: escapeLink,
      });

      const error = yield* knownWorkspaces.assertContains(outsideDir).pipe(Effect.flip);
      expect(error).toBeInstanceOf(KnownWorkspaces.UnknownWorkspaceError);
      const realOutside = yield* fileSystem.realPath(outsideDir);
      expect(yield* knownWorkspaces.contains(realOutside)).toBe(false);
    }).pipe(Effect.provide(makeLayer())),
);

it.effect(
  "allows a real managed worktree and a Git-listed external worktree, but not unlisted external directories",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-known-workspaces-project-",
      });
      const externalWorktree = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-known-workspaces-external-",
      });
      const unlistedDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-known-workspaces-unlisted-",
      });
      const projectId = ProjectId.make("project:greendale");

      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

        const managedWorktree = path.join(config.worktreesDir, "greendale", "feature");
        yield* fileSystem.makeDirectory(managedWorktree, { recursive: true });

        yield* insertActiveThreadWorktree(sql, {
          threadId: ThreadId.make("thread:external"),
          projectId,
          worktreePath: externalWorktree,
        });

        yield* knownWorkspaces.assertContains(managedWorktree);
        yield* knownWorkspaces.assertContains(externalWorktree);
        const error = yield* knownWorkspaces.assertContains(unlistedDir).pipe(Effect.flip);
        expect(error).toBeInstanceOf(KnownWorkspaces.UnknownWorkspaceError);
      }).pipe(
        Effect.provide(
          makeLayer({
            projects: [{ id: projectId, workspaceRoot: projectRoot }],
            gitWorktrees: new Map([[projectRoot, [projectRoot, externalWorktree]]]),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
