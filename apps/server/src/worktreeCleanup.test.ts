import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "./config.ts";
import { GitWorkflowService } from "./git/GitWorkflowService.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "./project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "./serverSettings.ts";
import { TerminalManager } from "./terminal/Manager.ts";
import { GitVcsDriver } from "./vcs/GitVcsDriver.ts";
import {
  artifactDirectoryNamesForEntries,
  groupManagedWorktrees,
  WorktreeCleanup,
  layer as worktreeCleanupLayer,
} from "./worktreeCleanup.ts";

const projectId = ProjectId.make("project-1");

const project: OrchestrationProjectShell = {
  id: projectId,
  title: "T3 Code",
  workspaceRoot: "/projects/t3code",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function thread(input: {
  readonly id: string;
  readonly worktreePath: string | null;
  readonly updatedAt: string;
}): OrchestrationThreadShell {
  return {
    id: ThreadId.make(input.id),
    projectId,
    title: input.id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/storage-cleanup",
    worktreePath: input.worktreePath,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: input.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: input.updatedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

it("uses the newest thread update for a shared worktree", () => {
  const groups = groupManagedWorktrees({
    projects: [project],
    threads: [
      thread({
        id: "older-thread",
        worktreePath: "/worktrees/shared",
        updatedAt: "2026-08-02T00:00:00.000Z",
      }),
      thread({
        id: "newer-thread",
        worktreePath: "/worktrees/shared",
        updatedAt: "2026-08-05T00:00:00.000Z",
      }),
      thread({
        id: "main-checkout-thread",
        worktreePath: null,
        updatedAt: "2026-08-10T00:00:00.000Z",
      }),
    ],
  });

  expect(groups).toHaveLength(1);
  expect(groups[0]?.lastUpdatedAt).toBe("2026-08-05T00:00:00.000Z");
  expect(groups[0]?.threads).toHaveLength(2);
});

it("matches generated directories only when their ecosystem marker is present", () => {
  expect(
    artifactDirectoryNamesForEntries(["package.json", "node_modules", ".next", ".turbo"]),
  ).toEqual(["node_modules", ".next", ".turbo"]);
  expect(artifactDirectoryNamesForEntries(["Cargo.toml", "target", "vendor"])).toEqual([
    "target",
    "vendor",
  ]);
  expect(artifactDirectoryNamesForEntries(["composer.json", "vendor"])).toEqual(["vendor"]);
});

it("does not treat a Go vendor directory as disposable", () => {
  expect(artifactDirectoryNamesForEntries(["go.mod", "vendor"])).toEqual([]);
});

it.effect("prunes ignored generated artifacts while preserving Go vendor", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-worktree-cleanup-test-",
    });
    const worktreePath = path.join(baseDir, "worktrees", "project-1", "feature");
    yield* Effect.all(
      [
        ["package.json", "{}"],
        ["node_modules/package/index.js", "generated"],
        [".next/cache/data", "generated"],
        ["go.mod", "module example.test/project"],
        ["vendor/example.test/dependency/source.go", "package dependency"],
      ].map(([relativePath, contents]) => {
        const filePath = path.join(worktreePath, relativePath ?? "");
        return fileSystem
          .makeDirectory(path.dirname(filePath), { recursive: true })
          .pipe(Effect.andThen(fileSystem.writeFileString(filePath, contents ?? "")));
      }),
      { concurrency: "unbounded" },
    );

    const activeProject = { ...project, workspaceRoot: baseDir };
    const activeThread = thread({
      id: "inactive-thread",
      worktreePath,
      updatedAt: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 3 })),
    });
    const snapshot = {
      snapshotSequence: 1,
      projects: [activeProject],
      threads: [activeThread],
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    const emptySnapshot = { ...snapshot, projects: [], threads: [] };
    const success = {
      exitCode: ChildProcessSpawner.ExitCode(0),
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    const dependencies = Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
      ServerSettings.layerTest({ worktreeCleanupAfterDays: 2 }),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed(snapshot),
        getArchivedShellSnapshot: () => Effect.succeed(emptySnapshot),
      }),
      Layer.mock(TerminalManager)({ listMetadata: () => Effect.succeed([]) }),
      Layer.mock(GitVcsDriver)({ execute: () => Effect.succeed(success) }),
      Layer.mock(GitWorkflowService)({}),
      Layer.mock(ProjectSetupScriptRunner)({}),
      NodeServices.layer,
    );

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeCleanup;
      yield* cleanup.runNow;
      expect(yield* fileSystem.exists(path.join(worktreePath, "node_modules"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".next"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, "vendor"))).toBe(true);
    }).pipe(Effect.provide(worktreeCleanupLayer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("keeps an inactive worktree and reports commits missing from its upstream", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-worktree-cleanup-unpushed-test-",
    });
    const worktreePath = path.join(baseDir, "worktrees", "project-1", "feature");
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });

    const activeProject = { ...project, workspaceRoot: baseDir };
    const activeThread = thread({
      id: "unpushed-thread",
      worktreePath,
      updatedAt: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 8 })),
    });
    const snapshot = {
      snapshotSequence: 1,
      projects: [activeProject],
      threads: [activeThread],
      updatedAt: activeThread.updatedAt,
    };
    const emptySnapshot = { ...snapshot, projects: [], threads: [] };
    const gitResult = (stdout = "", exitCode = 0) => ({
      exitCode: ChildProcessSpawner.ExitCode(exitCode),
      stdout,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    const dependencies = Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
      ServerSettings.layerTest({ worktreeCleanupAfterDays: 2 }),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed(snapshot),
        getArchivedShellSnapshot: () => Effect.succeed(emptySnapshot),
      }),
      Layer.mock(TerminalManager)({ listMetadata: () => Effect.succeed([]) }),
      Layer.mock(GitVcsDriver)({
        execute: (input) => {
          switch (input.operation) {
            case "WorktreeCleanup.upstreamRemote":
              return Effect.succeed(gitResult("origin\n"));
            case "WorktreeCleanup.upstreamMergeRef":
              return Effect.succeed(gitResult("refs/heads/feat/storage-cleanup\n"));
            case "WorktreeCleanup.verifyPushedHead":
              return Effect.succeed(gitResult("", 1));
            default:
              return Effect.succeed(gitResult());
          }
        },
        fetchRemoteTrackingBranch: () => Effect.void,
        statusDetailsRemote: () =>
          Effect.succeed({
            isRepo: true,
            isDefaultBranch: false,
            branch: "feat/storage-cleanup",
            upstreamRef: "origin/feat/storage-cleanup",
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 1,
          }),
      }),
      Layer.mock(GitWorkflowService)({
        removeWorktree: () => Effect.die("unsafe removal was attempted"),
      }),
      Layer.mock(ProjectSetupScriptRunner)({}),
      NodeServices.layer,
    );

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeCleanup;
      yield* cleanup.runNow;
      expect(yield* fileSystem.exists(worktreePath)).toBe(true);
      expect(yield* cleanup.notices).toEqual([
        expect.objectContaining({
          worktreePath,
          branch: "feat/storage-cleanup",
          reason: "unpushed-commits",
        }),
      ]);
    }).pipe(Effect.provide(worktreeCleanupLayer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
