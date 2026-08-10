// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { EnvironmentId, ProjectId, type MirrorStreamEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
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

const originEnvironmentId = EnvironmentId.make("origin-environment");

/**
 * Each test gets its own project id: the layer (and its in-memory SQLite
 * runtime table) is shared across every test in this file via `it.layer`,
 * so reusing one project id would leak a "sync watermark" recorded by an
 * earlier test's origin into a later test's brand-new origin repository.
 */
let projectCounter = 0;
function nextProjectId() {
  projectCounter += 1;
  return ProjectId.make(`mirror-submodule-test-project-${projectCounter}`);
}

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
  prefix: "t3-mirror-submodule-test-",
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

/** git-init a nested repo at `originRoot/relPath` and commit it as a gitlink. */
function addNestedRepo(input: {
  readonly originRoot: string;
  readonly relPath: string;
  readonly registerInGitmodules: boolean;
}) {
  return Effect.gen(function* () {
    const nestedDir = NodePath.join(input.originRoot, input.relPath);
    yield* write(NodePath.join(nestedDir, "lib.ts"), "export const nested = 1;\n");
    yield* git(nestedDir, ["init", "--initial-branch=main"]);
    yield* git(nestedDir, ["config", "user.email", "test@test.com"]);
    yield* git(nestedDir, ["config", "user.name", "Test"]);
    yield* git(nestedDir, ["config", "core.autocrlf", "false"]);
    yield* git(nestedDir, ["add", "."]);
    yield* git(nestedDir, ["commit", "-m", "nested initial"]);
    if (input.registerInGitmodules) {
      yield* write(
        NodePath.join(input.originRoot, ".gitmodules"),
        `[submodule "${input.relPath}"]\n\tpath = ${input.relPath}\n\turl = ../nested.git\n`,
      );
    }
    yield* git(input.originRoot, ["add", "-A", "--", input.relPath]);
    if (input.registerInGitmodules) {
      yield* git(input.originRoot, ["add", ".gitmodules"]);
    }
  });
}

/**
 * The origin side of the protocol, in-process: executes both top-level and
 * submodule directives against the origin repository exactly like
 * MirrorAgent does, with the signed-URL HTTP hop replaced by the host's own
 * staging path.
 */
