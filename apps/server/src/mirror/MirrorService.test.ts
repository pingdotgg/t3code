// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, ProjectId, type MirrorStreamEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import * as GitSync from "./GitSync.ts";
import * as MirrorBundleTransfer from "./MirrorBundleTransfer.ts";
import * as MirrorHooks from "./MirrorHooks.ts";
import * as MirrorServiceModule from "./MirrorService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";

const projectId = ProjectId.make("mirror-service-test-project");
const originEnvironmentId = EnvironmentId.make("origin-environment");

/**
 * The repository stub points at a project whose mirror root only exists once
 * the test body runs, so the record lives in a mutable box the test fills in.
 */
const projectBox: { current: ProjectionProject | null } = { current: null };

const projectRepositoryStub = Layer.succeed(
  ProjectionProjectRepository,
  ProjectionProjectRepository.of({
    upsert: () => Effect.void,
    getById: ({ projectId: requested }) =>
      Effect.succeed(
        projectBox.current !== null && projectBox.current.projectId === requested
          ? Option.some(projectBox.current)
          : Option.none(),
      ),
    listAll: () => Effect.succeed(projectBox.current === null ? [] : [projectBox.current]),
    deleteById: () => Effect.void,
  }),
);

const ProcessRunnerLayer = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));
const GitSyncLayer = GitSync.layer.pipe(Layer.provide(ProcessRunnerLayer));
const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-mirror-service-test-",
});
const TestLayer = MirrorServiceModule.layer.pipe(
  Layer.provideMerge(MirrorBundleTransfer.layer),
  Layer.provideMerge(GitSyncLayer),
  Layer.provideMerge(ProcessRunnerLayer),
  Layer.provide(MirrorHooks.noopLayer),
  Layer.provide(projectRepositoryStub),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(NodeSqliteClient.layerMemory()),
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

function write(filePath: string, contents: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem
      .makeDirectory(NodePath.dirname(filePath), { recursive: true })
      .pipe(Effect.ignore);
    yield* fileSystem.writeFileString(filePath, contents);
  });
}

function read(filePath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return Option.getOrNull(yield* fileSystem.readFileString(filePath).pipe(Effect.option));
  });
}

