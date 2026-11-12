import { SourceControlProviderKind } from "@t3tools/contracts";
import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Scheduler from "effect/Scheduler";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import type {
  BackgroundScope,
  VcsBranchStatus,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { GitCommandError, GitManagerError } from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

const remoteStatusWithPr: VcsStatusRemoteResult = {
  ...baseRemoteStatus,
  pr: {
    number: 2978,
    title: "[codex] Rewrite client connection architecture",
    url: "https://github.com/pingdotgg/t3code/pull/2978",
    baseRef: "main",
    headRef: "upstream-topic",
    state: "open",
  },
};

function layerTestFor(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  remoteStatusError?: GitManagerError;
  backgroundWorkEnabled?: boolean;
  automaticFetchInterval?: Effect.Effect<Duration.Duration>;
  beforeRemoteStatus?: Effect.Effect<void>;
  beforeLocalStatus?: Effect.Effect<void>;
  beforeCurrentBranch?: Effect.Effect<void>;
  beforeInvalidate?: Effect.Effect<void>;
  branchRead?: () => Effect.Effect<string | null>;
  fileSystem?: FileSystem.FileSystem;
  pullCurrentBranch?: GitWorkflowService.GitWorkflowService["Service"]["pullCurrentBranch"];
  headPath?: string;
  headPathCalls?: number;
  failLocalStatus?: boolean;
  onLocalStatusFailure?: Effect.Effect<void>;
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(
      state.fileSystem
        ? Layer.merge(Layer.succeed(FileSystem.FileSystem, state.fileSystem), Path.layer)
        : NodeServices.layer,
    ),
    Layer.provide(layerBackgroundPolicy(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.succeed(
        VcsStatusBroadcaster.VcsAutomaticFetchInterval,
        state.automaticFetchInterval ?? Effect.succeed(Duration.seconds(30)),
      ),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.suspend(() => {
            state.localStatusCalls += 1;
            if (state.failLocalStatus) {
              return (state.onLocalStatusFailure ?? Effect.void).pipe(
                Effect.andThen(
                  Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "index.lock is held",
                    }),
                  ),
                ),
              );
            }
            return (state.beforeLocalStatus ?? Effect.void).pipe(
              Effect.as(state.currentLocalStatus),
            );
          }),
        repositoryRoot: () => Effect.sync(() => (state.currentLocalStatus.isRepo ? "/repo" : null)),
        currentBranch: () =>
          state.branchRead
            ? state.branchRead()
            : (state.beforeCurrentBranch ?? Effect.void).pipe(
                Effect.andThen(Effect.sync(() => state.currentLocalStatus.refName)),
              ),
        remoteStatus: (_input, options) =>
          Effect.suspend(() => {
            return (state.beforeRemoteStatus ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  state.remoteStatusCalls += 1;
                  state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
                  return state.currentRemoteStatus;
                }),
              ),
              Effect.tap(() =>
                state.remoteStatusError ? Effect.fail(state.remoteStatusError) : Effect.void,
              ),
            );
          }),
        invalidateLocalStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
          }).pipe(Effect.andThen(state.beforeInvalidate ?? Effect.void)),
        invalidateRemoteStatus: () =>
          Effect.sync(() => {
            state.remoteInvalidationCalls += 1;
          }),
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
        ...(state.pullCurrentBranch ? { pullCurrentBranch: state.pullCurrentBranch } : {}),
        headPath: () =>
          Effect.sync(() => {
            state.headPathCalls = (state.headPathCalls ?? 0) + 1;
            return state.headPath ?? null;
          }),
      }),
    ),
  );
}

function layerBackgroundPolicy(shouldRunScopeWork: (scope: BackgroundScope) => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    snapshot: Effect.succeed({
      hostPower: {
        source: "unknown",
        idle: "unknown",
        idleSeconds: null,
        locked: "unknown",
        suspended: false,
        onBattery: "unknown",
        lowPowerMode: "unknown",
        thermalState: "unknown",
        stale: true,
        updatedAt: TEST_EPOCH,
      },
      leases: [],
      activeForegroundLeaseCount: 0,
      activeScopeKeys: [],
      shouldRunOpportunisticWork: false,
      updatedAt: TEST_EPOCH,
    }),
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
    shouldRunOpportunisticWork: Effect.succeed(true),
  });
}

