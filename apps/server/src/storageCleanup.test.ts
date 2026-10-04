// @effect-diagnostics nodeBuiltinImport:off - Effect's FileSystem cannot create junctions.
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { describe, expect } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import {
  storageCleanupActivityAt,
  storageCleanupKeepsUntrackedFiles,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

const NOW_MS = Date.parse("2026-06-10T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

function at(offsetMs: number): DateTime.Utc {
  return DateTime.makeUnsafe(NOW_MS + offsetMs);
}

function shell(overrides: Partial<OrchestrationV2ThreadShell> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: ThreadId.make("thread-1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "idle",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(-30 * DAY_MS),
    updatedAt: at(-10 * DAY_MS),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
}

describe("V2 storage cleanup eligibility", () => {
  const candidate = () => shell({ branch: "feature", worktreePath: "/worktrees/feature" });

  it("allows an idle worktree and rejects the project checkout", () => {
    expect(storageCleanupThreadIdle(candidate(), NOW_MS)).toBe(true);
    expect(storageCleanupThreadIdle(shell(), NOW_MS)).toBe(false);
  });

  it.each(["running", "starting", "preparing", "waiting", "queued"] as const)(
    "retains a worktree while its thread is %s",
    (status) => {
      expect(storageCleanupThreadIdle(candidateWithStatus(status), NOW_MS)).toBe(false);
    },
  );

  it("retains an active run even if the shell status is idle", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), activeRunId: RunId.make("run") }, NOW_MS),
    ).toBe(false);
  });

  it("retains a queued prompt before the new run has been projected", () => {
    expect(
      storageCleanupThreadIdle({ ...candidate(), latestUserMessageAt: at(-1_000) }, NOW_MS),
    ).toBe(false);
  });

  it("uses V2 run activity instead of metadata refreshes for retention", () => {
    const thread = candidate();
    const runTime = at(-3 * DAY_MS);
    expect(
      storageCleanupActivityAt({ ...thread, latestRunCompletedAt: runTime, updatedAt: at(0) }),
    ).toBe(DateTime.toEpochMillis(runTime));
  });

  function candidateWithStatus(status: OrchestrationV2ThreadShell["status"]) {
    return { ...candidate(), status };
  }
});

const GitLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-storage-cleanup-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const makeRepo = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "storage-cleanup-repo-" });
    const write = (relativePath: string, contents: string) =>
      fs
        .makeDirectory(path.dirname(path.join(cwd, relativePath)), { recursive: true })
        .pipe(Effect.andThen(fs.writeFileString(path.join(cwd, relativePath), contents)));
    yield* git.initRepo({ cwd });
    yield* write(".gitignore", "node_modules/\nbuild/\n.dart_tool/\n*.env\nlinked\n");
    yield* git.execute({ operation: "test.add", cwd, args: ["add", ".gitignore"] });
    yield* git.execute({
      operation: "test.commit",
      cwd,
      args: ["-c", "user.name=Test", "-c", "user.email=test@test.com", "commit", "-m", "init"],
    });
    for (const [relativePath, contents] of Object.entries(files))
      yield* write(relativePath, contents);
    return cwd;
  });

it.layer(GitLayer)("storage cleanup ignored files", (it) => {
  const flutterBuild = {
    "build/app/output.apk": "apk",
    ".dart_tool/package_config.json": "{}",
    "node_modules/pkg/index.js": "",
    // An untracked package left with only its dependency install.
    "packages/removed/node_modules/pkg/index.js": "",
  };

  it.effect("keeps a worktree whose ignored files are not disposable", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo(flutterBuild);
      expect(yield* storageCleanupKeepsUntrackedFiles(cwd, ["node_modules/"])).toBe(true);
      expect(yield* storageCleanupKeepsUntrackedFiles(cwd, [])).toBe(true);
    }),
  );

  it.effect("removes a worktree whose ignored files all match disposable patterns", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo(flutterBuild);
      expect(
        yield* storageCleanupKeepsUntrackedFiles(cwd, ["node_modules/", "build/", ".dart_tool/"]),
      ).toBe(false);
    }),
  );

  it.effect("keeps unknown ignored files next to disposable ones", () =>
    Effect.gen(function* () {
      const cwd = yield* makeRepo({ ...flutterBuild, "packages/removed/local.env": "TOKEN=1" });
      expect(
        yield* storageCleanupKeepsUntrackedFiles(cwd, ["node_modules/", "build/", ".dart_tool/"]),
      ).toBe(true);
    }),
  );

  it.effect("keeps untracked files that status is configured to hide", () =>
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeRepo({ "notes.txt": "draft" });
      yield* git.execute({
        operation: "test.config",
        cwd,
        args: ["config", "status.showUntrackedFiles", "no"],
      });
      expect((yield* git.statusDetailsLocal(cwd)).hasWorkingTreeChanges).toBe(false);
      expect(yield* storageCleanupKeepsUntrackedFiles(cwd, ["node_modules/"])).toBe(true);
    }),
  );

  it.effect("never lets an ignored link keep a worktree", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* makeRepo({ "node_modules/pkg/index.js": "" });
      const target = yield* fs.makeTempDirectoryScoped({ prefix: "storage-cleanup-target-" });
      yield* fs.writeFileString(path.join(target, "secret.env"), "TOKEN=1");
      NodeFS.symlinkSync(target, path.join(cwd, "linked"), "junction");
      NodeFS.mkdirSync(path.join(cwd, "infra"));
      NodeFS.symlinkSync(target, path.join(cwd, "infra", "linked"), "junction");
      expect(yield* storageCleanupKeepsUntrackedFiles(cwd, ["node_modules/"])).toBe(false);

      yield* fs.makeDirectory(path.join(cwd, "build"));
      yield* fs.writeFileString(path.join(cwd, "build", "output.bin"), "");
      expect(yield* storageCleanupKeepsUntrackedFiles(cwd, ["node_modules/"])).toBe(true);
    }),
  );
});