function git(cwd: string, args: ReadonlyArray<string>) {
  return Effect.gen(function* () {
    const runner = yield* ProcessRunner.ProcessRunner;
    const result = yield* runner.run({
      command: "git",
      args,
      cwd,
      timeout: "30 seconds",
      env: {
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
    if (result.code !== 0) {
      return yield* Effect.die(
        new Error(`git ${args.join(" ")} failed (${String(result.code)}): ${result.stderr}`),
      );
    }
    return result.stdout.trim();
  });
}

/**
 * The origin side of the protocol, in-process: executes each directive
 * against the origin repository exactly like MirrorAgent does, with the
 * signed-URL HTTP hop replaced by the host's own staging path.
 */
function runFakeAgent(originRoot: string) {
  return Effect.gen(function* () {
    const service = yield* MirrorServiceModule.MirrorService;
    const transfer = yield* MirrorBundleTransfer.MirrorBundleTransfer;
    const gitSync = yield* GitSync.GitSync;
    const stream = yield* service.connect({ projectId });
    const handle = (event: MirrorStreamEvent) =>
      Effect.gen(function* () {
        if (event.type !== "directive") return;
        const directive = event.directive;
        if (directive.type === "link-revoked") return;
        const bundlePath = yield* transfer.stagingPath(directive.syncId);
        switch (directive.type) {
          case "seed-requested": {
            const snapshot = yield* gitSync.createSnapshot({
              root: originRoot,
              syncId: directive.syncId,
            });
            yield* gitSync.createSeedBundle({
              root: originRoot,
              bundlePath,
              snapshotRef: GitSync.mirrorSnapshotRef(directive.syncId),
            });
            yield* service.respond({
              connectionId: event.connectionId,
              response: {
                type: "seed-uploaded",
                syncId: directive.syncId,
                headRef: yield* gitSync.symbolicHead(originRoot),
                snapshotOid: snapshot.snapshotOid,
                remotes: yield* gitSync.listRemotes(originRoot),
              },
            });
            return;
          }
          case "sync-requested": {
            const snapshot = yield* gitSync.createSnapshot({
              root: originRoot,
              syncId: directive.syncId,
            });
            const baseTree =
              directive.baseSnapshotOid === null
                ? null
                : yield* gitSync.treeOfCommit(originRoot, directive.baseSnapshotOid);
            if (baseTree !== null && baseTree === snapshot.treeOid) {
              yield* service.respond({
                connectionId: event.connectionId,
                response: {
                  type: "sync-no-change",
                  syncId: directive.syncId,
                  snapshotOid: directive.baseSnapshotOid ?? snapshot.snapshotOid,
                },
              });
              return;
            }
            yield* gitSync.createIncrementalBundle({
              root: originRoot,
              bundlePath,
              baseOid: directive.baseSnapshotOid ?? "",
              snapshotRef: GitSync.mirrorSnapshotRef(directive.syncId),
              includeBranches: true,
            });
            yield* service.respond({
              connectionId: event.connectionId,
              response: {
                type: "sync-uploaded",
                syncId: directive.syncId,
                snapshotOid: snapshot.snapshotOid,
              },
            });
            return;
          }
          case "apply-requested": {
            yield* gitSync.fetchBundle({
              root: originRoot,
              bundlePath,
              refspecs: [
                "+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*",
                "+refs/heads/*:refs/t3/mirror/incoming/*",
              ],
            });
            const apply = yield* gitSync.applySnapshot({
              root: originRoot,
              syncId: directive.syncId,
              baseOid: directive.baseSnapshotOid,
              targetOid: directive.targetSnapshotOid,
              conflictPreference: "local",
            });
            yield* service.respond({
              connectionId: event.connectionId,
              response: {
                type: "apply-result",
                syncId: directive.syncId,
                outcome: apply.outcome,
                conflictPaths: apply.conflictPaths,
              },
            });
            return;
          }
        }
      });
    return yield* Stream.runForEach(stream, (event) =>
      handle(event).pipe(
        Effect.catch((cause) =>
          service
            .respond({
              connectionId: event.type === "directive" ? event.connectionId : "",
              response: {
                type: "sync-failed",
                syncId:
                  event.type === "directive" && event.directive.type !== "link-revoked"
                    ? event.directive.syncId
                    : "unknown",
                message: cause.message,
              },
            })
            .pipe(Effect.ignore),
        ),
      ),
    ).pipe(Effect.forkScoped);
  });
}

it.layer(TestLayer)("MirrorService", (it) => {
  describe("end to end with an in-process agent", () => {
    it.effect(
      "seeds, gates turns on pushes, and applies turn results back to the origin",
      () =>
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 43 });
          const fileSystem = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const service = yield* MirrorServiceModule.MirrorService;

          // Origin: a dirty git repo. Mirror root: the directory the
          // Normalizer would have created for the project.
          const originRoot = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "mirror-origin-" })
            .pipe(Effect.flatMap((dir) => fileSystem.realPath(dir)));
          yield* git(originRoot, ["init", "--initial-branch=main"]);
          yield* git(originRoot, ["config", "user.email", "test@test.com"]);
          yield* git(originRoot, ["config", "user.name", "Test"]);
          yield* git(originRoot, ["config", "core.autocrlf", "false"]);
          yield* write(NodePath.join(originRoot, "app.ts"), "committed\n");
          yield* git(originRoot, ["add", "."]);
          yield* git(originRoot, ["commit", "-m", "initial"]);
          yield* write(NodePath.join(originRoot, "app.ts"), "committed + dirty edit\n");
          yield* write(NodePath.join(originRoot, "untracked.txt"), "untracked\n");

          const mirrorRoot = NodePath.join(config.mirrorsDir, projectId);
          yield* fileSystem.makeDirectory(mirrorRoot, { recursive: true });
          projectBox.current = {
            projectId,
            title: "Mirrored",
            workspaceRoot: mirrorRoot,
            origin: {
              environmentId: originEnvironmentId,
              rootPath: originRoot,
              label: "Laptop",
            },
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            mirrorIncludeIgnoredFiles: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          };

          // Offline before the agent connects: the gate fails visibly.
          const offline = yield* service.ensureFresh(projectId).pipe(Effect.result);
          expect(offline._tag).toBe("Failure");
          if (offline._tag === "Failure") {
            expect(offline.failure._tag).toBe("MirrorOriginOfflineError");
          }

          yield* runFakeAgent(originRoot);

          // First gate seeds the mirror: full history plus the dirty state.
          yield* service.ensureFresh(projectId);
          expect(yield* read(NodePath.join(mirrorRoot, "app.ts"))).toBe("committed + dirty edit\n");
          expect(yield* read(NodePath.join(mirrorRoot, "untracked.txt"))).toBe("untracked\n");
          expect(yield* git(mirrorRoot, ["rev-parse", "refs/heads/main"])).toBe(
            yield* git(originRoot, ["rev-parse", "refs/heads/main"]),
          );

          // Origin edits flow in on the next gate.
          yield* write(NodePath.join(originRoot, "app.ts"), "second version\n");
          yield* service.ensureFresh(projectId);
          expect(yield* read(NodePath.join(mirrorRoot, "app.ts"))).toBe("second version\n");

          // A turn edits the mirror; apply-back lands it on the origin.
          yield* write(NodePath.join(mirrorRoot, "agent-output.txt"), "made by the agent\n");
          yield* service.applyBack(projectId);
          expect(yield* read(NodePath.join(originRoot, "agent-output.txt"))).toBe(
            "made by the agent\n",
          );

          // No-change gate afterwards is a pure round-trip and must succeed.
          yield* service.ensureFresh(projectId);
        }),
      120_000,
    );
  });

  describe("revokeLink", () => {
    it.effect(
      "tells a connected origin the link is gone and clears the sync watermark",
      () =>
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 44 });
          const fileSystem = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const service = yield* MirrorServiceModule.MirrorService;
          const sql = yield* SqlClient.SqlClient;

          const mirrorRoot = NodePath.join(config.mirrorsDir, projectId);
          yield* fileSystem.makeDirectory(mirrorRoot, { recursive: true });
          yield* git(mirrorRoot, ["init", "--initial-branch=main"]);
          projectBox.current = {
            projectId,
            title: "Mirrored",
            workspaceRoot: mirrorRoot,
            origin: {
              environmentId: originEnvironmentId,
              rootPath: "/tmp/wherever",
              label: "Laptop",
            },
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            mirrorIncludeIgnoredFiles: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          };
          yield* sql`
            INSERT INTO mirror_sync_runtime (project_id, last_synced_snapshot_oid)
            VALUES (${projectId}, ${"0".repeat(40)})
            ON CONFLICT (project_id)
            DO UPDATE SET last_synced_snapshot_oid = excluded.last_synced_snapshot_oid
          `;

          const connectedSeen = yield* Deferred.make<void>();
          const revokedSeen = yield* Deferred.make<void>();
          const stream = yield* service.connect({ projectId });
          yield* Stream.runForEach(stream, (event: MirrorStreamEvent) =>
            event.type === "connected"
              ? Deferred.succeed(connectedSeen, undefined)
              : event.type === "directive" && event.directive.type === "link-revoked"
                ? Deferred.succeed(revokedSeen, undefined)
                : Effect.void,
          ).pipe(Effect.forkScoped);
          // The stream's acquire registers the connection lazily; revoking
          // before it lands would find no connection to notify.
          yield* Deferred.await(connectedSeen);

          yield* service.revokeLink(projectId);
          yield* Deferred.await(revokedSeen);

          const rows = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM mirror_sync_runtime WHERE project_id = ${projectId}
          `;
          expect(rows[0]?.count).toBe(0);
        }),
      30_000,
    );
  });
});
