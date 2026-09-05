import { assert, it, describe } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
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
import * as GitHeadWatcher from "./GitHeadWatcher.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

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

function makeHeadWatcherLayer(fileSystem?: FileSystem.FileSystem) {
  return fileSystem
    ? Layer.succeed(GitHeadWatcher.GitHeadWatcher, {
        acquire: (directory) =>
          Effect.succeed(fileSystem.watch(directory).pipe(Stream.map((event) => event.path))),
      })
    : GitHeadWatcher.layer;
}

function makeTestLayer(
  state: {
    currentLocalStatus: VcsStatusLocalResult;
    currentRemoteStatus: VcsStatusRemoteResult | null;
    localStatusCalls: number;
    remoteStatusCalls: number;
    localInvalidationCalls: number;
    remoteInvalidationCalls: number;
    remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
    backgroundWorkEnabled?: boolean;
  },
  fileSystem?: FileSystem.FileSystem,
  workflowOverrides: Partial<GitWorkflowService.GitWorkflowService["Service"]> = {},
  headWatcherLayer?: Layer.Layer<GitHeadWatcher.GitHeadWatcher>,
) {
  const serviceLayer = VcsStatusBroadcaster.layer.pipe(
    Layer.provide(headWatcherLayer ?? makeHeadWatcherLayer(fileSystem)),
    Layer.provide(makeBackgroundPolicyLayer(() => state.backgroundWorkEnabled !== false)),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatusWatchPath: () => Effect.succeed(null),
        localStatus: Effect.fn("VcsStatusBroadcaster.test.localStatus")(function* () {
          yield* Effect.sync(() => {
            state.localStatusCalls += 1;
          });
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
        ...workflowOverrides,
      }),
    ),
  );

  return fileSystem
    ? serviceLayer.pipe(
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, fileSystem)),
        Layer.provideMerge(NodePath.layer),
      )
    : serviceLayer.pipe(Layer.provideMerge(NodeServices.layer));
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
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provide(GitHeadWatcher.layer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(makeBackgroundPolicyLayer(() => true)),
        Layer.provide(
          Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
            isEnabled: (cwd) => Effect.succeed(cwd === configuredWorkspaceRoot),
          }),
        ),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(localStatus),
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
      }).pipe(Effect.provide(testLayer));
    },
  );

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
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes a loaded cwd without reusing a previous branch's PR", () => {
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

      // Nobody loaded this cwd yet: no host request is spent.
      assert.isNull(yield* broadcaster.refreshPullRequestStatus("/repo"));
      assert.equal(state.remoteStatusCalls, 0);

      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.remoteStatusCalls, 1);

      // Loaded and no PR known: ask GitManager to retry the missing PR.
      state.currentRemoteStatus = remoteStatusWithPr;
      const refreshed = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);

      // The agent switches branches. The previous branch's PR must not block a read.
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      state.currentRemoteStatus = baseRemoteStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      const refreshedBranch = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshedBranch, baseRemoteStatus);
      assert.equal(state.remoteStatusCalls, 3);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("a poll that started before the turn-end refresh cannot overwrite its PR", () => {
    const releaseFirstPoll = Deferred.makeUnsafe<void>();
    const firstPollStarted = Deferred.makeUnsafe<void>();
    let remoteReads = 0;
    const layer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(GitHeadWatcher.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: () =>
            Effect.gen(function* () {
              remoteReads += 1;
              if (remoteReads === 2) {
                // Hold an older empty response while the turn-end refresh queues.
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
      Layer.provide(GitHeadWatcher.layer),
      Layer.provide(FileSystem.layerNoop({ realPath: (path) => Effect.succeed(path) })),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
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
          invalidateStatus: () => Effect.void,
        }),
      ),
    );
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstReadStarted);
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      // Run ready fibers before releasing the delayed first read.
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

  it.effect("turn-end refresh skips a loaded cwd when background policy pauses it", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      backgroundWorkEnabled: false,
    };
    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
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
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.localInvalidationCalls, 1);
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
      Layer.provide(GitHeadWatcher.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatusWatchPath: () => Effect.succeed(null),
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

  it.effect("refreshes only the cached local snapshot when requested", () => {
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

      const refreshedLocal = yield* broadcaster.refreshLocalStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshedLocal, state.currentLocalStatus);
      assert.deepStrictEqual(cached, {
        ...state.currentLocalStatus,
        ...baseRemoteStatus,
      });
      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
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
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provide(GitHeadWatcher.layer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(makeBackgroundPolicyLayer(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatusWatchPath: () => Effect.succeed(null),
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

        assert.deepStrictEqual(seenCwds, [realPath, realPath]);
        assert.equal(state.localStatusCalls, 1);
        assert.equal(state.remoteStatusCalls, 1);
      }).pipe(Effect.provide(testLayer));
    },
  );

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

  it.live("loads the initial local status before starting the HEAD watcher", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-initial-load-",
      });
      const gitDirectory = `${cwd}/.git`;
      const headPath = `${gitDirectory}/HEAD`;
      yield* fileSystem.makeDirectory(gitDirectory);
      yield* fileSystem.writeFileString(headPath, "ref: refs/heads/main\n");

      const localStatusStarted = yield* Deferred.make<void>();
      const releaseLocalStatus = yield* Deferred.make<void>();
      const watcherStarted = yield* Deferred.make<void>();
      const testFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        watch: () =>
          Stream.unwrap(
            Deferred.succeed(watcherStarted, undefined).pipe(
              Effect.ignore,
              Effect.as(Stream.never),
            ),
          ),
      };
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const localStatus = Effect.fn("VcsStatusBroadcaster.test.blockedInitialLocalStatus")(
        function* () {
          state.localStatusCalls += 1;
          yield* Deferred.succeed(localStatusStarted, undefined).pipe(Effect.ignore);
          yield* Deferred.await(releaseLocalStatus);
          return state.currentLocalStatus;
        },
      );

      const program = Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd }), (event) => {
          return event._tag === "snapshot"
            ? Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore)
            : Effect.void;
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(localStatusStarted);
        const watcherBeforeLoad = yield* Deferred.poll(watcherStarted);
        assert.isTrue(Option.isNone(watcherBeforeLoad));

        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "feature/during-initial-load",
        };
        yield* Deferred.succeed(releaseLocalStatus, undefined);

        yield* Deferred.await(watcherStarted);
        const snapshot = yield* Deferred.await(snapshotDeferred);
        assert.deepStrictEqual(snapshot, {
          _tag: "snapshot",
          local: state.currentLocalStatus,
          remote: null,
        } satisfies VcsStatusStreamEvent);
      });

      yield* program.pipe(
        Effect.provide(
          makeTestLayer(state, testFileSystem, {
            localStatus,
            localStatusWatchPath: () => Effect.succeed(headPath),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("corrects a branch changed during watch acquisition after registration commits", () =>
    Effect.gen(function* () {
      const opening = yield* Deferred.make<void>();
      const releaseOpen = yield* Deferred.make<void>();
      const initialSnapshot = yield* Deferred.make<void>();
      const correction = yield* Deferred.make<void>();
      const releaseRemote = yield* Deferred.make<void>();
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      let registered = false;
      const headWatcherLayer = Layer.succeed(GitHeadWatcher.GitHeadWatcher, {
        acquire: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(opening, undefined);
            yield* Deferred.await(releaseOpen);
            registered = true;
            return Stream.never;
          }),
      });

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
          if (event._tag === "snapshot") return Deferred.succeed(initialSnapshot, undefined);
          if (event._tag === "localUpdated" && event.local.refName === "feature/during-open") {
            assert.isTrue(registered);
            return Deferred.succeed(correction, undefined);
          }
          return Effect.void;
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(opening);
        yield* Deferred.await(initialSnapshot);
        assert.isFalse(registered);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/during-open" };
        yield* Deferred.succeed(releaseOpen, undefined);
        yield* Deferred.await(correction);
        yield* Deferred.succeed(releaseRemote, undefined);
        assert.equal(
          (yield* broadcaster.getStatus({ cwd: "/repo" })).refName,
          "feature/during-open",
        );
      }).pipe(
        Effect.provide(
          makeTestLayer(
            state,
            undefined,
            {
              localStatusWatchPath: () => Effect.succeed(".git/HEAD"),
              remoteStatus: () => Deferred.await(releaseRemote).pipe(Effect.as(baseRemoteStatus)),
            },
            headWatcherLayer,
          ),
        ),
      );
    }),
  );

  it.effect.each(["acquire", "stream"] as const)(
    "reconciles after a %s failure without retaining the failed watch",
    (failurePhase) =>
      Effect.gen(function* () {
        const firstEvents = yield* Queue.unbounded<string, PlatformError.PlatformError>();
        const initialSnapshot = yield* Deferred.make<void>();
        const correction = yield* Deferred.make<void>();
        const firstReleased = yield* Deferred.make<void>();
        let acquireCalls = 0;
        let activeWatches = 0;
        let releases = 0;
        const failure = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: "watch",
        });
        const state = {
          currentLocalStatus: baseLocalStatus,
          currentRemoteStatus: baseRemoteStatus,
          localStatusCalls: 0,
          remoteStatusCalls: 0,
          localInvalidationCalls: 0,
          remoteInvalidationCalls: 0,
        };
        const headWatcherLayer = Layer.succeed(GitHeadWatcher.GitHeadWatcher, {
          acquire: () =>
            Effect.gen(function* () {
              acquireCalls += 1;
              const call = acquireCalls;
              if (call === 1 && failurePhase === "acquire") return yield* Effect.fail(failure);
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  activeWatches += 1;
                }),
                () =>
                  Effect.gen(function* () {
                    activeWatches -= 1;
                    releases += 1;
                    if (call === 1) yield* Deferred.succeed(firstReleased, undefined);
                  }),
              );
              return call === 1 ? Stream.fromQueue(firstEvents) : Stream.never;
            }),
        });

        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          const subscriber = yield* Stream.runForEach(
            broadcaster.streamStatus({ cwd: "/repo" }),
            (event) => {
              if (event._tag === "snapshot") return Deferred.succeed(initialSnapshot, undefined);
              if (
                event._tag === "localUpdated" &&
                event.local.refName === "feature/while-unwatched"
              ) {
                return Deferred.succeed(correction, undefined);
              }
              return Effect.void;
            },
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(initialSnapshot);
          if (failurePhase === "stream") {
            yield* Queue.failCause(firstEvents, Cause.fail(failure));
            yield* Deferred.await(firstReleased);
          }
          state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/while-unwatched" };
          yield* TestClock.adjust(Duration.seconds(1));
          yield* Deferred.await(correction);
          assert.equal(acquireCalls, 2);
          assert.equal(activeWatches, 1);
          assert.equal(releases, failurePhase === "stream" ? 1 : 0);
          assert.equal(
            (yield* broadcaster.getStatus({ cwd: "/repo" })).refName,
            "feature/while-unwatched",
          );
          yield* Fiber.interrupt(subscriber);
          assert.equal(activeWatches, 0);
          assert.equal(releases, failurePhase === "stream" ? 2 : 1);
        }).pipe(
          Effect.provide(
            makeTestLayer(
              state,
              undefined,
              { localStatusWatchPath: () => Effect.succeed(".git/HEAD") },
              headWatcherLayer,
            ),
          ),
        );
      }),
  );

  it.effect(
    "releases a watch interrupted during acquisition before another subscriber starts",
    () =>
      Effect.gen(function* () {
        const opening = yield* Deferred.make<void>();
        const firstSnapshot = yield* Deferred.make<void>();
        const secondSnapshot = yield* Deferred.make<void>();
        let acquireCalls = 0;
        let activeWatches = 0;
        const state = {
          currentLocalStatus: baseLocalStatus,
          currentRemoteStatus: baseRemoteStatus,
          localStatusCalls: 0,
          remoteStatusCalls: 0,
          localInvalidationCalls: 0,
          remoteInvalidationCalls: 0,
        };
        const headWatcherLayer = Layer.succeed(GitHeadWatcher.GitHeadWatcher, {
          acquire: () =>
            Effect.gen(function* () {
              acquireCalls += 1;
              yield* Effect.acquireRelease(
                Effect.sync(() => {
                  activeWatches += 1;
                }),
                () =>
                  Effect.sync(() => {
                    activeWatches -= 1;
                  }),
              );
              if (acquireCalls === 1) {
                yield* Deferred.succeed(opening, undefined);
                return yield* Effect.never;
              }
              return Stream.never;
            }),
        });
        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          const first = yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), () =>
            Deferred.succeed(firstSnapshot, undefined),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(opening);
          yield* Deferred.await(firstSnapshot);
          yield* Fiber.interrupt(first);
          assert.equal(activeWatches, 0);
          const second = yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), () =>
            Deferred.succeed(secondSnapshot, undefined),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(secondSnapshot);
          assert.equal(acquireCalls, 2);
          assert.equal(activeWatches, 1);
          yield* Fiber.interrupt(second);
          assert.equal(activeWatches, 0);
        }).pipe(
          Effect.provide(
            makeTestLayer(
              state,
              undefined,
              { localStatusWatchPath: () => Effect.succeed(".git/HEAD") },
              headWatcherLayer,
            ),
          ),
        );
      }),
  );

  it.live("reconciles local status after starting the HEAD watcher", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-watch-handoff-",
      });
      const gitDirectory = `${cwd}/.git`;
      const headPath = `${gitDirectory}/HEAD`;
      yield* fileSystem.makeDirectory(gitDirectory);
      yield* fileSystem.writeFileString(headPath, "ref: refs/heads/main\n");

      const switchedLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/during-watch-handoff",
      };
      let localStatusCalls = 0;
      let localStatusInvalidated = false;
      const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const testFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        watch: () => Stream.fromQueue(watchEvents),
      };
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provide(makeHeadWatcherLayer(testFileSystem)),
        Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, testFileSystem)),
        Layer.provideMerge(NodePath.layer),
        Layer.provide(makeBackgroundPolicyLayer(() => true)),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatusWatchPath: () => Effect.succeed(headPath),
            localStatus: () =>
              Effect.sync(() => {
                localStatusCalls += 1;
                return localStatusInvalidated ? switchedLocalStatus : baseLocalStatus;
              }),
            remoteStatus: () => Effect.succeed(baseRemoteStatus),
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                localStatusInvalidated = true;
              }),
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
          }),
        ),
      );

      const snapshot = yield* Stream.runHead(
        VcsStatusBroadcaster.VcsStatusBroadcaster.pipe(
          Effect.map((broadcaster) => broadcaster.streamStatus({ cwd })),
          Stream.unwrap,
        ),
      ).pipe(Effect.provide(testLayer));

      assert.deepStrictEqual(
        snapshot,
        Option.some({
          _tag: "snapshot",
          local: switchedLocalStatus,
          remote: null,
        } satisfies VcsStatusStreamEvent),
      );
      assert.equal(localStatusCalls, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reconciles local status when joining an existing HEAD watcher", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-watch-joiner-",
      });
      const gitDirectory = `${cwd}/.git`;
      const headPath = `${gitDirectory}/HEAD`;
      yield* fileSystem.makeDirectory(gitDirectory);
      yield* fileSystem.writeFileString(headPath, "ref: refs/heads/main\n");

      const testFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        watch: () => Stream.never,
      };
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      const program = Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const firstSnapshot = yield* Deferred.make<VcsStatusStreamEvent>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd }), (event) => {
          return event._tag === "snapshot"
            ? Deferred.succeed(firstSnapshot, event).pipe(Effect.ignore)
            : Effect.void;
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(firstSnapshot);

        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "feature/before-joiner-handoff",
        };
        const joinerSnapshot = yield* Stream.runHead(broadcaster.streamStatus({ cwd }));

        assert.deepStrictEqual(
          joinerSnapshot,
          Option.some({
            _tag: "snapshot",
            local: state.currentLocalStatus,
            remote: baseRemoteStatus,
          } satisfies VcsStatusStreamEvent),
        );
        assert.equal(state.localStatusCalls, 4);
        assert.equal(state.localInvalidationCalls, 3);
      });

      yield* program.pipe(
        Effect.provide(
          makeTestLayer(state, testFileSystem, {
            localStatusWatchPath: () => Effect.succeed(headPath),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not hold the watcher map lock while resolving the HEAD path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const firstCwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-lock-first-",
      });
      const secondCwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-lock-second-",
      });
      const gitDirectory = `${firstCwd}/.git`;
      const headPath = `${gitDirectory}/HEAD`;
      yield* fileSystem.makeDirectory(gitDirectory);
      yield* fileSystem.writeFileString(headPath, "ref: refs/heads/main\n");

      const firstWatchPathAttempt = yield* Deferred.make<void>();
      const secondWatchPathAttempt = yield* Deferred.make<void>();
      const releaseFirstWatchPath = yield* Deferred.make<void>();
      const secondLocalStatusCompleted = yield* Deferred.make<void>();
      let localStatusWatchPathCalls = 0;
      const testFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        watch: () => Stream.empty,
      };
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const localStatus = Effect.fn("VcsStatusBroadcaster.test.concurrentLocalStatus")(
        function* () {
          state.localStatusCalls += 1;
          if (state.localStatusCalls === 2) {
            yield* Deferred.succeed(secondLocalStatusCompleted, undefined).pipe(Effect.ignore);
          }
          return state.currentLocalStatus;
        },
      );
      const localStatusWatchPath = Effect.fn(
        "VcsStatusBroadcaster.test.blockedLocalStatusWatchPath",
      )(function* () {
        localStatusWatchPathCalls += 1;
        if (localStatusWatchPathCalls === 1) {
          yield* Deferred.succeed(firstWatchPathAttempt, undefined).pipe(Effect.ignore);
          yield* Deferred.await(releaseFirstWatchPath);
        } else if (localStatusWatchPathCalls === 2) {
          yield* Deferred.succeed(secondWatchPathAttempt, undefined).pipe(Effect.ignore);
        }
        return headPath;
      });

      const program = Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* Stream.runDrain(broadcaster.streamStatus({ cwd: firstCwd })).pipe(Effect.forkScoped);
        yield* Deferred.await(firstWatchPathAttempt);

        yield* Stream.runDrain(broadcaster.streamStatus({ cwd: secondCwd })).pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(secondLocalStatusCompleted);
        yield* Deferred.await(secondWatchPathAttempt);
        yield* Deferred.succeed(releaseFirstWatchPath, undefined);
      });

      yield* program.pipe(
        Effect.provide(makeTestLayer(state, testFileSystem, { localStatus, localStatusWatchPath })),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not let a subscriber handoff overwrite a newer HEAD update", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const handoffStarted = yield* Deferred.make<void>();
      const releaseHandoff = yield* Deferred.make<void>();
      const firstSnapshot = yield* Deferred.make<void>();
      const branchUpdated = yield* Deferred.make<void>();
      let holdNextLocalRead = false;
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const localStatus = Effect.fn("VcsStatusBroadcaster.test.concurrentHandoff")(function* () {
        state.localStatusCalls += 1;
        const status = state.currentLocalStatus;
        if (holdNextLocalRead) {
          holdNextLocalRead = false;
          yield* Deferred.succeed(handoffStarted, undefined);
          yield* Deferred.await(releaseHandoff);
        }
        return status;
      });

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(firstSnapshot, undefined);
          }
          if (event._tag === "localUpdated") {
            return Deferred.succeed(branchUpdated, undefined);
          }
          return Effect.void;
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(firstSnapshot);

        holdNextLocalRead = true;
        const joiner = yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo" })).pipe(
          Effect.forkScoped,
        );
        yield* Deferred.await(handoffStarted);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/from-terminal" };
        yield* Queue.offer(watchEvents, { _tag: "Update", path: "HEAD" });
        yield* TestClock.adjust(Duration.millis(50));
        yield* Deferred.succeed(releaseHandoff, undefined);
        yield* Fiber.join(joiner);
        yield* Deferred.await(branchUpdated);

        const cached = yield* broadcaster.getStatus({ cwd: "/repo" });
        assert.equal(cached.refName, "feature/from-terminal");
      }).pipe(
        Effect.provide(
          makeTestLayer(
            state,
            { ...fileSystem, watch: () => Stream.fromQueue(watchEvents) },
            { localStatus, localStatusWatchPath: () => Effect.succeed(".git/HEAD") },
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["refreshLocalStatus", "refreshStatus"] as const)(
    "%s cannot overwrite a newer completed HEAD refresh",
    (method) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
        const firstSnapshot = yield* Deferred.make<void>();
        const manualReadStarted = yield* Deferred.make<void>();
        const releaseManualRead = yield* Deferred.make<void>();
        const branchUpdated = yield* Deferred.make<void>();
        const state = {
          currentLocalStatus: baseLocalStatus,
          currentRemoteStatus: baseRemoteStatus,
          localStatusCalls: 0,
          remoteStatusCalls: 0,
          localInvalidationCalls: 0,
          remoteInvalidationCalls: 0,
        };
        const publishedRefs: Array<string | null> = [];
        let holdNextLocalRead = false;
        const localStatus = Effect.fn("VcsStatusBroadcaster.test.heldManualRead")(function* () {
          state.localStatusCalls += 1;
          const status = state.currentLocalStatus;
          if (holdNextLocalRead) {
            holdNextLocalRead = false;
            yield* Deferred.succeed(manualReadStarted, undefined);
            yield* Deferred.await(releaseManualRead);
          }
          return status;
        });

        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
            if (event._tag === "snapshot" || event._tag === "localUpdated") {
              publishedRefs.push(event.local.refName);
              if (event.local.refName === "feature/new-head") {
                return Deferred.succeed(branchUpdated, undefined);
              }
            }
            return event._tag === "snapshot"
              ? Deferred.succeed(firstSnapshot, undefined)
              : Effect.void;
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(firstSnapshot);
          holdNextLocalRead = true;
          const manual = yield* broadcaster[method]("/repo").pipe(Effect.forkScoped);
          yield* Deferred.await(manualReadStarted);
          state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/new-head" };
          yield* Queue.offer(watchEvents, { _tag: "Update", path: "HEAD" });
          yield* TestClock.adjust(Duration.millis(50));
          yield* Deferred.await(branchUpdated);
          yield* Deferred.succeed(releaseManualRead, undefined);
          const refreshed = yield* Fiber.join(manual);
          assert.equal(refreshed.refName, "feature/new-head");
          assert.equal(
            (yield* broadcaster.getStatus({ cwd: "/repo" })).refName,
            "feature/new-head",
          );
          assert.deepStrictEqual(publishedRefs, [baseLocalStatus.refName, "feature/new-head"]);
        }).pipe(
          Effect.provide(
            makeTestLayer(
              state,
              { ...fileSystem, watch: () => Stream.fromQueue(watchEvents) },
              { localStatus, localStatusWatchPath: () => Effect.succeed(".git/HEAD") },
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([false, true])(
    "retains completed local reads while a newer read is pending, newer read fails=%s",
    (failNewerRead) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
        const firstSnapshot = yield* Deferred.make<void>();
        const olderReadStarted = yield* Deferred.make<void>();
        const releaseOlderRead = yield* Deferred.make<void>();
        const newerReadStarted = yield* Deferred.make<void>();
        const releaseNewerRead = yield* Deferred.make<void>();
        const newerReadFailed = yield* Deferred.make<void>();
        const newerBranchUpdated = yield* Deferred.make<void>();
        let gatedReadCount: number | null = null;
        const state = {
          currentLocalStatus: baseLocalStatus,
          currentRemoteStatus: baseRemoteStatus,
          localStatusCalls: 0,
          remoteStatusCalls: 0,
          localInvalidationCalls: 0,
          remoteInvalidationCalls: 0,
        };
        const localStatus = Effect.fn("VcsStatusBroadcaster.test.orderedLocalReads")(function* () {
          state.localStatusCalls += 1;
          const call = gatedReadCount === null ? 0 : ++gatedReadCount;
          const status = state.currentLocalStatus;
          if (call === 1) {
            yield* Deferred.succeed(olderReadStarted, undefined);
            yield* Deferred.await(releaseOlderRead);
          } else if (call === 2) {
            yield* Deferred.succeed(newerReadStarted, undefined);
            yield* Deferred.await(releaseNewerRead);
            if (failNewerRead) {
              yield* Deferred.succeed(newerReadFailed, undefined);
              return yield* Effect.fail(
                new GitManagerError({
                  operation: "VcsStatusBroadcaster.test.orderedLocalReads",
                  cwd: "/repo",
                  detail: "The newer local read failed.",
                }),
              );
            }
          }
          return status;
        });

        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
            if (event._tag === "snapshot") return Deferred.succeed(firstSnapshot, undefined);
            if (event._tag === "localUpdated" && event.local.refName === "feature/newer") {
              return Deferred.succeed(newerBranchUpdated, undefined);
            }
            return Effect.void;
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(firstSnapshot);
          gatedReadCount = 0;
          state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/older-completed" };
          const older = yield* broadcaster.refreshLocalStatus("/repo").pipe(Effect.forkScoped);
          yield* Deferred.await(olderReadStarted);
          state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/newer" };
          yield* Queue.offer(watchEvents, { _tag: "Update", path: "HEAD" });
          yield* TestClock.adjust(Duration.millis(50));
          yield* Deferred.await(newerReadStarted);
          yield* Deferred.succeed(releaseOlderRead, undefined);
          assert.equal((yield* Fiber.join(older)).refName, "feature/older-completed");
          assert.equal(
            (yield* broadcaster.getStatus({ cwd: "/repo" })).refName,
            "feature/older-completed",
          );

          yield* Deferred.succeed(releaseNewerRead, undefined);
          if (failNewerRead) {
            yield* Deferred.await(newerReadFailed);
            assert.equal(
              (yield* broadcaster.getStatus({ cwd: "/repo" })).refName,
              "feature/older-completed",
            );
            yield* Queue.offer(watchEvents, { _tag: "Update", path: "HEAD" });
            yield* TestClock.adjust(Duration.millis(50));
          }
          yield* Deferred.await(newerBranchUpdated);
          assert.equal((yield* broadcaster.getStatus({ cwd: "/repo" })).refName, "feature/newer");
        }).pipe(
          Effect.provide(
            makeTestLayer(
              state,
              { ...fileSystem, watch: () => Stream.fromQueue(watchEvents) },
              { localStatus, localStatusWatchPath: () => Effect.succeed(".git/HEAD") },
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    ["getStatus", true],
    ["getStatus", false],
    ["refreshStatus", true],
    ["refreshStatus", false],
    ["autoPull", true],
    ["autoPull", false],
  ] as const)(
    "%s preserves newer HEAD updates without blocking remote reads",
    ([method, changedBranch]) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
        const firstSnapshot = yield* Deferred.make<void>();
        const remoteReadStarted = yield* Deferred.make<void>();
        const releaseRemoteRead = yield* Deferred.make<void>();
        const branchUpdated = yield* Deferred.make<void>();
        const snapshots: Array<VcsStatusStreamEvent> = [];
        const nextRef = changedBranch ? "feature/during-remote" : "main";
        const state = {
          currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
          currentRemoteStatus: baseRemoteStatus,
          localStatusCalls: 0,
          remoteStatusCalls: 0,
          localInvalidationCalls: 0,
          remoteInvalidationCalls: 0,
        };
        const blockedRemoteRead = method === "getStatus" ? 1 : method === "autoPull" ? 3 : 2;
        const remoteStatus = Effect.fn("VcsStatusBroadcaster.test.heldRemoteRead")(function* () {
          state.remoteStatusCalls += 1;
          const call = state.remoteStatusCalls;
          if (call === blockedRemoteRead) {
            yield* Deferred.succeed(remoteReadStarted, undefined);
            yield* Deferred.await(releaseRemoteRead);
          }
          return {
            ...baseRemoteStatus,
            behindCount: method === "autoPull" && call < 3 ? 1 : 0,
            pr: call === blockedRemoteRead ? remoteStatusWithPr.pr : null,
          };
        });

        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          const subscribe = Stream.runForEach(
            broadcaster.streamStatus({ cwd: "/repo" }),
            (event) => {
              if (event._tag === "snapshot") {
                snapshots.push(event);
                return Deferred.succeed(firstSnapshot, undefined);
              }
              if (
                event._tag === "localUpdated" &&
                event.local.refName === nextRef &&
                event.local.hasWorkingTreeChanges
              ) {
                return Deferred.succeed(branchUpdated, undefined);
              }
              return Effect.void;
            },
          );
          if (method !== "getStatus") {
            yield* broadcaster.getStatus({ cwd: "/repo" });
            yield* subscribe.pipe(Effect.forkScoped);
            yield* Deferred.await(firstSnapshot);
          }
          const read = yield* (
            method === "getStatus"
              ? broadcaster.getStatus({ cwd: "/repo" })
              : broadcaster.refreshStatus("/repo")
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(remoteReadStarted);
          if (method === "getStatus") {
            yield* subscribe.pipe(Effect.forkScoped);
            yield* Deferred.await(firstSnapshot);
          }

          state.currentLocalStatus = {
            ...baseLocalStatus,
            isDefaultRef: false,
            refName: nextRef,
            hasWorkingTreeChanges: true,
          };
          yield* Queue.offer(watchEvents, { _tag: "Update", path: "HEAD" });
          yield* TestClock.adjust(Duration.millis(50));
          yield* Deferred.await(branchUpdated);
          yield* Deferred.succeed(releaseRemoteRead, undefined);
          const refreshed = yield* Fiber.join(read);
          assert.equal(refreshed.refName, nextRef);
          assert.deepStrictEqual(refreshed.pr, changedBranch ? null : remoteStatusWithPr.pr);
          assert.equal((yield* broadcaster.getStatus({ cwd: "/repo" })).refName, nextRef);
          yield* TestClock.adjust(Duration.zero);
          if (changedBranch) assert.equal(snapshots.length, 1);
        }).pipe(
          Effect.provide(
            makeTestLayer(
              state,
              { ...fileSystem, watch: () => Stream.fromQueue(watchEvents) },
              {
                remoteStatus,
                localStatusWatchPath: () => Effect.succeed(".git/HEAD"),
                pullCurrentBranch: () =>
                  Effect.succeed({ status: "pulled", refName: "main", upstreamRef: "origin/main" }),
              },
            ).pipe(
              Layer.provide(
                Layer.succeed(VcsStatusBroadcaster.VcsAutoPullPolicy, {
                  isEnabled: () => Effect.succeed(method === "autoPull"),
                }),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("a failed newer local read does not discard the current branch's remote result", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const firstSnapshot = yield* Deferred.make<void>();
      const remoteStarted = yield* Deferred.make<void>();
      const releaseRemote = yield* Deferred.make<void>();
      const newerReadFailed = yield* Deferred.make<void>();
      let failNextLocalRead = false;
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const localStatus = Effect.fn("VcsStatusBroadcaster.test.failedNewerBranch")(function* () {
        if (failNextLocalRead) {
          failNextLocalRead = false;
          yield* Deferred.succeed(newerReadFailed, undefined);
          return yield* Effect.fail(
            new GitManagerError({
              operation: "VcsStatusBroadcaster.test.failedNewerBranch",
              cwd: "/repo",
              detail: "The newer branch read failed.",
            }),
          );
        }
        return state.currentLocalStatus;
      });
      const remoteStatus = Effect.fn("VcsStatusBroadcaster.test.currentBranchRemote")(function* () {
        state.remoteStatusCalls += 1;
        if (state.remoteStatusCalls === 2) {
          yield* Deferred.succeed(remoteStarted, undefined);
          yield* Deferred.await(releaseRemote);
          return remoteStatusWithPr;
        }
        return baseRemoteStatus;
      });
      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/repo" });
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
          event._tag === "snapshot" ? Deferred.succeed(firstSnapshot, undefined) : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(firstSnapshot);
        const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
        yield* Deferred.await(remoteStarted);
        state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/unreadable" };
        failNextLocalRead = true;
        yield* Queue.offer(watchEvents, { _tag: "Update", path: "HEAD" });
        yield* TestClock.adjust(Duration.millis(50));
        yield* Deferred.await(newerReadFailed);
        yield* Deferred.succeed(releaseRemote, undefined);
        const refreshed = yield* Fiber.join(refresh);
        assert.equal(refreshed.refName, baseLocalStatus.refName);
        assert.deepStrictEqual(refreshed.pr, remoteStatusWithPr.pr);
        assert.deepStrictEqual(
          (yield* broadcaster.getStatus({ cwd: "/repo" })).pr,
          remoteStatusWithPr.pr,
        );
      }).pipe(
        Effect.provide(
          makeTestLayer(
            state,
            { ...fileSystem, watch: () => Stream.fromQueue(watchEvents) },
            { localStatus, remoteStatus, localStatusWatchPath: () => Effect.succeed(".git/HEAD") },
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an initial local load cannot overwrite a completed manual refresh", () => {
    const initialReadStarted = Deferred.makeUnsafe<void>();
    const releaseInitialRead = Deferred.makeUnsafe<void>();
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const localStatus = Effect.fn("VcsStatusBroadcaster.test.heldInitialLoad")(function* () {
      state.localStatusCalls += 1;
      const status = state.currentLocalStatus;
      if (state.localStatusCalls === 1) {
        yield* Deferred.succeed(initialReadStarted, undefined);
        yield* Deferred.await(releaseInitialRead);
      }
      return status;
    });

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const initial = yield* Stream.runHead(broadcaster.streamStatus({ cwd: "/repo" })).pipe(
        Effect.forkScoped,
      );
      yield* Deferred.await(initialReadStarted);
      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/manual-refresh" };
      yield* broadcaster.refreshLocalStatus("/repo");
      yield* Deferred.succeed(releaseInitialRead, undefined);
      const snapshot = yield* Fiber.join(initial);
      assert.isTrue(Option.isSome(snapshot));
      if (Option.isSome(snapshot) && snapshot.value._tag === "snapshot") {
        assert.equal(snapshot.value.local.refName, "feature/manual-refresh");
      }
      assert.equal(
        (yield* broadcaster.getStatus({ cwd: "/repo" })).refName,
        "feature/manual-refresh",
      );
    }).pipe(Effect.provide(makeTestLayer(state, undefined, { localStatus })));
  });

  it.effect.each([true, false])(
    "resets watcher retry delay after a healthy watch, event=%s",
    (deliverEvent) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent, Cause.Done>();
        const firstSnapshot = yield* Deferred.make<void>();
        const branchUpdated = yield* Deferred.make<void>();
        let watchCalls = 0;
        const testFileSystem: FileSystem.FileSystem = {
          ...fileSystem,
          watch: () =>
            Stream.unwrap(
              Effect.sync(() => {
                watchCalls += 1;
                if (watchCalls < 3) {
                  return Stream.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "watch",
                      pathOrDescriptor: "/repo/.git",
                    }),
                  );
                }
                return watchCalls === 3 ? Stream.fromQueue(watchEvents) : Stream.never;
              }),
            ),
        };
        const state = {
          currentLocalStatus: baseLocalStatus,
          currentRemoteStatus: baseRemoteStatus,
          localStatusCalls: 0,
          remoteStatusCalls: 0,
          localInvalidationCalls: 0,
          remoteInvalidationCalls: 0,
        };

        yield* Effect.gen(function* () {
          const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
          yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) => {
            if (event._tag === "snapshot") return Deferred.succeed(firstSnapshot, undefined);
            if (event._tag === "localUpdated") return Deferred.succeed(branchUpdated, undefined);
            return Effect.void;
          }).pipe(Effect.forkScoped);
          yield* Deferred.await(firstSnapshot);
          yield* TestClock.adjust(Duration.seconds(3));
          assert.equal(watchCalls, 3);
          if (deliverEvent) {
            state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/recovered" };
            yield* Queue.offer(watchEvents, { _tag: "Update", path: "HEAD" });
            yield* TestClock.adjust(Duration.millis(50));
            yield* Deferred.await(branchUpdated);
          } else {
            yield* TestClock.adjust(Duration.minutes(1));
          }
          yield* Queue.end(watchEvents);
          yield* TestClock.adjust(Duration.seconds(1));
          assert.equal(watchCalls, 4);
        }).pipe(
          Effect.provide(
            makeTestLayer(state, testFileSystem, {
              localStatusWatchPath: () => Effect.succeed(".git/HEAD"),
            }),
          ),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not release a watcher retained by another subscriber after git init", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      let hasRepository = false;
      let stoppedWatches = 0;
      const watchStarted = yield* Deferred.make<void>();
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const testFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        watch: () =>
          Stream.unwrap(
            Effect.acquireRelease(Deferred.succeed(watchStarted, undefined), () =>
              Effect.sync(() => {
                stoppedWatches += 1;
              }),
            ).pipe(Effect.as(Stream.never)),
          ),
      };

      yield* Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const beforeInitSnapshot = yield* Deferred.make<void>();
        const beforeInit = yield* Stream.runForEach(
          broadcaster.streamStatus({ cwd: "/repo" }),
          () => Deferred.succeed(beforeInitSnapshot, undefined),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(beforeInitSnapshot);

        hasRepository = true;
        const afterInitSnapshot = yield* Deferred.make<void>();
        const afterInit = yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), () =>
          Deferred.succeed(afterInitSnapshot, undefined),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(afterInitSnapshot);
        yield* Deferred.await(watchStarted);
        yield* Fiber.interrupt(beforeInit);
        assert.equal(stoppedWatches, 0);
        yield* Fiber.interrupt(afterInit);
        assert.equal(stoppedWatches, 1);
      }).pipe(
        Effect.provide(
          makeTestLayer(state, testFileSystem, {
            localStatusWatchPath: () => Effect.sync(() => (hasRepository ? ".git/HEAD" : null)),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("streams a branch change made outside the VCS actions", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-head-watch-",
      });
      const gitDirectory = `${cwd}/.git`;
      const headPath = `${gitDirectory}/HEAD`;
      yield* fileSystem.makeDirectory(gitDirectory);
      yield* fileSystem.writeFileString(headPath, "ref: refs/heads/main\n");

      const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const testFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        watch: () => Stream.fromQueue(watchEvents),
      };
      let localStatusWatchPathCalls = 0;
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      const program = Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        const localUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd }), (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "localUpdated") {
            return Deferred.succeed(localUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(snapshotDeferred);
        assert.equal(localStatusWatchPathCalls, 1);
        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "feature/from-terminal",
        };
        yield* Queue.offer(watchEvents, { _tag: "Update", path: headPath });

        const localUpdated = yield* Deferred.await(localUpdatedDeferred);

        assert.deepStrictEqual(localUpdated, {
          _tag: "localUpdated",
          local: state.currentLocalStatus,
        } satisfies VcsStatusStreamEvent);
      });

      yield* program.pipe(
        Effect.provide(
          makeTestLayer(state, testFileSystem, {
            localStatusWatchPath: () =>
              Effect.sync(() => {
                localStatusWatchPathCalls += 1;
                return headPath;
              }),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not retain the local watcher when the initial local load fails", () => {
    let localStatusFailuresRemaining = 1;
    let localStatusWatchPathCalls = 0;
    let headPath: string | null = null;
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const localStatus = Effect.fn("VcsStatusBroadcaster.test.failingInitialLocalStatus")(
      function* () {
        state.localStatusCalls += 1;
        if (localStatusFailuresRemaining > 0) {
          localStatusFailuresRemaining -= 1;
          return yield* Effect.fail(
            new GitManagerError({
              operation: "VcsStatusBroadcaster.test.localStatus",
              cwd: "/repo",
              detail: "local status failed",
            }),
          );
        }
        return state.currentLocalStatus;
      },
    );

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-setup-failure-",
      });
      const gitDirectory = `${cwd}/.git`;
      headPath = `${gitDirectory}/HEAD`;
      yield* fileSystem.makeDirectory(gitDirectory);
      yield* fileSystem.writeFileString(`${gitDirectory}/HEAD`, "ref: refs/heads/main\n");

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const failure = yield* Stream.runHead(broadcaster.streamStatus({ cwd })).pipe(Effect.flip);
      assert.instanceOf(failure, GitManagerError);
      assert.equal(localStatusWatchPathCalls, 0);

      const snapshot = yield* Stream.runHead(broadcaster.streamStatus({ cwd }));
      assert.isTrue(Option.isSome(snapshot));
      assert.equal(localStatusWatchPathCalls, 1);
    }).pipe(
      Effect.provide(
        makeTestLayer(state, undefined, {
          localStatus,
          localStatusWatchPath: () =>
            Effect.sync(() => {
              localStatusWatchPathCalls += 1;
              return headPath;
            }),
        }),
      ),
    );
  });

  it.live("restarts the local watcher after a filesystem failure and transient null path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-watch-restart-",
      });
      const gitDirectory = `${cwd}/.git`;
      const headPath = `${gitDirectory}/HEAD`;
      yield* fileSystem.makeDirectory(gitDirectory);
      yield* fileSystem.writeFileString(headPath, "ref: refs/heads/main\n");

      let watchCalls = 0;
      const firstWatchAttempt = yield* Deferred.make<void>();
      const secondWatchAttempt = yield* Deferred.make<void>();
      let localStatusWatchPathCalls = 0;
      const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const testFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        watch: (watchPath) =>
          Stream.unwrap(
            Effect.gen(function* () {
              watchCalls += 1;
              if (watchCalls === 1) {
                yield* Deferred.succeed(firstWatchAttempt, undefined).pipe(Effect.ignore);
                return Stream.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "watch",
                    pathOrDescriptor: String(watchPath),
                    description: "Transient watch failure for the regression test.",
                  }),
                );
              }
              yield* Deferred.succeed(secondWatchAttempt, undefined).pipe(Effect.ignore);
              return Stream.fromQueue(watchEvents);
            }),
          ),
      };
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };

      const program = Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        const localUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd }), (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "localUpdated") {
            return Deferred.succeed(localUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(snapshotDeferred);
        yield* Deferred.await(firstWatchAttempt);
        assert.equal(watchCalls, 1);
        yield* Deferred.await(secondWatchAttempt);
        assert.equal(watchCalls, 2);
        assert.equal(localStatusWatchPathCalls, 3);

        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "feature/after-watch-restart",
        };
        yield* Queue.offer(watchEvents, { _tag: "Update", path: headPath });

        const localUpdated = yield* Deferred.await(localUpdatedDeferred);
        assert.deepStrictEqual(localUpdated, {
          _tag: "localUpdated",
          local: state.currentLocalStatus,
        } satisfies VcsStatusStreamEvent);
      });

      yield* program.pipe(
        Effect.provide(
          makeTestLayer(state, testFileSystem, {
            localStatusWatchPath: () =>
              Effect.sync(() => {
                localStatusWatchPathCalls += 1;
                return localStatusWatchPathCalls === 2 ? null : headPath;
              }),
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("retries HEAD path resolution after a transient failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-vcs-status-watch-path-retry-",
      });
      const gitDirectory = `${cwd}/.git`;
      const headPath = `${gitDirectory}/HEAD`;
      yield* fileSystem.makeDirectory(gitDirectory);
      yield* fileSystem.writeFileString(headPath, "ref: refs/heads/main\n");

      const firstWatchPathAttempt = yield* Deferred.make<void>();
      const secondWatchPathAttempt = yield* Deferred.make<void>();
      let localStatusWatchPathCalls = 0;
      const watchEvents = yield* Queue.unbounded<FileSystem.WatchEvent>();
      const testFileSystem: FileSystem.FileSystem = {
        ...fileSystem,
        watch: () => Stream.fromQueue(watchEvents),
      };
      const state = {
        currentLocalStatus: baseLocalStatus,
        currentRemoteStatus: baseRemoteStatus,
        localStatusCalls: 0,
        remoteStatusCalls: 0,
        localInvalidationCalls: 0,
        remoteInvalidationCalls: 0,
      };
      const localStatusWatchPath = Effect.fn(
        "VcsStatusBroadcaster.test.retryingLocalStatusWatchPath",
      )(function* () {
        localStatusWatchPathCalls += 1;
        if (localStatusWatchPathCalls === 1) {
          yield* Deferred.succeed(firstWatchPathAttempt, undefined).pipe(Effect.ignore);
          return yield* Effect.fail(
            new GitManagerError({
              operation: "VcsStatusBroadcaster.test.localStatusWatchPath",
              cwd: "/repo",
              detail: "HEAD path resolution failed",
            }),
          );
        }
        yield* Deferred.succeed(secondWatchPathAttempt, undefined).pipe(Effect.ignore);
        return headPath;
      });

      const program = Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        const localUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
        yield* Stream.runForEach(broadcaster.streamStatus({ cwd }), (event) => {
          if (event._tag === "snapshot") {
            return Deferred.succeed(snapshotDeferred, event).pipe(Effect.ignore);
          }
          if (event._tag === "localUpdated") {
            return Deferred.succeed(localUpdatedDeferred, event).pipe(Effect.ignore);
          }
          return Effect.void;
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(snapshotDeferred);
        yield* Deferred.await(firstWatchPathAttempt);
        yield* Deferred.await(secondWatchPathAttempt);
        assert.equal(localStatusWatchPathCalls, 2);

        state.currentLocalStatus = {
          ...baseLocalStatus,
          refName: "feature/after-watch-path-retry",
        };
        yield* Queue.offer(watchEvents, { _tag: "Update", path: headPath });

        const localUpdated = yield* Deferred.await(localUpdatedDeferred);
        assert.deepStrictEqual(localUpdated, {
          _tag: "localUpdated",
          local: state.currentLocalStatus,
        } satisfies VcsStatusStreamEvent);
      });

      yield* program.pipe(
        Effect.provide(makeTestLayer(state, testFileSystem, { localStatusWatchPath })),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
      Layer.provide(GitHeadWatcher.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatusWatchPath: () => Effect.succeed(null),
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
      Layer.provide(GitHeadWatcher.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => false)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatusWatchPath: () => Effect.succeed(null),
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

  it.effect("stops the remote poller after the last stream subscriber disconnects", () => {
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
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(GitHeadWatcher.layer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(makeBackgroundPolicyLayer(() => true)),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatusWatchPath: () => Effect.succeed(null),
          localStatus: () =>
            Effect.sync(() => {
              state.localStatusCalls += 1;
              return state.currentLocalStatus;
            }),
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
    }).pipe(Effect.provide(testLayer));
  });
});