describe("VcsStatusBroadcaster", () => {
  it.effect("refreshes queued behind a running one share the next git status read", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeLocalStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const running = yield* broadcaster
        .refreshLocalStatus("/repo")
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.await(started);
      // Requested while the first read runs, so that read may predate their change.
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const queued = yield* Effect.all(
        [broadcaster.refreshLocalStatus("/repo"), broadcaster.refreshLocalStatus("/repo")],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);

      assert.isFalse((yield* Fiber.join(running)).hasWorkingTreeChanges);
      const [second, third] = yield* Fiber.join(queued);
      assert.isTrue(second.hasWorkingTreeChanges);
      assert.isTrue(third.hasWorkingTreeChanges);
      assert.strictEqual(state.localStatusCalls, 2);

      yield* broadcaster.refreshLocalStatus("/repo");
      assert.strictEqual(state.localStatusCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect(
    "streams fresh branch-only reads, detached HEAD, non-repositories, and detailed demand without mixing results",
    () => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({
          realPath: (cwd) => Effect.succeed(cwd === "/alias" ? "/repo" : cwd),
        }),
      };
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
        assert.deepEqual(yield* branches, [{ refName: baseLocalStatus.refName, isRepo: true }]);
        assert.equal(state.localStatusCalls, 0);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "external" };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* branches, [{ refName: "external", isRepo: true }]);
        state.currentLocalStatus = { ...baseLocalStatus, refName: null };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* branches, [{ refName: null, isRepo: true }]);
        state.currentLocalStatus = { ...baseLocalStatus, isRepo: false, refName: null };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* branches, [{ refName: null, isRepo: false }]);
        assert.equal(state.localStatusCalls, 0);
        const detailScope = yield* Scope.make();
        const details = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        ).pipe(Scope.provide(detailScope));
        assert.deepEqual(yield* details, [
          { _tag: "snapshot", local: state.currentLocalStatus, remote: null },
        ]);
        const callsWithDetail = state.localStatusCalls;
        const extraBranches = yield* Stream.toPull(
          broadcaster.streamBranchStatus({ cwd: "/repo" }),
        );
        yield* extraBranches;
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.equal(state.localStatusCalls, callsWithDetail);
        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "changed",
          workingTree: { files: [], insertions: 12, deletions: 3 },
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* details, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        assert.deepEqual(yield* branches, [{ refName: "changed", isRepo: true }]);
        const secondScope = yield* Scope.make();
        const secondDetails = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/alias", includeRemote: false }),
        ).pipe(Scope.provide(secondScope));
        yield* secondDetails;
        yield* Scope.close(detailScope, Exit.void);
        state.currentLocalStatus = {
          ...state.currentLocalStatus,
          workingTree: { files: [], insertions: 20, deletions: 4 },
        };
        yield* broadcaster.refreshLocalStatus("/repo");
        assert.deepEqual(yield* secondDetails, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        yield* Scope.close(secondScope, Exit.void);
        const callsAfterRelease = state.localStatusCalls;
        state.currentLocalStatus = {
          ...state.currentLocalStatus,
          workingTree: { files: [], insertions: 30, deletions: 5 },
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.equal(state.localStatusCalls, callsAfterRelease);
        const reopened = yield* Stream.toPull(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        );
        assert.deepEqual(yield* reopened, [
          { _tag: "snapshot", local: state.currentLocalStatus, remote: null },
        ]);
        state.currentLocalStatus = {
          ...baseLocalStatus,
          isRepo: false,
          refName: null,
        };
        yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
        assert.deepEqual(yield* reopened, [
          { _tag: "localUpdated", local: state.currentLocalStatus },
        ]);
        assert.deepEqual(yield* branches, [{ refName: null, isRepo: false }]);
        assert.equal(state.remoteStatusCalls, 0);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    },
  );

  it.effect("upgrades an in-flight branch refresh when detailed demand arrives", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: null,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const reading = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      state.beforeCurrentBranch = Deferred.succeed(reading, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
      );
      const refresh = yield* broadcaster
        .refreshBranchStatus({ cwd: "/repo" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(reading);
      const detailsFiber = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      ).pipe(Effect.forkScoped);
      state.currentLocalStatus = {
        ...baseLocalStatus,
        workingTree: { files: [], insertions: 8, deletions: 2 },
      };
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(refresh);
      assert.deepEqual(
        yield* Fiber.join(detailsFiber),
        Option.some({ _tag: "snapshot" as const, local: state.currentLocalStatus, remote: null }),
      );
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("publishes terminal branch switches and validates cached status reads", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const branchEvents = yield* broadcaster.streamBranchChanges.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      const subscribed = yield* Deferred.make<void>();
      const events = yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.tap((event) =>
          event._tag === "snapshot" ? Deferred.succeed(subscribed, undefined) : Effect.void,
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      state.currentRemoteStatus = baseRemoteStatus;
      const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
      assert.equal(refreshed.refName, "main");
      assert.isNull(refreshed.pr);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
      assert.deepStrictEqual((yield* Fiber.join(events)).slice(1), [
        { _tag: "remoteUpdated", remote: null },
        { _tag: "localUpdated", local: state.currentLocalStatus },
      ]);
      assert.isNull((yield* broadcaster.getStatus({ cwd: "/repo" })).pr);
      assert.equal(state.remoteStatusCalls, 2);
      state.currentLocalStatus = { ...state.currentLocalStatus, hasWorkingTreeChanges: true };
      yield* broadcaster.refreshLocalStatus("/repo");
      state.currentLocalStatus = { ...baseLocalStatus, refName: "union" };
      state.currentRemoteStatus = null;
      const queried = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(queried.refName, "union");
      assert.isNull(queried.pr);
      const snapshot = yield* broadcaster
        .streamStatus({ cwd: "/repo", includeRemote: false })
        .pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(snapshot[0], {
        _tag: "snapshot",
        local: state.currentLocalStatus,
        remote: null,
      });
      assert.deepStrictEqual(yield* Fiber.join(branchEvents), [
        { cwd: "/repo", refName: "main" },
        { cwd: "/repo", refName: "union" },
      ]);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "preserves cached remote status when a local-only refresh stays on the same branch",
    () => {
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 2, behindCount: 3 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const initial = yield* broadcaster.getStatus({ cwd: "/repo" });
        const refreshed = yield* broadcaster.refreshStatus("/repo", { localOnly: true });
        assert.deepStrictEqual(refreshed, initial);
        assert.deepStrictEqual(yield* broadcaster.getStatus({ cwd: "/repo" }), refreshed);
        assert.equal(state.localInvalidationCalls, 1);
        assert.equal(state.remoteInvalidationCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("a local-only refresh that overlaps the first remote poll keeps its PR", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const pollStarted = yield* Deferred.make<void>();
      const releasePoll = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(pollStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releasePoll)),
      );
      const localSeen = yield* Deferred.make<void>();
      yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
        Stream.runForEach((event) =>
          event._tag === "localUpdated" ? Deferred.succeed(localSeen, undefined) : Effect.void,
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(pollStarted);
      state.beforeRemoteStatus = Effect.void;

      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const refresh = yield* broadcaster
        .refreshStatus("/repo", { localOnly: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(localSeen);
      yield* Deferred.succeed(releasePoll, undefined);
      yield* Fiber.join(refresh);

      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(status.pr, remoteStatusWithPr.pr);
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect(
    "a local-only refresh before any remote read leaves the PR refresh able to read",
    () => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: remoteStatusWithPr,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.refreshStatus("/repo", { localOnly: true });

        const remote = yield* broadcaster.refreshPullRequestStatus("/repo");
        assert.deepStrictEqual(remote?.pr, remoteStatusWithPr.pr);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTestFor(state)));
    },
  );

  it.effect("a local-only refresh after a branch switch leaves the PR refresh able to read", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      const nextBranchRemote: VcsStatusRemoteResult = {
        ...baseRemoteStatus,
        pr: { ...remoteStatusWithPr.pr!, number: 3001, headRef: "feature/next" },
      };
      state.currentRemoteStatus = nextBranchRemote;
      yield* broadcaster.refreshStatus("/repo", { localOnly: true });

      const remote = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(remote?.pr, nextBranchRemote.pr);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("clears the previous branch's remote status after an in-flight PR refresh", () => {
    const remoteReadStarted = Deferred.makeUnsafe<void>();
    const releaseRemoteRead = Deferred.makeUnsafe<void>();
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      beforeRemoteStatus: Effect.void,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      state.beforeRemoteStatus = Deferred.succeed(remoteReadStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRemoteRead)),
      );
      const remoteRefresh = yield* broadcaster
        .refreshPullRequestStatus("/repo")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(remoteReadStarted);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "main" };
      const localRefresh = yield* broadcaster
        .refreshStatus("/repo", { localOnly: true })
        .pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseRemoteRead, undefined);
      yield* Fiber.join(remoteRefresh);
      yield* Fiber.join(localRefresh);
      state.currentRemoteStatus = baseRemoteStatus;

      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(status.refName, "main");
      assert.isNull(status.pr);
      assert.equal(status.aheadCount, 0);
      assert.equal(status.behindCount, 0);
      assert.equal(state.remoteStatusCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect.skipIf(!symlinksSupported)(
    "automatically pulls an enabled clean default branch when status detects it is behind",
    () => {
      let remoteStatus: VcsStatusRemoteResult = { ...baseRemoteStatus, behindCount: 2 };
      let pullCalls = 0;
      let configuredWorkspaceRoot = "";
      const localStatus: VcsStatusLocalResult = {
        ...baseLocalStatus,
        isDefaultRef: true,
        refName: "main",
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: (cwd) => Effect.succeed(cwd === configuredWorkspaceRoot),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(localStatus),
            currentBranch: () => Effect.succeed(localStatus.refName),
            remoteStatus: () => Effect.succeed(remoteStatus),
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            pullCurrentBranch: () =>
              Effect.sync(() => {
                pullCalls += 1;
                remoteStatus = { ...remoteStatus, behindCount: 0 };
                return {
                  status: "pulled" as const,
                  refName: "main",
                  upstreamRef: "origin/main",
                };
              }),
          }),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-auto-pull-link-",
        });
        configuredWorkspaceRoot = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, configuredWorkspaceRoot);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const status = yield* broadcaster.refreshStatus(configuredWorkspaceRoot);

        assert.equal(pullCalls, 1);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("refreshes a loaded cwd without reusing a previous branch's PR", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: { ...baseRemoteStatus, aheadCount: 3, behindCount: 5 },
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [],
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      assert.isNull(yield* broadcaster.refreshPullRequestStatus("/repo"));
      assert.equal(state.remoteStatusCalls, 0);

      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.remoteStatusCalls, 1);

      state.backgroundWorkEnabled = false;
      state.currentRemoteStatus = { ...remoteStatusWithPr, aheadCount: 7 };
      yield* broadcaster.refreshBranchStatus({ cwd: "/repo" });
      const refreshed = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshed, state.currentRemoteStatus);
      const merged = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(merged.aheadCount, 7);
      assert.equal(merged.behindCount, 0);
      assert.equal(state.remoteStatusRefreshUpstreamValues?.at(-1), false);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 2);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      state.currentRemoteStatus = baseRemoteStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      const refreshedBranch = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshedBranch, baseRemoteStatus);
      assert.equal(state.remoteStatusCalls, 3);
      const refreshedStatus = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(refreshedStatus.refName, "feature/next");
      assert.isNull(refreshedStatus.pr);
      assert.equal(state.remoteStatusCalls, 3);
      assert.equal(state.remoteInvalidationCalls, 3);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("a poll that started before the turn-end refresh cannot overwrite its PR", () => {
    const releaseFirstPoll = Deferred.makeUnsafe<void>();
    const firstPollStarted = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          currentBranch: () => Effect.succeed(baseLocalStatus.refName),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 2) {
                yield* Deferred.succeed(firstPollStarted, undefined);
                yield* Deferred.await(releaseFirstPoll);
                return baseRemoteStatus;
              }
              return remoteReads === 1 ? baseRemoteStatus : remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      const poll = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(firstPollStarted);
      const refresh = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.succeed(releaseFirstPoll, undefined);
      yield* Fiber.join(poll);
      const refreshed = yield* Fiber.join(refresh);

      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      const final = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(final.pr, remoteStatusWithPr.pr);
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("an initial status read cannot overwrite an explicit refresh", () => {
    const firstReadStarted = Deferred.makeUnsafe<void>();
    const releaseFirstRead = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          currentBranch: () => Effect.succeed(baseLocalStatus.refName),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 1) {
                yield* Deferred.succeed(firstReadStarted, undefined);
                yield* Deferred.await(releaseFirstRead);
                return baseRemoteStatus;
              }
              return remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReadStarted);
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.zero);
      yield* Deferred.succeed(releaseFirstRead, undefined);
      yield* Fiber.join(initial);
      yield* Fiber.join(refresh);
      assert.deepStrictEqual(
        (yield* broadcaster.getStatus({ cwd: "/repo" })).pr,
        remoteStatusWithPr.pr,
      );
    }).pipe(Effect.provide(layer), Effect.scoped);
  });

  it.effect("keeps the published local snapshot when a refresh remote read fails", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failRemoteStatus: false,
    };
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
          remoteStatus: () =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              return state.failRemoteStatus
                ? Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "remote status failed",
                    }),
                  )
                : Effect.succeed(state.currentRemoteStatus);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
          invalidateStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/partial-refresh",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 3,
      };
      state.failRemoteStatus = true;

      const refreshExit = yield* broadcaster.refreshStatus("/repo").pipe(Effect.exit);
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      );

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.isTrue(Option.isSome(snapshot));
      const event = Option.getOrThrow(snapshot);
      assert.equal(event._tag, "snapshot");
      if (event._tag === "snapshot") {
        assert.equal(event.local.refName, "feature/partial-refresh");
        assert.isNull(event.remote);
      }
    }).pipe(Effect.provide(layerTest));
  });

  it.effect.skipIf(!symlinksSupported)(
    "normalizes symlinked CWDs before cache lookup and workflow calls",
    () => {
      const seenCwds: string[] = [];
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.localStatusCalls += 1;
                return state.currentLocalStatus;
              }),
            currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
            remoteStatus: (input) =>
              Effect.sync(() => {
                seenCwds.push(input.cwd);
                state.remoteStatusCalls += 1;
                return state.currentRemoteStatus;
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                state.localInvalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                state.remoteInvalidationCalls += 1;
              }),
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
      );

      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const realDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-real-",
        });
        const linkParent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-vcs-status-link-",
        });
        const linkDir = path.join(linkParent, "repo-link");
        yield* fileSystem.symlink(realDir, linkDir);
        const realPath = yield* fileSystem.realPath(realDir);

        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: linkDir });
        yield* broadcaster.getStatus({ cwd: realDir });

        assert.deepStrictEqual(seenCwds, [realPath, realPath]);
        assert.equal(state.localStatusCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(layerTest));
    },
  );

  it.effect("a remote poll refreshes Changes totals when divergence counts stay the same", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 745, deletions: 24 },
      },
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const polled = yield* Deferred.make<void>();
      yield* broadcaster.streamStatus({ cwd: "/repo" }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "remoteUpdated") return Deferred.succeed(polled, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      state.currentLocalStatus = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 107, deletions: 4 },
      };
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(polled);
      const status = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(status.branchChanges, state.currentLocalStatus.branchChanges);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("an explicit refresh reads local totals after the fetch", () => {
    return Effect.gen(function* () {
      const fetchStarted = yield* Deferred.make<void>();
      const finishFetch = yield* Deferred.make<void>();
      let local: VcsStatusLocalResult = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 745, deletions: 24 },
      };
      let cachedLocal: VcsStatusLocalResult | undefined;
      const readLocalStatus = () => Effect.sync(() => (cachedLocal ??= local));
      const layerTest = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(layerBackgroundPolicy(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: readLocalStatus,
            invalidateStatus: () =>
              Effect.sync(() => {
                cachedLocal = undefined;
              }),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                cachedLocal = undefined;
              }),
            currentBranch: () => Effect.succeed(baseLocalStatus.refName),
            invalidateRemoteStatus: () => Effect.void,
            remoteStatus: () =>
              Deferred.succeed(fetchStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishFetch)),
                Effect.as(baseRemoteStatus),
              ),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
        yield* Deferred.await(fetchStarted);
        // Another reader can refill the local cache while fetch is still running.
        yield* readLocalStatus();
        local = {
          ...baseLocalStatus,
          branchChanges: { baseRef: "origin/main", insertions: 0, deletions: 0 },
        };
        yield* Deferred.succeed(finishFetch, undefined);
        const status = yield* Fiber.join(refresh);
        assert.deepStrictEqual(status.branchChanges, local.branchChanges);
      }).pipe(Effect.provide(layerTest));
    });
  });

  it.effect("publishes local status while an earlier lookup holds the remote lock", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const published = yield* Deferred.make<VcsStatusLocalResult>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(published, event.local);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const earlier = yield* broadcaster.refreshPullRequestStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      const completed = yield* Deferred.make<void>();
      const refresh = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(Effect.ensuring(Deferred.succeed(completed, undefined)), Effect.forkScoped);

      assert.deepStrictEqual(yield* Deferred.await(published), state.currentLocalStatus);
      assert.isFalse(yield* Deferred.isDone(completed));
      assert.isFalse(yield* Deferred.isDone(release));
      state.currentRemoteStatus = remoteStatusWithPr;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(earlier);
      const status = yield* Fiber.join(refresh);
      assert.isTrue(status.hasWorkingTreeChanges);
      assert.deepStrictEqual(status.pr, remoteStatusWithPr.pr);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("publishes local changes before a remote error and propagates that error", () => {
    const remoteError = new GitManagerError({
      operation: "VcsStatusBroadcaster.remoteStatus",
      cwd: "/repo",
      detail: "The controlled remote lookup failed.",
    });
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const subscribed = yield* Deferred.make<void>();
      const published = yield* Deferred.make<VcsStatusLocalResult>();
      yield* broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }).pipe(
        Stream.runForEach((event) => {
          if (event._tag === "snapshot") return Deferred.succeed(subscribed, undefined);
          if (event._tag === "localUpdated") return Deferred.succeed(published, event.local);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      yield* Deferred.await(subscribed);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      state.currentLocalStatus = { ...baseLocalStatus, hasWorkingTreeChanges: true };
      state.remoteStatusError = remoteError;
      const refresh = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(
          Effect.result,
          Effect.ensuring(Deferred.succeed(completed, undefined)),
          Effect.forkScoped,
        );
      yield* Deferred.await(started);
      assert.isFalse(yield* Deferred.isDone(completed));
      const pending = Option.getOrThrow(
        yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo", includeRemote: false })),
      );
      assert.equal(pending._tag, "snapshot");
      if (pending._tag === "snapshot") assert.isTrue(pending.local.hasWorkingTreeChanges);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(refresh);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure, remoteError);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.isTrue(cached.hasWorkingTreeChanges);
      assert.deepStrictEqual(cached.pr, remoteStatusWithPr.pr);
      assert.deepStrictEqual(yield* Deferred.await(published), state.currentLocalStatus);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect.each(["getStatus", "refreshStatus", "autoPull", "autoPullFailure"] as const)(
    "%s keeps response parts consistent when local state changes after the remote cache write",
    (operation) => {
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 3, behindCount: 5 },
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
      };
      const autoPull = operation === "autoPull" || operation === "autoPullFailure";
      if (autoPull) {
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: true };
        state.currentRemoteStatus = { ...remoteStatusWithPr, aheadCount: 0, behindCount: 5 };
        state.pullCurrentBranch = () =>
          operation === "autoPullFailure"
            ? Effect.fail(
                new GitCommandError({
                  operation: "test.pull",
                  command: "pull",
                  cwd: "/repo",
                  detail: "Pull failed.",
                }),
              )
            : Effect.succeed({
                status: "pulled",
                refName: "feature/status-broadcast",
                upstreamRef: "origin/main",
              });
      }
      const layerTest = layerTestFor(state).pipe(
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: () => Effect.succeed(autoPull),
          }),
        ),
      );
      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        let switched = false;
        let remoteWritten = false;
        const writeCompleted = yield* Deferred.make<void>();
        const localRefresh = yield* Effect.gen(function* () {
          yield* Deferred.await(writeCompleted);
          state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next-status" };
          yield* broadcaster.refreshLocalStatus("/repo");
          switched = true;
        }).pipe(Effect.forkScoped);
        const scheduler = new Scheduler.MixedScheduler();
        const shouldYield = scheduler.shouldYield.bind(scheduler);
        scheduler.shouldYield = (fiber) => (remoteWritten && !switched) || shouldYield(fiber);
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            const end = span.end.bind(span);
            span.end = (time, exit) => {
              end(time, exit);
              if (
                options.name !== "VcsStatusBroadcaster.updateCachedRemoteStatus" ||
                remoteWritten
              ) {
                return;
              }
              // Yield this reader after its write until the local refresh finishes.
              remoteWritten = true;
              Deferred.doneUnsafe(writeCompleted, Effect.void);
            };
            return span;
          },
        });
        const status = yield* (
          operation === "getStatus"
            ? broadcaster.getStatus({ cwd: "/repo" })
            : broadcaster.refreshStatus("/repo")
        ).pipe(Effect.withTracer(tracer), Effect.provideService(Scheduler.Scheduler, scheduler));
        yield* Fiber.join(localRefresh);
        assert.isTrue(switched);
        assert.equal(status.refName, "feature/next-status");
        assert.isNull(status.pr);
        assert.equal(status.aheadCount, 0);
        assert.equal(status.behindCount, 0);
      }).pipe(Effect.provide(layerTest), Effect.scoped);
    },
  );

  it.effect("recovers a discarded branch lookup on the next turn-end refresh", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 3, behindCount: 5 },
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const lookup = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next-status" };
      yield* Deferred.succeed(release, undefined);
      const discarded = yield* Fiber.join(lookup);
      assert.equal(discarded.refName, state.currentLocalStatus.refName);
      assert.isNull(discarded.pr);
      assert.equal(discarded.aheadCount, 0);
      assert.equal(discarded.behindCount, 0);
      const snapshot = Option.getOrThrow(
        yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo", includeRemote: false })),
      );
      assert.equal(snapshot._tag, "snapshot");
      if (snapshot._tag === "snapshot") assert.isNull(snapshot.remote);

      state.beforeRemoteStatus = Effect.void;
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
        pr: { ...remoteStatusWithPr.pr!, number: 2979, headRef: "feature/next-status" },
      };
      state.backgroundWorkEnabled = false;
      const recovered = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(recovered, state.currentRemoteStatus);
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(cached.refName, state.currentLocalStatus.refName);
      assert.deepStrictEqual(cached.pr, state.currentRemoteStatus.pr);
      assert.equal(cached.aheadCount, 2);
      assert.equal(state.remoteStatusCalls, 2);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("a terminal checkout publishes the new branch without waiting for a poll", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const state = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: remoteStatusWithPr as VcsStatusRemoteResult | null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
        headPath,
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/repo" });
        const clientStates: Array<VcsStatusResult> = [];
        const subscribed = yield* Deferred.make<void>();
        const checkedOut = yield* Deferred.make<void>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
          Effect.gen(function* () {
            const next = applyGitStatusStreamEvent(clientStates.at(-1) ?? null, event);
            clientStates.push(next);
            yield* Deferred.succeed(subscribed, undefined);
            if (next.refName === "repro") yield* Deferred.succeed(checkedOut, undefined);
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(subscribed);

        // What `git switch -c repro` does to HEAD, with the test clock never advanced.
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName: "repro" };
        state.currentRemoteStatus = { ...baseRemoteStatus, hasUpstream: false };
        const lockPath = path.join(gitDir, "HEAD.lock");
        yield* fs.writeFileString(lockPath, "ref: refs/heads/repro\n");
        yield* fs.rename(lockPath, headPath);
        yield* Deferred.await(checkedOut);

        assert.deepStrictEqual(
          clientStates.filter((status) => status.refName === "repro").map((status) => status.pr),
          [null],
        );
        // A checkout must not trigger a network fetch.
        assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues.slice(1), [false]);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a terminal checkout updates branch-only subscribers without full status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const state = {
        currentLocalStatus: { ...baseLocalStatus, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath,
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const branches = yield* Stream.toPull(broadcaster.streamBranchStatus({ cwd: "/repo" }));
        assert.deepEqual(yield* branches, [{ refName: "main", isRepo: true }]);

        state.currentLocalStatus = { ...baseLocalStatus, refName: "repro" };
        const lockPath = path.join(gitDir, "HEAD.lock");
        yield* fs.writeFileString(lockPath, "ref: refs/heads/repro\n");
        yield* fs.rename(lockPath, headPath);

        assert.deepEqual(yield* branches, [{ refName: "repro", isRepo: true }]);
        assert.equal(state.localStatusCalls, 0);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a checkout read that fails while index.lock is held retries until it succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const failed = yield* Deferred.make<void>();
      const state = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath,
        failLocalStatus: false,
        onLocalStatusFailure: Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const subscribed = yield* Deferred.make<void>();
        const checkedOut = yield* Deferred.make<void>();
        let clientState: VcsStatusResult | null = null;
        yield* Stream.runForEach(
          broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
          (event) =>
            Effect.gen(function* () {
              clientState = applyGitStatusStreamEvent(clientState, event);
              yield* Deferred.succeed(subscribed, undefined);
              if (clientState.refName === "repro") yield* Deferred.succeed(checkedOut, undefined);
            }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(subscribed);

        // A terminal commit holds index.lock across the checkout, so the HEAD event's read fails.
        state.failLocalStatus = true;
        state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName: "repro" };
        const lockPath = path.join(gitDir, "HEAD.lock");
        yield* fs.writeFileString(lockPath, "ref: refs/heads/repro\n");
        yield* fs.rename(lockPath, headPath);
        yield* Deferred.await(failed);
        const failedCalls = state.localStatusCalls;

        // Removing index.lock moves no HEAD, and no remote poll runs for this subscriber.
        state.failLocalStatus = false;
        yield* TestClock.adjust(Duration.seconds(30));
        yield* Deferred.await(checkedOut);
        assert.strictEqual(state.localStatusCalls, failedCalls + 1);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("subscribers share one HEAD watch that ends with the last of them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus as VcsStatusRemoteResult | null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPath,
        headPathCalls: 0,
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const subscribe = Effect.gen(function* () {
          const received = yield* Deferred.make<void>();
          const fiber = yield* Stream.runForEach(
            broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
            () => Deferred.succeed(received, undefined),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(received);
          return fiber;
        });

        const first = yield* subscribe;
        const second = yield* subscribe;
        assert.strictEqual(state.headPathCalls, 1);

        yield* Fiber.interrupt(first);
        yield* Fiber.interrupt(second);
        yield* subscribe;
        assert.strictEqual(state.headPathCalls, 2);
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("a HEAD watch that ended restarts for the next subscriber and keeps earlier ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const gitDir = yield* fs.makeTempDirectoryScoped({ prefix: "vcs-head-watch-" });
      const headPath = path.join(gitDir, "HEAD");
      yield* fs.writeFileString(headPath, "ref: refs/heads/main\n");
      const state: Parameters<typeof layerTestFor>[0] = {
        currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
        headPathCalls: 0,
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const subscribe = Effect.gen(function* () {
          const subscribed = yield* Deferred.make<void>();
          const refs = new Map<string, Deferred.Deferred<void>>();
          const sawRef = (refName: string) => {
            const existing = refs.get(refName);
            if (existing) return existing;
            const created = Deferred.makeUnsafe<void>();
            refs.set(refName, created);
            return created;
          };
          let clientState: VcsStatusResult | null = null;
          const fiber = yield* Stream.runForEach(
            broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
            (event) =>
              Effect.gen(function* () {
                clientState = applyGitStatusStreamEvent(clientState, event);
                yield* Deferred.succeed(subscribed, undefined);
                yield* Deferred.succeed(sawRef(clientState.refName ?? ""), undefined);
              }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(subscribed);
          return { fiber, sawRef };
        });
        const checkout = (refName: string) =>
          Effect.gen(function* () {
            state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName };
            const lockPath = path.join(gitDir, "HEAD.lock");
            yield* fs.writeFileString(lockPath, `ref: refs/heads/${refName}\n`);
            yield* fs.rename(lockPath, headPath);
          });

        // The repository has no HEAD yet, so the first watch ends at once.
        const first = yield* subscribe;
        state.headPath = headPath;
        const second = yield* subscribe;
        assert.strictEqual(state.headPathCalls, 2);

        yield* checkout("one");
        yield* Deferred.await(first.sawRef("one"));
        yield* Deferred.await(second.sawRef("one"));

        // The replacement belongs to both subscribers, so the second leaving keeps it.
        yield* Fiber.interrupt(second.fiber);
        yield* checkout("two");
        yield* Deferred.await(first.sawRef("two"));
      }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("releases remote demand while passive observers remain", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const layerTest = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(layerBackgroundPolicy(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          currentBranch: () => Effect.succeed(state.currentLocalStatus.refName),
          remoteStatus: () =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
            }).pipe(
              Effect.andThen(
                remoteStartedDeferred
                  ? Deferred.succeed(remoteStartedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterruptedDeferred
                  ? Deferred.succeed(remoteInterruptedDeferred, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const remoteInterrupted = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      remoteInterruptedDeferred = remoteInterrupted;
      remoteStartedDeferred = remoteStarted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const passiveSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(passiveSnapshot, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(passiveSnapshot);
      assert.equal(state.remoteStatusCalls, 0);
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(layerTest));
  });
});

const newState = (): Parameters<typeof layerTestFor>[0] => ({
  fileSystem: FileSystem.makeNoop({ realPath: (cwd) => Effect.succeed(cwd) }),
  currentLocalStatus: baseLocalStatus,
  currentRemoteStatus: null,
  localStatusCalls: 0,
  remoteStatusCalls: 0,
  localInvalidationCalls: 0,
  remoteInvalidationCalls: 0,
});
it.effect("detail join during invalidation must get fresh totals", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const oldScope = yield* Scope.make();
    const old = yield* Stream.toPull(b.streamStatus({ cwd: "/repo", includeRemote: false })).pipe(
      Scope.provide(oldScope),
    );
    yield* old;
    yield* Scope.close(oldScope, Exit.void);
    state.currentLocalStatus = {
      ...baseLocalStatus,
      workingTree: { files: [], insertions: 42, deletions: 0 },
    };
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    state.beforeInvalidate = Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Deferred.await(resume)),
    );
    const refresh = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const snapshotFiber = yield* Stream.runHead(
      b.streamStatus({ cwd: "/repo", includeRemote: false }),
    ).pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(refresh);
    assert.deepEqual(
      yield* Fiber.join(snapshotFiber),
      Option.some({ _tag: "snapshot" as const, local: state.currentLocalStatus, remote: null }),
    );
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});
it.effect("serializes branch reads with detailed refresh publication", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    state.branchRead = () =>
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(resume)),
        Effect.as("old"),
      );
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    state.currentLocalStatus = { ...baseLocalStatus, refName: "new" };
    const newer = yield* b
      .refreshLocalStatus("/repo")
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    yield* Fiber.join(newer);
    state.branchRead = () => Effect.succeed("new");
    const result = yield* b.getStatus({ cwd: "/repo" });
    assert.equal(result.refName, "new");
    assert.equal(state.localStatusCalls, 1);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});

it.effect("publishes overlapping branch reads in checkout order", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const branches = yield* Stream.toPull(b.streamBranchStatus({ cwd: "/repo" }));
    yield* branches;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    let reads = 0;
    state.branchRead = () =>
      ++reads === 1
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as("old"),
          )
        : Effect.succeed("new");
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const newer = yield* b
      .refreshBranchStatus({ cwd: "/repo" })
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    yield* Fiber.join(newer);
    assert.deepEqual(yield* branches, [
      { refName: "old", isRepo: true },
      { refName: "new", isRepo: true },
    ]);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});

it.effect("does not replay older queued branches after a new subscriber snapshot", () => {
  const state = newState();
  return Effect.gen(function* () {
    const b = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const values = yield* Queue.unbounded<VcsBranchStatus>();
    let reads = 0;
    state.branchRead = () =>
      ++reads === 1
        ? Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as("old"),
          )
        : Effect.succeed("new");
    const older = yield* b.refreshBranchStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    const subscriber = yield* b.streamBranchStatus({ cwd: "/repo" }).pipe(
      Stream.tap((value) => Queue.offer(values, value)),
      Stream.take(2),
      Stream.runDrain,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.succeed(resume, undefined);
    yield* Fiber.join(older);
    assert.deepEqual(yield* Queue.take(values), { refName: "new", isRepo: true });
    state.branchRead = () => Effect.succeed("latest");
    yield* b.refreshBranchStatus({ cwd: "/repo" });
    assert.deepEqual(yield* Queue.take(values), { refName: "latest", isRepo: true });
    yield* Fiber.join(subscriber);
  }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
});