function runFakeAgent(originRoot: string, projectId: ProjectId) {
  return Effect.gen(function* () {
    const service = yield* MirrorServiceModule.MirrorService;
    const transfer = yield* MirrorBundleTransfer.MirrorBundleTransfer;
    const gitSync = yield* GitSync.GitSync;
    const stream = yield* service.connect({ projectId, supportsSubmodules: true });

    const seedRoot = (root: string, syncId: string) =>
      Effect.gen(function* () {
        const bundlePath = yield* transfer.stagingPath(syncId);
        const snapshot = yield* gitSync.createSnapshot({ root, syncId });
        yield* gitSync.createSeedBundle({
          root,
          bundlePath,
          snapshotRef: GitSync.mirrorSnapshotRef(syncId),
        });
        return {
          headRef: yield* gitSync.symbolicHead(root),
          snapshotOid: snapshot.snapshotOid,
          remotes: yield* gitSync.listRemotes(root),
        };
      });

    const syncRoot = (root: string, syncId: string, baseSnapshotOid: string | null) =>
      Effect.gen(function* () {
        const bundlePath = yield* transfer.stagingPath(syncId);
        const snapshot = yield* gitSync.createSnapshot({ root, syncId });
        const baseTree =
          baseSnapshotOid === null ? null : yield* gitSync.treeOfCommit(root, baseSnapshotOid);
        if (baseTree !== null && baseTree === snapshot.treeOid) {
          return { noChange: true as const, snapshotOid: baseSnapshotOid ?? snapshot.snapshotOid };
        }
        yield* gitSync.createIncrementalBundle({
          root,
          bundlePath,
          baseOid: baseSnapshotOid ?? "",
          snapshotRef: GitSync.mirrorSnapshotRef(syncId),
          includeBranches: true,
        });
        return { noChange: false as const, snapshotOid: snapshot.snapshotOid };
      });

    const handle = (event: MirrorStreamEvent) =>
      Effect.gen(function* () {
        if (event.type !== "directive") return;
        const directive = event.directive;
        if (directive.type === "link-revoked") return;
        switch (directive.type) {
          case "seed-requested": {
            const result = yield* seedRoot(originRoot, directive.syncId);
            yield* service.respond({
              connectionId: event.connectionId,
              response: { type: "seed-uploaded", syncId: directive.syncId, ...result },
            });
            return;
          }
          case "sync-requested": {
            const result = yield* syncRoot(originRoot, directive.syncId, directive.baseSnapshotOid);
            yield* service.respond({
              connectionId: event.connectionId,
              response: result.noChange
                ? {
                    type: "sync-no-change",
                    syncId: directive.syncId,
                    snapshotOid: result.snapshotOid,
                  }
                : {
                    type: "sync-uploaded",
                    syncId: directive.syncId,
                    snapshotOid: result.snapshotOid,
                  },
            });
            return;
          }
          case "apply-requested": {
            const bundlePath = yield* transfer.stagingPath(directive.syncId);
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
          case "submodule-seed-requested":
          case "submodule-sync-requested":
          case "submodule-apply-requested": {
            const nestedRoot = NodePath.join(originRoot, directive.path);
            const isRepo = yield* gitSync
              .isRepository(nestedRoot)
              .pipe(Effect.orElseSucceed(() => false));
            if (!isRepo) {
              yield* service.respond({
                connectionId: event.connectionId,
                response: {
                  type: "submodule-skipped",
                  syncId: directive.syncId,
                  path: directive.path,
                  reason: "no-nested-repository",
                  detail: "No git repository found at this path on the origin machine.",
                },
              });
              return;
            }
            if (directive.type === "submodule-seed-requested") {
              const result = yield* seedRoot(nestedRoot, directive.syncId);
              yield* service.respond({
                connectionId: event.connectionId,
                response: {
                  type: "submodule-seed-uploaded",
                  syncId: directive.syncId,
                  path: directive.path,
                  ...result,
                },
              });
              return;
            }
            if (directive.type === "submodule-sync-requested") {
              const result = yield* syncRoot(
                nestedRoot,
                directive.syncId,
                directive.baseSnapshotOid,
              );
              yield* service.respond({
                connectionId: event.connectionId,
                response: result.noChange
                  ? {
                      type: "submodule-sync-no-change",
                      syncId: directive.syncId,
                      path: directive.path,
                      snapshotOid: result.snapshotOid,
                    }
                  : {
                      type: "submodule-sync-uploaded",
                      syncId: directive.syncId,
                      path: directive.path,
                      snapshotOid: result.snapshotOid,
                    },
              });
              return;
            }
            const bundlePath = yield* transfer.stagingPath(directive.syncId);
            yield* gitSync.fetchBundle({
              root: nestedRoot,
              bundlePath,
              refspecs: [
                "+refs/t3/mirror/snapshots/*:refs/t3/mirror/snapshots/*",
                "+refs/heads/*:refs/t3/mirror/incoming/*",
              ],
            });
            const apply = yield* gitSync.applySnapshot({
              root: nestedRoot,
              syncId: directive.syncId,
              baseOid: directive.baseSnapshotOid,
              targetOid: directive.targetSnapshotOid,
              conflictPreference: "local",
            });
            yield* service.respond({
              connectionId: event.connectionId,
              response: {
                type: "submodule-apply-result",
                syncId: directive.syncId,
                path: directive.path,
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

it.layer(TestLayer)("MirrorService submodules", (it) => {
  describe("gitlink cascade", () => {
    it.effect(
      "seeds a registered submodule with real content, not an empty directory",
      () =>
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 43 });
          const projectId = nextProjectId();
          const fileSystem = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const service = yield* MirrorServiceModule.MirrorService;

          const originRoot = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "mirror-submodule-origin-" })
            .pipe(Effect.flatMap((dir) => fileSystem.realPath(dir)));
          yield* git(originRoot, ["init", "--initial-branch=main"]);
          yield* git(originRoot, ["config", "user.email", "test@test.com"]);
          yield* git(originRoot, ["config", "user.name", "Test"]);
          yield* git(originRoot, ["config", "core.autocrlf", "false"]);
          yield* write(NodePath.join(originRoot, "app.ts"), "top level\n");
          yield* git(originRoot, ["add", "app.ts"]);
          yield* addNestedRepo({
            originRoot,
            relPath: "vendor/lib",
            registerInGitmodules: true,
          });
          yield* git(originRoot, ["commit", "-m", "initial with registered submodule"]);

          const mirrorRoot = NodePath.join(config.mirrorsDir, projectId);
          yield* fileSystem.makeDirectory(mirrorRoot, { recursive: true });
          projectBox.current = {
            projectId,
            title: "Mirrored",
            workspaceRoot: mirrorRoot,
            origin: { environmentId: originEnvironmentId, rootPath: originRoot, label: "Laptop" },
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            mirrorIncludeIgnoredFiles: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          };

          yield* runFakeAgent(originRoot, projectId);
          yield* service.ensureFresh(projectId);

          expect(yield* read(NodePath.join(mirrorRoot, "app.ts"))).toBe("top level\n");
          expect(yield* read(NodePath.join(mirrorRoot, "vendor/lib/lib.ts"))).toBe(
            "export const nested = 1;\n",
          );
        }),
      120_000,
    );

    it.effect(
      "seeds a dangling gitlink with no .gitmodules entry the same way",
      () =>
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 43 });
          const projectId = nextProjectId();
          const fileSystem = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const service = yield* MirrorServiceModule.MirrorService;

          const originRoot = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "mirror-submodule-origin-" })
            .pipe(Effect.flatMap((dir) => fileSystem.realPath(dir)));
          yield* git(originRoot, ["init", "--initial-branch=main"]);
          yield* git(originRoot, ["config", "user.email", "test@test.com"]);
          yield* git(originRoot, ["config", "user.name", "Test"]);
          yield* git(originRoot, ["config", "core.autocrlf", "false"]);
          yield* write(NodePath.join(originRoot, "app.ts"), "top level\n");
          yield* git(originRoot, ["add", "app.ts"]);
          yield* addNestedRepo({
            originRoot,
            relPath: "vendor/dangling",
            registerInGitmodules: false,
          });
          yield* git(originRoot, ["commit", "-m", "initial with dangling gitlink"]);

          const mirrorRoot = NodePath.join(config.mirrorsDir, projectId);
          yield* fileSystem.makeDirectory(mirrorRoot, { recursive: true });
          projectBox.current = {
            projectId,
            title: "Mirrored",
            workspaceRoot: mirrorRoot,
            origin: { environmentId: originEnvironmentId, rootPath: originRoot, label: "Laptop" },
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            mirrorIncludeIgnoredFiles: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          };

          yield* runFakeAgent(originRoot, projectId);
          yield* service.ensureFresh(projectId);

          expect(yield* read(NodePath.join(mirrorRoot, "vendor/dangling/lib.ts"))).toBe(
            "export const nested = 1;\n",
          );
        }),
      120_000,
    );

    it.effect(
      "propagates a new commit inside the submodule without clobbering mirror-side content placed in it",
      () =>
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 43 });
          const projectId = nextProjectId();
          const fileSystem = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const service = yield* MirrorServiceModule.MirrorService;

          const originRoot = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "mirror-submodule-origin-" })
            .pipe(Effect.flatMap((dir) => fileSystem.realPath(dir)));
          yield* git(originRoot, ["init", "--initial-branch=main"]);
          yield* git(originRoot, ["config", "user.email", "test@test.com"]);
          yield* git(originRoot, ["config", "user.name", "Test"]);
          yield* git(originRoot, ["config", "core.autocrlf", "false"]);
          yield* write(NodePath.join(originRoot, "app.ts"), "top level\n");
          yield* git(originRoot, ["add", "app.ts"]);
          yield* addNestedRepo({
            originRoot,
            relPath: "vendor/lib",
            registerInGitmodules: true,
          });
          yield* git(originRoot, ["commit", "-m", "initial"]);

          const mirrorRoot = NodePath.join(config.mirrorsDir, projectId);
          yield* fileSystem.makeDirectory(mirrorRoot, { recursive: true });
          projectBox.current = {
            projectId,
            title: "Mirrored",
            workspaceRoot: mirrorRoot,
            origin: { environmentId: originEnvironmentId, rootPath: originRoot, label: "Laptop" },
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            mirrorIncludeIgnoredFiles: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          };

          yield* runFakeAgent(originRoot, projectId);
          yield* service.ensureFresh(projectId);
          expect(yield* read(NodePath.join(mirrorRoot, "vendor/lib/lib.ts"))).toBe(
            "export const nested = 1;\n",
          );

          // Regression guard: a marker placed directly inside the mirror's
          // submodule directory must survive the top-level applySnapshot on
          // the next sync — the superproject transform must never touch
          // gitlink path contents.
          yield* write(NodePath.join(mirrorRoot, "vendor/lib/marker.txt"), "left by the host\n");

          const nestedDir = NodePath.join(originRoot, "vendor/lib");
          yield* write(NodePath.join(nestedDir, "lib.ts"), "export const nested = 2;\n");
          yield* git(nestedDir, ["add", "."]);
          yield* git(nestedDir, ["commit", "-m", "nested update"]);
          yield* git(originRoot, ["add", "-A", "--", "vendor/lib"]);
          yield* git(originRoot, ["commit", "-m", "bump nested gitlink"]);

          yield* service.ensureFresh(projectId);

          expect(yield* read(NodePath.join(mirrorRoot, "vendor/lib/lib.ts"))).toBe(
            "export const nested = 2;\n",
          );
          expect(yield* read(NodePath.join(mirrorRoot, "vendor/lib/marker.txt"))).toBe(
            "left by the host\n",
          );
        }),
      120_000,
    );

    it.effect(
      "a gitlink with no nested repo on the origin is skipped with a warning; the rest of the sync completes",
      () =>
        Effect.gen(function* () {
          yield* runMigrations({ toMigrationInclusive: 43 });
          const projectId = nextProjectId();
          const fileSystem = yield* FileSystem.FileSystem;
          const config = yield* ServerConfig.ServerConfig;
          const service = yield* MirrorServiceModule.MirrorService;

          const originRoot = yield* fileSystem
            .makeTempDirectoryScoped({ prefix: "mirror-submodule-origin-" })
            .pipe(Effect.flatMap((dir) => fileSystem.realPath(dir)));
          yield* git(originRoot, ["init", "--initial-branch=main"]);
          yield* git(originRoot, ["config", "user.email", "test@test.com"]);
          yield* git(originRoot, ["config", "user.name", "Test"]);
          yield* git(originRoot, ["config", "core.autocrlf", "false"]);
          yield* write(NodePath.join(originRoot, "app.ts"), "top level\n");
          yield* git(originRoot, ["add", "app.ts"]);
          // A gitlink whose path is a plain directory on the origin disk:
          // no nested .git exists anywhere, so `isRepository` will be false.
          const fakeOid = "d".repeat(40);
          yield* fileSystem.makeDirectory(NodePath.join(originRoot, "vendor/missing"), {
            recursive: true,
          });
          const runner = yield* ProcessRunner.ProcessRunner;
          yield* runner.run({
            command: "git",
            args: ["update-index", "--add", "--cacheinfo", `160000,${fakeOid},vendor/missing`],
            cwd: originRoot,
            timeout: "30 seconds",
          });
          yield* git(originRoot, ["commit", "-m", "initial with a gitlink pointing at nothing"]);

          const mirrorRoot = NodePath.join(config.mirrorsDir, projectId);
          yield* fileSystem.makeDirectory(mirrorRoot, { recursive: true });
          projectBox.current = {
            projectId,
            title: "Mirrored",
            workspaceRoot: mirrorRoot,
            origin: { environmentId: originEnvironmentId, rootPath: originRoot, label: "Laptop" },
            defaultModelSelection: null,
            defaultThreadEnvMode: null,
            mirrorIncludeIgnoredFiles: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          };

          yield* runFakeAgent(originRoot, projectId);
          // The overall sync must not fail even though the gitlink cannot be
          // materialized.
          yield* service.ensureFresh(projectId);
          expect(yield* read(NodePath.join(mirrorRoot, "app.ts"))).toBe("top level\n");

          // The missing submodule surfaces as a warning on the project's
          // status, not as a conflict or failure state.
          const statusStream = yield* service.statusStream(projectId);
          const status = yield* Stream.runHead(statusStream);
          expect(Option.isSome(status)).toBe(true);
          if (Option.isSome(status)) {
            expect(status.value.state).not.toBe("conflict");
            expect(status.value.submoduleWarnings.some((w) => w.path === "vendor/missing")).toBe(
              true,
            );
          }
        }),
      120_000,
    );
  });
});
