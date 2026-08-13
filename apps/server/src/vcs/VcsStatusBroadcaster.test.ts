import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type {
  BackgroundScope,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { GitManagerError } from "@t3tools/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  sourceControlProvider: {
    kind: "github",
    name: "GitHub",
    baseUrl: "https://github.com",
  },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const nonRepositoryLocalStatus: VcsStatusLocalResult = {
  isRepo: false,
  hasPrimaryRemote: false,
  isDefaultRef: false,
  refName: null,
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
    headRef: "codex/connection-state-audit",
    state: "open",
  },
};

const baseStatus: VcsStatusResult = {
  ...baseLocalStatus,
  ...baseRemoteStatus,
};

function makeTestLayer(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(makeBackgroundPolicyLayer(() => true)),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: () =>
          Effect.sync(() => {
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        remoteStatus: (_input, options) =>
          Effect.sync(() => {
            state.remoteStatusCalls += 1;
            state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
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
        invalidateStatus: () =>
          Effect.sync(() => {
            state.localInvalidationCalls += 1;
            state.remoteInvalidationCalls += 1;
          }),
      }),
    ),
  );
}

function makeBackgroundPolicyLayer(shouldRunScopeWork: (scope: BackgroundScope) => boolean) {
  return Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    reportClientActivity: () => Effect.void,
    removeRpcClient: () => Effect.void,
    reportHostPowerState: () => Effect.void,
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
    streamChanges: Stream.empty,
    hasDemand: () => Effect.succeed(true),
    shouldRunScopeWork: (scope) => Effect.sync(() => shouldRunScopeWork(scope)),
    shouldRunOpportunisticWork: Effect.succeed(true),
  });
}

