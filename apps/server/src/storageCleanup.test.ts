import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ThreadId } from "@t3tools/contracts";

import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import {
  addWorktree,
  commitIn,
  initializeRepository,
  makeHarness,
  makeProject,
  projectId,
} from "./vcs/WorktreeService.testkit.ts";
import { makeThreadShell, NOW_MS } from "./vcs/worktreeThreadState.testkit.ts";

/** Storage cleanup over the real worktree service, removing worktrees idle for a week. */
const makeCleanupHarness = () => {
  const harness = makeHarness();
  const layer = Layer.mergeAll(
    ServerSettings.layerTest({ storageCleanup: { worktreeAfterDays: 7 } }),
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
  ).pipe(Layer.provideMerge(harness.layer));
  return { state: harness.state, layer };
};

/** An idle, unsettled thread last active thirty days ago. */
const staleThread = (worktreePath: string, name: string) =>
  makeThreadShell({
    id: ThreadId.make(`thread-${name}`),
    projectId,
    worktreePath,
    branch: `feature/${name}`,
  });

/** Starts cleanup and waits for the sweep it runs at startup to finish. */
const runStartupSweep = Effect.fn("StorageCleanupTest.runStartupSweep")(function* (
  state: ReturnType<typeof makeHarness>["state"],
) {
  const sweepStarted = yield* Deferred.make<void>();
  state.onThreadsRead = Deferred.succeed(sweepStarted, undefined);
  const cleanup = yield* StorageCleanup.make;
  yield* cleanup.start();
  yield* Deferred.await(sweepStarted);
  yield* cleanup.drain;
});

it.effect("removes a stale worktree through the worktree service and keeps its branch", () => {
  const { state, layer } = makeCleanupHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const git = yield* GitVcsDriver.GitVcsDriver;
    yield* TestClock.setTime(NOW_MS);
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const stale = yield* addWorktree(repositoryRoot, "stale");
    // Unpushed commits do not hold cleanup back: the branch keeps them.
    yield* commitIn(stale);
    const dirty = yield* addWorktree(repositoryRoot, "stale-dirty");
    yield* fs.writeFileString(`${dirty}/notes.txt`, "draft\n");
    state.threads = [staleThread(stale, "stale"), staleThread(dirty, "stale-dirty")];

    yield* runStartupSweep(state);

    assert.isFalse(yield* fs.exists(stale));
    assert.isTrue(yield* fs.exists(dirty));
    const branch = yield* git.execute({
      operation: "StorageCleanupTest.branchKept",
      cwd: repositoryRoot,
      args: ["show-ref", "--verify", "--quiet", "refs/heads/feature/stale"],
      allowNonZeroExit: true,
    });
    assert.equal(branch.exitCode, 0);
  }).pipe(Effect.provide(layer));
});

it.effect("stops removing worktrees once the rule is turned off during a sweep", () => {
  const { state, layer } = makeCleanupHarness();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const settings = yield* ServerSettings.ServerSettingsService;
    yield* TestClock.setTime(NOW_MS);
    const repositoryRoot = yield* initializeRepository();
    state.projects = [makeProject(repositoryRoot)];
    const first = yield* addWorktree(repositoryRoot, "first");
    const second = yield* addWorktree(repositoryRoot, "second");
    state.threads = [staleThread(first, "first"), staleThread(second, "second")];
    state.onRemoved = settings
      .updateSettings({ storageCleanup: { worktreeAfterDays: null } })
      .pipe(Effect.ignore);

    yield* runStartupSweep(state);

    assert.isFalse(yield* fs.exists(first));
    assert.isTrue(yield* fs.exists(second));
  }).pipe(Effect.provide(layer));
});
