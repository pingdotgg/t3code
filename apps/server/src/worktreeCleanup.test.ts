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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
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
  artifactFileNamesForEntries,
  groupManagedWorktrees,
  WorktreeCleanup,
  layer as worktreeCleanupLayer,
} from "./worktreeCleanup.ts";

const projectId = ProjectId.make("project-1");
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

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
  readonly branch?: string;
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
    branch: input.branch ?? "feat/storage-cleanup",
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

it("matches common ignored build outputs without matching local state", () => {
  expect(
    artifactDirectoryNamesForEntries([
      "package.json",
      "dist",
      ".output",
      ".wxt",
      ".tanstack",
      ".vite-hooks",
      "release",
      "logs",
      ".t3",
    ]),
  ).toEqual(["dist", ".output", ".wxt", ".tanstack", ".vite-hooks", "release", "logs"]);
  expect(
    artifactFileNamesForEntries([
      "package.json",
      "tsconfig.json",
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
      ".env",
      "local.properties",
    ]),
  ).toEqual(["next-env.d.ts", "tsconfig.tsbuildinfo"]);
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
        ["tsconfig.json", "{}"],
        ["build.gradle.kts", ""],
        ["node_modules/package/index.js", "generated"],
        [".next/cache/data", "generated"],
        ["dist/index.js", "generated"],
        ["dist-electron/index.js", "generated"],
        [".output/server/index.js", "generated"],
        [".wxt/cache.json", "generated"],
        [".tanstack/cache.json", "generated"],
        [".vite-hooks/_/pre-commit", "generated"],
        ["release/app.dmg", "generated"],
        ["logs/server.log", "generated"],
        [".kotlin/cache/data", "generated"],
        ["next-env.d.ts", "generated"],
        ["tsconfig.tsbuildinfo", "generated"],
        ["go.mod", "module example.test/project"],
        ["vendor/example.test/dependency/source.go", "package dependency"],
        [".t3/userdata/state.sqlite", "local state"],
        [".env", "local state"],
        ["local.properties", "local state"],
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
      Layer.mock(GitVcsDriver)({
        execute: (input) => {
          if (
            input.operation === "WorktreeCleanup.checkIgnoredArtifact" &&
            input.args.at(-1) === ".vite-hooks"
          ) {
            return Effect.succeed({
              ...success,
              exitCode: ChildProcessSpawner.ExitCode(1),
            });
          }
          if (input.operation === "WorktreeCleanup.checkIgnoredArtifactContents") {
            return Effect.succeed({
              ...success,
              stdout: "!! .vite-hooks/_/pre-commit\0",
            });
          }
          if (
            input.operation === "WorktreeCleanup.checkTrackedArtifactContents" &&
            input.args.at(-1) === "release"
          ) {
            return Effect.succeed({ ...success, stdout: "release/app.dmg\n" });
          }
          return Effect.succeed(success);
        },
      }),
      Layer.mock(GitWorkflowService)({}),
      Layer.mock(ProjectSetupScriptRunner)({}),
      NodeServices.layer,
    );

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeCleanup;
      yield* cleanup.runNow;
      expect(yield* fileSystem.exists(path.join(worktreePath, "node_modules"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".next"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, "dist"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, "dist-electron"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".output"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".wxt"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".tanstack"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".vite-hooks"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, "release"))).toBe(true);
      expect(yield* fileSystem.exists(path.join(worktreePath, "logs"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".kotlin"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, "next-env.d.ts"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, "tsconfig.tsbuildinfo"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(worktreePath, "vendor"))).toBe(true);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".t3"))).toBe(true);
      expect(yield* fileSystem.exists(path.join(worktreePath, ".env"))).toBe(true);
      expect(yield* fileSystem.exists(path.join(worktreePath, "local.properties"))).toBe(true);
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
            defaultBranch: "main",
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

it.effect("retires a clean worktree when the remote default branch contains HEAD", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-worktree-cleanup-default-branch-test-",
    });
    const worktreePath = path.join(baseDir, "worktrees", "project-1", "feature");
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });

    const removed = yield* Ref.make(false);
    const fetchedDefaultBranch = yield* Ref.make(false);
    const activeProject = { ...project, workspaceRoot: baseDir };
    const activeThread = thread({
      id: "merged-thread",
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
        execute: () => Effect.succeed(gitResult()),
        fetchRemoteTrackingBranch: (input) =>
          Ref.set(
            fetchedDefaultBranch,
            input.remoteName === "origin" && input.remoteBranch === "main",
          ),
        statusDetailsRemote: () =>
          Effect.succeed({
            isRepo: true,
            defaultBranch: "main",
            isDefaultBranch: false,
            branch: "feat/storage-cleanup",
            upstreamRef: null,
            hasUpstream: false,
            aheadCount: 1,
            behindCount: 0,
            aheadOfDefaultCount: 1,
          }),
      }),
      Layer.mock(GitWorkflowService)({
        removeWorktree: () => Ref.set(removed, true),
      }),
      Layer.mock(ProjectSetupScriptRunner)({}),
      NodeServices.layer,
    );

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeCleanup;
      yield* cleanup.runNow;
      expect(yield* Ref.get(fetchedDefaultBranch)).toBe(true);
      expect(yield* Ref.get(removed)).toBe(true);
      expect(yield* cleanup.notices).toEqual([]);
    }).pipe(Effect.provide(worktreeCleanupLayer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("refreshes a persisted notice branch without resetting its creation time", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-worktree-cleanup-notice-test-",
    });
    const worktreePath = path.join(baseDir, "worktrees", "project-1", "feature");
    const statePath = path.join(baseDir, "userdata", "worktree-cleanup.json");
    yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
    yield* fileSystem.makeDirectory(path.dirname(statePath), { recursive: true });
    const encodedState = yield* encodeUnknownJson({
      version: 1,
      entries: [],
      notices: [
        {
          id: `local-files:${worktreePath}`,
          worktreePath,
          projectTitle: "T3 Code",
          branch: "t3code/old-name",
          reason: "local-files",
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    yield* fileSystem.writeFileString(statePath, encodedState);

    const activeProject = { ...project, workspaceRoot: baseDir };
    const activeThread = thread({
      id: "renamed-thread",
      worktreePath,
      branch: "fix/current-name",
      updatedAt: DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 8 })),
    });
    const snapshot = {
      snapshotSequence: 1,
      projects: [activeProject],
      threads: [activeThread],
      updatedAt: activeThread.updatedAt,
    };
    const emptySnapshot = { ...snapshot, projects: [], threads: [] };
    const gitResult = (stdout = "") => ({
      exitCode: ChildProcessSpawner.ExitCode(0),
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
        execute: (input) =>
          Effect.succeed(
            input.operation === "WorktreeCleanup.retirementStatus"
              ? gitResult("!! .env\0")
              : gitResult(),
          ),
      }),
      Layer.mock(GitWorkflowService)({}),
      Layer.mock(ProjectSetupScriptRunner)({}),
      NodeServices.layer,
    );

    yield* Effect.gen(function* () {
      const cleanup = yield* WorktreeCleanup;
      yield* cleanup.runNow;
      expect(yield* cleanup.notices).toEqual([
        expect.objectContaining({
          branch: "fix/current-name",
          createdAt: "2026-08-01T00:00:00.000Z",
          reason: "local-files",
        }),
      ]);
    }).pipe(Effect.provide(worktreeCleanupLayer.pipe(Layer.provide(dependencies))));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