describe("VcsStatusBroadcaster", () => {
  it.effect("reuses the cached VCS status across repeated reads", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      const first = yield* broadcaster.getStatus({ cwd: "/repo" });
      const second = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(first, baseStatus);
      assert.deepStrictEqual(second, baseStatus);
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("releases transient remote-operation locks after each request", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const remoteOperationLockCount = broadcaster.remoteOperationLockCount;
      assert.isDefined(remoteOperationLockCount);
      if (remoteOperationLockCount === undefined) return;

      yield* broadcaster.getStatus({ cwd: "/transient/repo-a" });
      assert.equal(yield* remoteOperationLockCount, 0);

      yield* broadcaster.getStatus({ cwd: "/transient/repo-b" });
      assert.equal(yield* remoteOperationLockCount, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes the cached snapshot after explicit invalidation", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/updated-status",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 2,
      };
      const refreshed = yield* broadcaster.refreshStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshed, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 4);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 3);
      assert.equal(state.remoteInvalidationCalls, 1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("keeps the cached snapshot unchanged when a refresh branch fails", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      failRemoteStatus: false,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
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
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.isTrue(Exit.isFailure(refreshExit));
      assert.deepStrictEqual(cached, baseStatus);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("refreshes remote status on the next read after the local ref changes", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/local-only-refresh",
        hasWorkingTreeChanges: true,
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 4,
        behindCount: 2,
      };

      const refreshedLocal = yield* broadcaster.refreshLocalStatus("/repo");

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshedLocal, state.currentLocalStatus);
      assert.equal(state.remoteStatusCalls, 1);

      const refreshed = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(refreshed, {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 5);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 3);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("normalizes symlinked CWDs before cache lookup and workflow calls", () => {
    const seenCwds: string[] = [];
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: (input) =>
            Effect.sync(() => {
              seenCwds.push(input.cwd);
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
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

      assert.deepStrictEqual(seenCwds, [realPath, realPath, realPath]);
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("streams a local snapshot first and remote updates later", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
        if (event._tag === "snapshot") {
          return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
        }
        if (event._tag === "remoteUpdated") {
          return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkScoped);

      const snapshot = yield* Deferred.await(snapshotDeferred);
      yield* broadcaster.refreshStatus("/repo");
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: baseRemoteStatus,
      } satisfies VcsStatusStreamEvent);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("keeps a mounted local-only subscription free of remote work", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const snapshotDeferred =
        yield* Deferred.make<Extract<VcsStatusStreamEvent, { _tag: "snapshot" }>>();
      const input = { cwd: "/repo", includeRemote: false };
      yield* Stream.runForEach(
        broadcaster.streamStatus(input, {
          automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)),
        }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      const snapshot = yield* Deferred.await(snapshotDeferred);
      assert.deepStrictEqual(snapshot.local, baseLocalStatus);

      yield* TestClock.adjust(Duration.minutes(10));
      yield* Effect.yieldNow;

      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it.effect(
    "does not start remote work when the initial local snapshot is not a repository",
    () => {
      const state = {
        currentLocalStatus: nonRepositoryLocalStatus,
        currentRemoteStatus: null,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const scope = yield* Scope.make();
        const snapshotDeferred =
          yield* Deferred.make<Extract<VcsStatusStreamEvent, { _tag: "snapshot" }>>();
        const input = { cwd: "/not-a-repo", includeRemote: true };
        yield* Stream.runForEach(
          broadcaster.streamStatus(input, {
            automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)),
          }),
          (event) =>
            event._tag === "snapshot"
              ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
              : Effect.void,
        ).pipe(Effect.forkIn(scope));

        const snapshot = yield* Deferred.await(snapshotDeferred);
        assert.deepStrictEqual(snapshot.local, nonRepositoryLocalStatus);

        yield* TestClock.adjust(Duration.minutes(1));
        yield* Effect.yieldNow;

        assert.equal(state.localStatusCalls, 1);
        assert.equal(state.remoteStatusCalls, 0);
        assert.equal(state.remoteInvalidationCalls, 0);

        yield* Scope.close(scope, Exit.void);
      }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
    },
  );

  it.effect("tracks repository disappearance and reappearance on one remote stream", () => {
    const branchBLocal = {
      ...baseLocalStatus,
      refName: "feature/reappeared-repo",
    };
    const state = {
      currentLocalStatus: nonRepositoryLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let remoteAttemptSignals: ReadonlyArray<Deferred.Deferred<void>> = [];
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
              const signal = remoteAttemptSignals[state.remoteStatusCalls];
              state.remoteStatusCalls += 1;
              return signal;
            }).pipe(
              Effect.flatMap((signal) =>
                signal ? Deferred.succeed(signal, undefined).pipe(Effect.ignore) : Effect.void,
              ),
              Effect.as(state.currentRemoteStatus),
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
      remoteAttemptSignals = yield* Effect.forEach(Array.from({ length: 2 }), () =>
        Deferred.make<void>(),
      );
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const initialSnapshotDeferred =
        yield* Deferred.make<Extract<VcsStatusStreamEvent, { _tag: "snapshot" }>>();
      const disappearedDeferred = yield* Deferred.make<void>();
      const branchARemoteDeferred = yield* Deferred.make<void>();
      const branchBRemoteDeferred = yield* Deferred.make<void>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo", includeRemote: true },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)) },
        ),
        (event) => {
          if (event._tag === "snapshot" && !event.local.isRepo) {
            return Deferred.succeed(initialSnapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "localUpdated" && !event.local.isRepo) {
            return Deferred.succeed(disappearedDeferred, undefined).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated" && event.remoteRefName === baseLocalStatus.refName) {
            return Deferred.succeed(branchARemoteDeferred, undefined).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated" && event.remoteRefName === branchBLocal.refName) {
            return Deferred.succeed(branchBRemoteDeferred, undefined).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(initialSnapshotDeferred);
      yield* TestClock.adjust(Duration.minutes(1));
      assert.equal(state.remoteStatusCalls, 0);

      state.currentLocalStatus = baseLocalStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      yield* Deferred.await(branchARemoteDeferred);
      assert.equal(state.remoteStatusCalls, 1);

      state.currentLocalStatus = nonRepositoryLocalStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      yield* Deferred.await(disappearedDeferred);
      yield* TestClock.adjust(Duration.minutes(10));
      assert.equal(state.remoteStatusCalls, 1);

      state.currentLocalStatus = branchBLocal;
      yield* broadcaster.refreshLocalStatus("/repo");
      yield* Deferred.await(branchBRemoteDeferred);
      assert.equal(state.remoteStatusCalls, 2);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(testLayer, TestClock.layer())));
  });

  it.effect("confirms an unstable repository disappearance before parking", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let firstRemoteAttemptDeferred: Deferred.Deferred<void> | null = null;
    let releaseFirstRemoteDeferred: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.gen(function* () {
              state.remoteStatusCalls += 1;
              if (state.remoteStatusCalls === 1) {
                if (firstRemoteAttemptDeferred) {
                  yield* Deferred.succeed(firstRemoteAttemptDeferred, undefined).pipe(
                    Effect.ignore,
                  );
                }
                if (releaseFirstRemoteDeferred) {
                  yield* Deferred.await(releaseFirstRemoteDeferred);
                }
              }
              return null;
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
      firstRemoteAttemptDeferred = yield* Deferred.make<void>();
      releaseFirstRemoteDeferred = yield* Deferred.make<void>();
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const initialSnapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const unstableLocalDeferred = yield* Deferred.make<void>();
      const confirmedNonRepositoryDeferred = yield* Deferred.make<void>();
      const input = { cwd: "/repo", includeRemote: true };
      yield* Stream.runForEach(
        broadcaster.streamStatus(input, {
          automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)),
        }),
        (event) => {
          if (event._tag === "snapshot" && event.local.isRepo) {
            return Deferred.succeed(initialSnapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "localUpdated" && !event.local.isRepo) {
            return Deferred.succeed(unstableLocalDeferred, undefined).pipe(Effect.ignore);
          }
          if (event._tag === "snapshot" && !event.local.isRepo) {
            return Deferred.succeed(confirmedNonRepositoryDeferred, undefined).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(initialSnapshotDeferred);
      yield* Deferred.await(firstRemoteAttemptDeferred);
      state.currentLocalStatus = nonRepositoryLocalStatus;
      yield* Deferred.succeed(releaseFirstRemoteDeferred, undefined);
      yield* Deferred.await(unstableLocalDeferred);
      assert.equal(state.remoteStatusCalls, 1);

      yield* TestClock.adjust(Duration.seconds(1));
      yield* Deferred.await(confirmedNonRepositoryDeferred);
      assert.equal(state.remoteStatusCalls, 2);

      yield* TestClock.adjust(Duration.minutes(10));
      yield* Effect.yieldNow;

      assert.equal(state.remoteStatusCalls, 2);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(testLayer, TestClock.layer())));
  });

  it.effect("limits remote failures to three attempts per demand epoch", () => {
    const state = {
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    let attemptSignals: ReadonlyArray<Deferred.Deferred<void>> = [];
    const logger = Logger.make<unknown, void>(() => undefined);
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return baseLocalStatus;
            }),
          remoteStatus: () =>
            Effect.suspend(() => {
              const attemptIndex = state.remoteStatusCalls;
              state.remoteStatusCalls += 1;
              const signal = attemptSignals[attemptIndex];
              return (
                signal ? Deferred.succeed(signal, undefined).pipe(Effect.ignore) : Effect.void
              ).pipe(
                Effect.andThen(
                  Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test",
                      cwd: "/repo",
                      detail: "persistent remote status failure",
                    }),
                  ),
                ),
              );
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
      attemptSignals = yield* Effect.forEach(Array.from({ length: 6 }), () =>
        Deferred.make<void>(),
      );
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const input = { cwd: "/repo", includeRemote: true };

      const firstScope = yield* Scope.make();
      const firstSnapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(input, {
          automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)),
        }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(firstSnapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(firstScope));

      yield* Deferred.await(firstSnapshotDeferred);
      yield* Deferred.await(attemptSignals[0]!);
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Deferred.await(attemptSignals[1]!);
      yield* TestClock.adjust(Duration.seconds(60));
      yield* Deferred.await(attemptSignals[2]!);
      assert.equal(state.remoteStatusCalls, 3);

      yield* TestClock.adjust(Duration.seconds(120));
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 3);

      const sameEpochScope = yield* Scope.make();
      const sameEpochSnapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(input, {
          automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)),
        }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(sameEpochSnapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(sameEpochScope));
      yield* Deferred.await(sameEpochSnapshotDeferred);
      yield* TestClock.adjust(Duration.minutes(10));
      assert.equal(state.remoteStatusCalls, 3);
      yield* Scope.close(sameEpochScope, Exit.void);

      yield* Scope.close(firstScope, Exit.void);

      const secondScope = yield* Scope.make();
      const secondSnapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(input, {
          automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)),
        }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(secondSnapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(secondSnapshotDeferred);
      yield* Deferred.await(attemptSignals[3]!);
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Deferred.await(attemptSignals[4]!);
      yield* TestClock.adjust(Duration.seconds(60));
      yield* Deferred.await(attemptSignals[5]!);
      assert.equal(state.remoteStatusCalls, 6);

      yield* TestClock.adjust(Duration.seconds(120));
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 6);

      yield* Scope.close(secondScope, Exit.void);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer,
          TestClock.layer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("rearms a retained failed poller when the local ref changes", () => {
    const branchBLocal = {
      ...baseLocalStatus,
      refName: "feature/rearmed-after-failure",
    };
    const branchBRemote = {
      ...baseRemoteStatus,
      behindCount: 7,
    };
    const state = {
      currentLocalStatus: baseLocalStatus,
      remoteStatusCalls: 0,
    };
    let attemptSignals: ReadonlyArray<Deferred.Deferred<void>> = [];
    const logger = Logger.make<unknown, void>(() => undefined);
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(state.currentLocalStatus),
          remoteStatus: () =>
            Effect.suspend(() => {
              const attemptIndex = state.remoteStatusCalls;
              state.remoteStatusCalls += 1;
              const signal = attemptSignals[attemptIndex];
              const signalAttempt = signal
                ? Deferred.succeed(signal, undefined).pipe(Effect.ignore)
                : Effect.void;
              return attemptIndex < 3
                ? signalAttempt.pipe(
                    Effect.andThen(
                      Effect.fail(
                        new GitManagerError({
                          operation: "VcsStatusBroadcaster.test",
                          cwd: "/repo",
                          detail: "Branch A remote status failed.",
                        }),
                      ),
                    ),
                  )
                : signalAttempt.pipe(Effect.as(branchBRemote));
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      attemptSignals = yield* Effect.forEach(Array.from({ length: 4 }), () =>
        Deferred.make<void>(),
      );
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const initialSnapshot = yield* Deferred.make<void>();
      const branchBRemotePublished = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo", includeRemote: true },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)) },
        ),
        (event) => {
          if (event._tag === "snapshot" && event.local.refName === baseLocalStatus.refName) {
            return Deferred.succeed(initialSnapshot, undefined).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated" && event.remoteRefName === branchBLocal.refName) {
            return Deferred.succeed(branchBRemotePublished, event).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(initialSnapshot);
      yield* Deferred.await(attemptSignals[0]!);
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Deferred.await(attemptSignals[1]!);
      yield* TestClock.adjust(Duration.seconds(60));
      yield* Deferred.await(attemptSignals[2]!);
      assert.equal(state.remoteStatusCalls, 3);

      state.currentLocalStatus = branchBLocal;
      yield* broadcaster.refreshLocalStatus("/repo");
      for (let attempt = 0; attempt < 100 && state.remoteStatusCalls < 4; attempt += 1) {
        yield* Effect.yieldNow;
      }
      assert.equal(state.remoteStatusCalls, 4);
      const branchBEvent = yield* Deferred.await(branchBRemotePublished);
      assert.deepStrictEqual(branchBEvent, {
        _tag: "remoteUpdated",
        remote: branchBRemote,
        remoteRefName: branchBLocal.refName,
      } satisfies VcsStatusStreamEvent);

      yield* Scope.close(scope, Exit.void);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer,
          TestClock.layer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("binds live and cached remote snapshots to the observed local ref", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const remoteInput = { cwd: "/repo", includeRemote: true };
      const remoteScope = yield* Scope.make();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(remoteInput, {
          automaticRemoteRefreshInterval: Effect.succeed(Duration.zero),
        }),
        (event) =>
          event._tag === "remoteUpdated"
            ? Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(remoteScope));

      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);
      yield* Scope.close(remoteScope, Exit.void);

      const localInput = { cwd: "/repo", includeRemote: false };
      const localScope = yield* Scope.make();
      const cachedSnapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(localInput, {
          automaticRemoteRefreshInterval: Effect.succeed(Duration.zero),
        }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(cachedSnapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(localScope));

      const cachedSnapshot = yield* Deferred.await(cachedSnapshotDeferred);
      yield* Scope.close(localScope, Exit.void);

      assert.deepStrictEqual(
        { remoteUpdated, cachedSnapshot },
        {
          remoteUpdated: {
            _tag: "remoteUpdated",
            remote: remoteStatusWithPr,
            remoteRefName: baseLocalStatus.refName,
          },
          cachedSnapshot: {
            _tag: "snapshot",
            local: baseLocalStatus,
            remote: remoteStatusWithPr,
            remoteRefName: baseLocalStatus.refName,
          },
        },
      );
      assert.equal(state.remoteStatusCalls, 1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("does not bind an in-flight remote refresh across a local ref change", () => {
    const branchBLocal = {
      ...baseLocalStatus,
      refName: "feature/status-race-b",
    };
    const branchBRemote = {
      ...baseRemoteStatus,
      aheadCount: 5,
    };
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localInvalidationCalls: 0,
      remoteStatusCalls: 0,
    };
    let cachedLocalStatus: VcsStatusLocalResult | null = null;
    let firstRemoteStarted: Deferred.Deferred<void> | null = null;
    let releaseFirstRemote: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              cachedLocalStatus ??= state.currentLocalStatus;
              return cachedLocalStatus;
            }),
          remoteStatus: () =>
            Effect.gen(function* () {
              state.remoteStatusCalls += 1;
              const result = state.currentRemoteStatus;
              if (state.remoteStatusCalls === 1) {
                if (firstRemoteStarted) {
                  yield* Deferred.succeed(firstRemoteStarted, undefined).pipe(Effect.ignore);
                }
                if (releaseFirstRemote) {
                  yield* Deferred.await(releaseFirstRemote);
                }
              }
              return result;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              cachedLocalStatus = null;
            }),
          invalidateRemoteStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      firstRemoteStarted = yield* Deferred.make<void>();
      releaseFirstRemote = yield* Deferred.make<void>();
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstRefreshEventDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const branchBRemoteDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo", includeRemote: true },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)) },
        ),
        (event) => {
          if (event._tag === "snapshot" && event.local.refName === baseLocalStatus.refName) {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (
            (event._tag === "snapshot" || event._tag === "localUpdated") &&
            event.local.refName === branchBLocal.refName
          ) {
            return Deferred.succeed(firstRefreshEventDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated") {
            return Effect.all(
              [
                Deferred.succeed(firstRefreshEventDeferred, event).pipe(Effect.ignore),
                event.remoteRefName === branchBLocal.refName
                  ? Deferred.succeed(branchBRemoteDeferred, event).pipe(Effect.ignore)
                  : Effect.void,
              ],
              { concurrency: "unbounded", discard: true },
            );
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(snapshotDeferred);
      yield* Deferred.await(firstRemoteStarted);
      state.currentLocalStatus = branchBLocal;
      state.currentRemoteStatus = branchBRemote;
      yield* Deferred.succeed(releaseFirstRemote, undefined);

      const branchBEvent = yield* Deferred.await(firstRefreshEventDeferred);
      assert.deepStrictEqual(branchBEvent, {
        _tag: "localUpdated",
        local: branchBLocal,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 1);

      const branchBRemoteEvent = yield* Deferred.await(branchBRemoteDeferred);
      assert.deepStrictEqual(branchBRemoteEvent, {
        _tag: "remoteUpdated",
        remote: branchBRemote,
        remoteRefName: branchBLocal.refName,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 2);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(testLayer, TestClock.layer())));
  });

  it.effect("does not commit a remote observation after a newer local refresh", () => {
    const branchBLocal = {
      ...baseLocalStatus,
      refName: "feature/post-validation-b",
    };
    const state = {
      currentLocalStatus: baseLocalStatus,
      localStatusCalls: 0,
    };
    let localAfterSelected: Deferred.Deferred<void> | null = null;
    let releaseLocalAfter: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.gen(function* () {
              state.localStatusCalls += 1;
              const selected = state.currentLocalStatus;
              if (state.localStatusCalls === 3) {
                if (localAfterSelected) {
                  yield* Deferred.succeed(localAfterSelected, undefined).pipe(Effect.ignore);
                }
                if (releaseLocalAfter) {
                  yield* Deferred.await(releaseLocalAfter);
                }
              }
              return selected;
            }),
          remoteStatus: () => Effect.succeed(remoteStatusWithPr),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      localAfterSelected = yield* Deferred.make<void>();
      releaseLocalAfter = yield* Deferred.make<void>();
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const streamScope = yield* Scope.make();
      const initialSnapshot = yield* Deferred.make<void>();
      const branchBPublished = yield* Deferred.make<void>();
      const events: Array<VcsStatusStreamEvent> = [];
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event._tag === "snapshot" && event.local.refName === baseLocalStatus.refName
                ? Deferred.succeed(initialSnapshot, undefined).pipe(Effect.ignore)
                : event._tag === "localUpdated" && event.local.refName === branchBLocal.refName
                  ? Deferred.succeed(branchBPublished, undefined).pipe(Effect.ignore)
                  : Effect.void,
            ),
          ),
      ).pipe(Effect.forkIn(streamScope));

      yield* Deferred.await(initialSnapshot);
      const staleRefresh = yield* broadcaster
        .refreshStatus("/repo")
        .pipe(Effect.forkIn(streamScope));
      yield* Deferred.await(localAfterSelected);

      state.currentLocalStatus = branchBLocal;
      yield* broadcaster.refreshLocalStatus("/repo");
      yield* Deferred.await(branchBPublished);
      yield* Deferred.succeed(releaseLocalAfter, undefined);

      const refreshed = yield* Fiber.join(staleRefresh);
      assert.deepStrictEqual(refreshed, {
        ...branchBLocal,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
      assert.deepStrictEqual(events, [
        { _tag: "snapshot", local: baseLocalStatus, remote: null },
        { _tag: "localUpdated", local: branchBLocal },
      ] satisfies ReadonlyArray<VcsStatusStreamEvent>);

      const cachedSnapshot = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      );
      assert.isTrue(Option.isSome(cachedSnapshot));
      if (Option.isSome(cachedSnapshot)) {
        assert.deepStrictEqual(cachedSnapshot.value, {
          _tag: "snapshot",
          local: branchBLocal,
          remote: null,
        } satisfies VcsStatusStreamEvent);
      }

      yield* Scope.close(streamScope, Exit.void);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns remote-unknown when a unary read crosses a local ref change", () => {
    const branchBLocal = {
      ...baseLocalStatus,
      refName: "feature/unary-race-b",
    };
    const branchBRemote = {
      ...baseRemoteStatus,
      behindCount: 4,
    };
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localInvalidationCalls: 0,
      remoteStatusCalls: 0,
    };
    let cachedLocalStatus: VcsStatusLocalResult | null = null;
    let firstRemoteStarted: Deferred.Deferred<void> | null = null;
    let releaseFirstRemote: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              cachedLocalStatus ??= state.currentLocalStatus;
              return cachedLocalStatus;
            }),
          remoteStatus: () =>
            Effect.gen(function* () {
              state.remoteStatusCalls += 1;
              const result = state.currentRemoteStatus;
              if (state.remoteStatusCalls === 1) {
                if (firstRemoteStarted) {
                  yield* Deferred.succeed(firstRemoteStarted, undefined).pipe(Effect.ignore);
                }
                if (releaseFirstRemote) {
                  yield* Deferred.await(releaseFirstRemote);
                }
              }
              return result;
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
              cachedLocalStatus = null;
            }),
          invalidateRemoteStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      firstRemoteStarted = yield* Deferred.make<void>();
      releaseFirstRemote = yield* Deferred.make<void>();
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstResultDeferred = yield* Deferred.make<VcsStatusResult>();
      yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(
        Effect.flatMap((result) => Deferred.succeed(firstResultDeferred, result)),
        Effect.forkScoped,
      );

      yield* Deferred.await(firstRemoteStarted);
      state.currentLocalStatus = branchBLocal;
      state.currentRemoteStatus = branchBRemote;
      yield* Deferred.succeed(releaseFirstRemote, undefined);

      const crossedResult = yield* Deferred.await(firstResultDeferred);
      assert.deepStrictEqual(crossedResult, {
        ...branchBLocal,
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });

      const stableResult = yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.deepStrictEqual(stableResult, {
        ...branchBLocal,
        ...branchBRemote,
      });
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 2);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("loads remote status once when periodic refreshes are disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated") {
            return Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      const snapshot = yield* Deferred.await(snapshotDeferred);
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(snapshot, {
        _tag: "snapshot",
        local: baseLocalStatus,
        remote: null,
      } satisfies VcsStatusStreamEvent);
      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [false]);

      yield* TestClock.adjust(Duration.minutes(2));
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it.effect("rearms a disabled periodic poller when the local ref changes", () => {
    const branchBLocal = {
      ...baseLocalStatus,
      refName: "feature/rearmed-disabled-poller",
    };
    const branchBRemote = {
      ...baseRemoteStatus,
      aheadCount: 9,
    };
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      const branchARemote = yield* Deferred.make<void>();
      const branchBRemotePublished = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo", includeRemote: true },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) => {
          if (event._tag === "remoteUpdated" && event.remoteRefName === baseLocalStatus.refName) {
            return Deferred.succeed(branchARemote, undefined).pipe(Effect.ignore);
          }
          if (event._tag === "remoteUpdated" && event.remoteRefName === branchBLocal.refName) {
            return Deferred.succeed(branchBRemotePublished, event).pipe(Effect.ignore);
          }
          return Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(branchARemote);
      assert.equal(state.remoteStatusCalls, 1);

      state.currentLocalStatus = branchBLocal;
      state.currentRemoteStatus = branchBRemote;
      yield* broadcaster.refreshLocalStatus("/repo");
      for (let attempt = 0; attempt < 100 && state.remoteStatusCalls < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      assert.equal(state.remoteStatusCalls, 2);
      const branchBEvent = yield* Deferred.await(branchBRemotePublished);
      assert.deepStrictEqual(branchBEvent, {
        _tag: "remoteUpdated",
        remote: branchBRemote,
        remoteRefName: branchBLocal.refName,
      } satisfies VcsStatusStreamEvent);

      yield* TestClock.adjust(Duration.minutes(10));
      assert.equal(state.remoteStatusCalls, 2);
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it.effect("retries the initial remote load when periodic refreshes are disabled", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };
    const privateCwd = "/private/user/workspace/repo";
    const nestedCause = new Error("private nested VCS failure");
    const messages: Array<ReadonlyArray<unknown>> = [];
    const logger = Logger.make<unknown, void>(({ message }) => {
      messages.push(message as ReadonlyArray<unknown>);
    });
    let firstRemoteAttemptDeferred: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: (_input, options) =>
            Effect.suspend(() => {
              state.remoteStatusCalls += 1;
              state.remoteStatusRefreshUpstreamValues.push(options?.refreshUpstream);
              if (state.remoteStatusCalls === 1) {
                return Effect.fail(
                  new GitManagerError({
                    operation: "VcsStatusBroadcaster.test",
                    cwd: privateCwd,
                    detail: "private initial remote status failure",
                    cause: nestedCause,
                  }),
                ).pipe(
                  Effect.ensuring(
                    firstRemoteAttemptDeferred
                      ? Deferred.succeed(firstRemoteAttemptDeferred, undefined).pipe(Effect.ignore)
                      : Effect.void,
                  ),
                );
              }
              return Effect.succeed(remoteStatusWithPr);
            }),
          invalidateLocalStatus: () =>
            Effect.sync(() => {
              state.localInvalidationCalls += 1;
            }),
          invalidateRemoteStatus: () =>
            Effect.sync(() => {
              state.remoteInvalidationCalls += 1;
            }),
        }),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      firstRemoteAttemptDeferred = yield* Deferred.make<void>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: privateCwd },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
        (event) =>
          event._tag === "remoteUpdated"
            ? Deferred.succeed(remoteUpdatedDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(firstRemoteAttemptDeferred);
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 1);
      assert.deepStrictEqual(
        messages.find((message) => message[0] === "VCS remote status refresh failed"),
        [
          "VCS remote status refresh failed",
          {
            cwdLength: privateCwd.length,
            reasonCount: 1,
            failureCount: 1,
            failureTags: ["GitManagerError"],
            failureOperations: ["VcsStatusBroadcaster.test"],
            defectCount: 0,
            defectTags: [],
            interruptionCount: 0,
            consecutiveFailures: 1,
            nextDelayMs: 30_000,
          },
        ],
      );

      yield* TestClock.adjust(Duration.seconds(30));
      const remoteUpdated = yield* Deferred.await(remoteUpdatedDeferred);

      assert.deepStrictEqual(remoteUpdated, {
        _tag: "remoteUpdated",
        remote: remoteStatusWithPr,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [false, false]);

      yield* Scope.close(scope, Exit.void);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer,
          TestClock.layer(),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("delays automatic refresh when a cached remote snapshot is available", () => {
    const state = {
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
      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.minutes(1)) },
        ),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(snapshotDeferred);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);

      yield* TestClock.adjust(Duration.seconds(59));
      assert.equal(state.remoteStatusCalls, 1);

      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 1);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
  });

  it("backs off remote refresh failures exponentially and honors larger configured intervals", () => {
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.seconds(1))),
      30_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(2, Duration.seconds(1))),
      60_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(3, Duration.seconds(1))),
      120_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(1, Duration.minutes(5))),
      300_000,
    );
    assert.equal(
      Duration.toMillis(VcsStatusBroadcaster.remoteRefreshFailureDelay(20, Duration.seconds(1))),
      900_000,
    );
  });

  it("summarizes refresh causes without exposing nested failure details", () => {
    const nestedCause = new Error("private nested failure detail");
    const failure = new GitManagerError({
      operation: "VcsStatusBroadcaster.remoteStatus",
      cwd: "/private/user/workspace/repo",
      detail: "private Git failure detail",
      cause: nestedCause,
    });
    const cause = Cause.combine(Cause.fail(failure), Cause.die(new TypeError("private defect")));

    assert.deepStrictEqual(VcsStatusBroadcaster.remoteRefreshFailureDiagnostics(cause), {
      reasonCount: 2,
      failureCount: 1,
      failureTags: ["GitManagerError"],
      failureOperations: ["VcsStatusBroadcaster.remoteStatus"],
      defectCount: 1,
      defectTags: ["TypeError"],
      interruptionCount: 0,
    });
  });

  it.effect("does not start automatic remote refreshes without foreground client demand", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => false)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: () =>
            Effect.sync(() => {
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
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const snapshot = yield* Stream.runHead(
        broadcaster.streamStatus(
          { cwd: "/repo" },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)) },
        ),
      );

      assert.isTrue(Option.isSome(snapshot));
      assert.equal(state.remoteStatusCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("releases remote work when a stream is canceled during initial acquisition", () => {
    let remoteStarted: Deferred.Deferred<void> | null = null;
    let remoteInterrupted: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            (remoteStarted
              ? Deferred.succeed(remoteStarted, undefined).pipe(Effect.ignore)
              : Effect.void
            ).pipe(
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                remoteInterrupted
                  ? Deferred.succeed(remoteInterrupted, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
            ),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      remoteStarted = yield* Deferred.make<void>();
      remoteInterrupted = yield* Deferred.make<void>();
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const streamScope = yield* Scope.make();
      yield* Stream.runDrain(
        broadcaster.streamStatus(
          { cwd: "/repo", includeRemote: true },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.seconds(1)) },
        ),
      ).pipe(Effect.forkIn(streamScope));

      yield* Deferred.await(remoteStarted);
      yield* Scope.close(streamScope, Exit.void);
      for (
        let attempt = 0;
        attempt < 100 && Option.isNone(yield* Deferred.poll(remoteInterrupted));
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("shares canonical remote demand until the final subscriber disconnects", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusCwds: [] as Array<string>,
    };
    let remoteInterruptedDeferred: Deferred.Deferred<void, never> | null = null;
    let remoteStartedDeferred: Deferred.Deferred<void, never> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
          remoteStatus: (input) =>
            Effect.sync(() => {
              state.remoteStatusCalls += 1;
              state.remoteStatusCwds.push(input.cwd);
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

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-shared-real-",
      });
      const linkParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-shared-link-",
      });
      const linkDir = path.join(linkParent, "repo-link");
      yield* fileSystem.symlink(realDir, linkDir);
      const canonicalCwd = yield* fileSystem.realPath(realDir);

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const firstInput = { cwd: linkDir, includeRemote: true };
      const secondInput = { cwd: realDir, includeRemote: true };
      yield* Stream.runForEach(broadcaster.streamStatus(firstInput), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus(secondInput), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(remoteStarted);

      assert.equal(state.remoteStatusCalls, 1);
      assert.deepStrictEqual(state.remoteStatusCwds, [canonicalCwd]);

      yield* Scope.close(firstScope, Exit.void);
      assert.isTrue(Option.isNone(yield* Deferred.poll(remoteInterrupted)));

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(remoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("releases remote work while a same-worktree local subscriber remains", () => {
    const nextLocalStatus = {
      ...baseLocalStatus,
      refName: "feature/local-subscriber-remains",
    } satisfies VcsStatusLocalResult;
    const state = {
      currentLocalStatus: baseLocalStatus,
      remoteStatusCalls: 0,
    };
    let remoteStartedDeferred: Deferred.Deferred<void> | null = null;
    let remoteInterruptedDeferred: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(state.currentLocalStatus),
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
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const remoteStarted = yield* Deferred.make<void>();
      const remoteInterrupted = yield* Deferred.make<void>();
      remoteStartedDeferred = remoteStarted;
      remoteInterruptedDeferred = remoteInterrupted;

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const localScope = yield* Scope.make();
      const remoteScope = yield* Scope.make();
      const localSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const localUpdate = yield* Deferred.make<VcsStatusStreamEvent>();

      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
        (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(localSnapshot, event).pipe(Effect.ignore);
          }
          return event._tag === "localUpdated" && event.local.refName === nextLocalStatus.refName
            ? Deferred.succeed(localUpdate, event).pipe(Effect.ignore)
            : Effect.void;
        },
      ).pipe(Effect.forkIn(localScope));
      yield* Stream.runForEach(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: true }),
        (event) =>
          event._tag === "snapshot"
            ? Deferred.succeed(remoteSnapshot, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkIn(remoteScope));

      yield* Deferred.await(localSnapshot);
      yield* Deferred.await(remoteSnapshot);
      yield* Deferred.await(remoteStarted);
      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(remoteScope, Exit.void);
      for (
        let attempt = 0;
        attempt < 100 && Option.isNone(yield* Deferred.poll(remoteInterrupted));
        attempt += 1
      ) {
        yield* Effect.yieldNow;
      }
      assert.isTrue(Option.isSome(yield* Deferred.poll(remoteInterrupted)));

      state.currentLocalStatus = nextLocalStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      assert.deepStrictEqual(yield* Deferred.await(localUpdate), {
        _tag: "localUpdated",
        local: nextLocalStatus,
      } satisfies VcsStatusStreamEvent);
      assert.equal(state.remoteStatusCalls, 1);

      yield* Scope.close(localScope, Exit.void);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("keeps remote pollers isolated across distinct canonical working directories", () => {
    const state = {
      localStatusCalls: 0,
      remoteStatusCwds: [] as Array<string>,
    };
    let firstCanonicalCwd = "";
    let secondCanonicalCwd = "";
    let firstRemoteStarted: Deferred.Deferred<void> | null = null;
    let secondRemoteStarted: Deferred.Deferred<void> | null = null;
    let firstRemoteInterrupted: Deferred.Deferred<void> | null = null;
    let secondRemoteInterrupted: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return baseLocalStatus;
            }),
          remoteStatus: (input) =>
            Effect.sync(() => {
              state.remoteStatusCwds.push(input.cwd);
            }).pipe(
              Effect.andThen(
                input.cwd === firstCanonicalCwd && firstRemoteStarted
                  ? Deferred.succeed(firstRemoteStarted, undefined).pipe(Effect.ignore)
                  : input.cwd === secondCanonicalCwd && secondRemoteStarted
                    ? Deferred.succeed(secondRemoteStarted, undefined).pipe(Effect.ignore)
                    : Effect.void,
              ),
              Effect.andThen(Effect.never as Effect.Effect<VcsStatusRemoteResult | null, never>),
              Effect.onInterrupt(() =>
                input.cwd === firstCanonicalCwd && firstRemoteInterrupted
                  ? Deferred.succeed(firstRemoteInterrupted, undefined).pipe(Effect.ignore)
                  : input.cwd === secondCanonicalCwd && secondRemoteInterrupted
                    ? Deferred.succeed(secondRemoteInterrupted, undefined).pipe(Effect.ignore)
                    : Effect.void,
              ),
            ),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      firstCanonicalCwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-isolated-first-",
      });
      secondCanonicalCwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-isolated-second-",
      });
      firstCanonicalCwd = yield* fileSystem.realPath(firstCanonicalCwd);
      secondCanonicalCwd = yield* fileSystem.realPath(secondCanonicalCwd);
      firstRemoteStarted = yield* Deferred.make<void>();
      secondRemoteStarted = yield* Deferred.make<void>();
      firstRemoteInterrupted = yield* Deferred.make<void>();
      secondRemoteInterrupted = yield* Deferred.make<void>();

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const secondSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
      const firstInput = { cwd: firstCanonicalCwd, includeRemote: true };
      const secondInput = { cwd: secondCanonicalCwd, includeRemote: true };
      yield* Stream.runForEach(broadcaster.streamStatus(firstInput), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(firstScope));
      yield* Stream.runForEach(broadcaster.streamStatus(secondInput), (event) =>
        event._tag === "snapshot"
          ? Deferred.succeed(secondSnapshot, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkIn(secondScope));

      yield* Deferred.await(firstSnapshot);
      yield* Deferred.await(secondSnapshot);
      yield* Deferred.await(firstRemoteStarted);
      yield* Deferred.await(secondRemoteStarted);

      assert.deepStrictEqual(
        state.remoteStatusCwds.toSorted(),
        [firstCanonicalCwd, secondCanonicalCwd].toSorted(),
      );
      assert.equal(state.localStatusCalls, 4);

      yield* Scope.close(firstScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(firstRemoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(firstRemoteInterrupted)));
      assert.isTrue(Option.isNone(yield* Deferred.poll(secondRemoteInterrupted)));
      assert.equal(state.remoteStatusCwds.length, 2);

      yield* Scope.close(secondScope, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(secondRemoteInterrupted);
      assert.isTrue(Option.isSome(yield* Deferred.poll(secondRemoteInterrupted)));
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("serializes periodic and explicit remote work across worktree aliases", () => {
    const state = {
      activeRemoteCalls: 0,
      maxActiveRemoteCalls: 0,
      remoteStatusCalls: 0,
      remoteStatusCwds: [] as Array<string>,
      remoteSeenBeforeSecondOperation: undefined as VcsStatusRemoteResult | null | undefined,
    };
    let pollerCwd = "/repo";
    let explicitCwd = "/repo";
    let inspectionCwd = "/repo";
    let broadcasterForInspection: VcsStatusBroadcaster.VcsStatusBroadcaster["Service"] | null =
      null;
    let firstRemoteStarted: Deferred.Deferred<void> | null = null;
    let releaseRemoteCalls: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: (input) =>
            Effect.gen(function* () {
              state.remoteStatusCalls += 1;
              state.remoteStatusCwds.push(input.cwd);
              const callNumber = state.remoteStatusCalls;
              state.activeRemoteCalls += 1;
              state.maxActiveRemoteCalls = Math.max(
                state.maxActiveRemoteCalls,
                state.activeRemoteCalls,
              );
              if (callNumber === 1 && firstRemoteStarted) {
                yield* Deferred.succeed(firstRemoteStarted, undefined).pipe(Effect.ignore);
              }
              if (callNumber === 2 && broadcasterForInspection) {
                const snapshot = yield* Stream.runHead(
                  broadcasterForInspection.streamStatus({
                    cwd: inspectionCwd,
                    includeRemote: false,
                  }),
                );
                state.remoteSeenBeforeSecondOperation =
                  Option.isSome(snapshot) && snapshot.value._tag === "snapshot"
                    ? snapshot.value.remote
                    : undefined;
              }
              if (releaseRemoteCalls) {
                yield* Deferred.await(releaseRemoteCalls);
              }
              return callNumber === 1 ? remoteStatusWithPr : baseRemoteStatus;
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  state.activeRemoteCalls -= 1;
                }),
              ),
            ),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      firstRemoteStarted = yield* Deferred.make<void>();
      releaseRemoteCalls = yield* Deferred.make<void>();
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const realDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-serialized-real-",
      });
      const linkParent = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-serialized-link-",
      });
      const linkDir = path.join(linkParent, "repo-link");
      yield* fileSystem.symlink(realDir, linkDir);
      pollerCwd = realDir;
      explicitCwd = linkDir;
      inspectionCwd = linkDir;
      const canonicalCwd = yield* fileSystem.realPath(realDir);
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      broadcasterForInspection = broadcaster;
      const scope = yield* Scope.make();
      yield* Stream.runDrain(
        broadcaster.streamStatus(
          { cwd: pollerCwd, includeRemote: true },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.zero) },
        ),
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(firstRemoteStarted);
      const explicitRefresh = yield* broadcaster
        .refreshStatus(explicitCwd)
        .pipe(Effect.forkIn(scope));
      yield* Effect.yieldNow;

      assert.equal(state.maxActiveRemoteCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);

      yield* Deferred.succeed(releaseRemoteCalls, undefined);
      const explicitResult = yield* Fiber.join(explicitRefresh);

      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.maxActiveRemoteCalls, 1);
      assert.equal(state.activeRemoteCalls, 0);
      assert.deepStrictEqual(state.remoteStatusCwds, [canonicalCwd, canonicalCwd]);
      assert.deepStrictEqual(state.remoteSeenBeforeSecondOperation, remoteStatusWithPr);
      assert.deepStrictEqual(explicitResult, { ...baseLocalStatus, ...baseRemoteStatus });
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("keeps an explicit refresh behind the periodic remote cache commit", () => {
    const state = {
      publishedRemoteResults: [] as Array<VcsStatusRemoteResult>,
      remoteStatusCalls: 0,
    };
    let pollerBeforeCommit: Deferred.Deferred<void> | null = null;
    let releasePollerCommit: Deferred.Deferred<void> | null = null;
    let explicitRemoteStarted: Deferred.Deferred<void> | null = null;
    let releaseExplicitRemote: Deferred.Deferred<void> | null = null;
    let secondPublicationObserved: Deferred.Deferred<void> | null = null;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            Effect.gen(function* () {
              state.remoteStatusCalls += 1;
              if (state.remoteStatusCalls === 2) {
                if (explicitRemoteStarted) {
                  yield* Deferred.succeed(explicitRemoteStarted, undefined).pipe(Effect.ignore);
                }
                if (releaseExplicitRemote) {
                  yield* Deferred.await(releaseExplicitRemote);
                }
                return baseRemoteStatus;
              }
              return remoteStatusWithPr;
            }),
          invalidateLocalStatus: () => Effect.void,
          invalidateRemoteStatus: () => Effect.void,
          invalidateStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      pollerBeforeCommit = yield* Deferred.make<void>();
      releasePollerCommit = yield* Deferred.make<void>();
      explicitRemoteStarted = yield* Deferred.make<void>();
      releaseExplicitRemote = yield* Deferred.make<void>();
      secondPublicationObserved = yield* Deferred.make<void>();
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const scope = yield* Scope.make();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo", includeRemote: true },
          {
            automaticRemoteRefreshInterval: Effect.succeed(Duration.zero),
            automaticRemoteRefreshBeforeCommit: Deferred.succeed(
              pollerBeforeCommit,
              undefined,
            ).pipe(Effect.ignore, Effect.andThen(Deferred.await(releasePollerCommit))),
          },
        ),
        (event) => {
          const remote =
            event._tag === "remoteUpdated"
              ? event.remote
              : event._tag === "snapshot"
                ? event.remote
                : null;
          if (remote === null) {
            return Effect.void;
          }
          state.publishedRemoteResults.push(remote);
          return state.publishedRemoteResults.length === 2 && secondPublicationObserved
            ? Deferred.succeed(secondPublicationObserved, undefined).pipe(Effect.ignore)
            : Effect.void;
        },
      ).pipe(Effect.forkIn(scope));

      yield* Deferred.await(pollerBeforeCommit);
      const explicitRefresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkIn(scope));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        yield* Effect.yieldNow;
      }

      assert.equal(state.remoteStatusCalls, 1);
      assert.isTrue(Option.isNone(yield* Deferred.poll(explicitRemoteStarted)));

      yield* Deferred.succeed(releasePollerCommit, undefined);
      yield* Deferred.await(explicitRemoteStarted);
      yield* Deferred.succeed(releaseExplicitRemote, undefined);
      const explicitResult = yield* Fiber.join(explicitRefresh);
      yield* Deferred.await(secondPublicationObserved);

      assert.deepStrictEqual(explicitResult, { ...baseLocalStatus, ...baseRemoteStatus });
      assert.deepStrictEqual(state.publishedRemoteResults, [remoteStatusWithPr, baseRemoteStatus]);
      const cachedSnapshot = yield* Stream.runHead(
        broadcaster.streamStatus({ cwd: "/repo", includeRemote: false }),
      );
      assert.isTrue(Option.isSome(cachedSnapshot));
      if (Option.isSome(cachedSnapshot)) {
        assert.deepStrictEqual(cachedSnapshot.value, {
          _tag: "snapshot",
          local: baseLocalStatus,
          remote: baseRemoteStatus,
          remoteRefName: baseLocalStatus.refName,
        } satisfies VcsStatusStreamEvent);
      }
      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(testLayer));
  });
});
