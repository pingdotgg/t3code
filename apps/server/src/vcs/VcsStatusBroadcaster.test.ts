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
    headRef: "codex/connection-state-audit",
    state: "open",
  },
};

const baseStatus: VcsStatusResult = {
  ...baseLocalStatus,
  ...baseRemoteStatus,
};

function layerTestFor(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  backgroundWorkEnabled?: boolean;
  automaticFetchInterval?: Effect.Effect<Duration.Duration>;
  beforeRemoteStatus?: Effect.Effect<void>;
  headPath?: string;
  headPathCalls?: number;
  failLocalStatus?: boolean;
  onLocalStatusFailure?: Effect.Effect<void>;
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
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
            return state.failLocalStatus
              ? (state.onLocalStatusFailure ?? Effect.void).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new GitManagerError({
                        operation: "VcsStatusBroadcaster.test",
                        cwd: "/repo",
                        detail: "index.lock is held",
                      }),
                    ),
                  ),
                )
              : Effect.succeed(state.currentLocalStatus);
          }),
        // Captured before the hook, like a read that resolved the branch and then waits on
        // its PR lookup.
        remoteStatus: (_input, options) =>
          Effect.suspend(() => {
            const remote = state.currentRemoteStatus;
            return (state.beforeRemoteStatus ?? Effect.void).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  state.remoteStatusCalls += 1;
                  state.remoteStatusRefreshUpstreamValues?.push(options?.refreshUpstream);
                  return remote;
                }),
              ),
            );
          }),
        checkedOutBranch: () => Effect.sync(() => state.currentLocalStatus.refName),
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

      assert.isNull(yield* broadcaster.refreshPullRequestStatus("/repo"));
      assert.equal(state.remoteStatusCalls, 0);

      yield* broadcaster.getStatus({ cwd: "/repo" });
      assert.equal(state.remoteStatusCalls, 1);

      state.currentRemoteStatus = remoteStatusWithPr;
      const refreshed = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshed, remoteStatusWithPr);
      assert.equal(state.remoteStatusCalls, 2);
      assert.equal(state.remoteInvalidationCalls, 0);

      state.currentLocalStatus = { ...baseLocalStatus, refName: "feature/next" };
      state.currentRemoteStatus = baseRemoteStatus;
      yield* broadcaster.refreshLocalStatus("/repo");
      const refreshedBranch = yield* broadcaster.refreshPullRequestStatus("/repo");
      assert.deepStrictEqual(refreshedBranch, baseRemoteStatus);
      assert.equal(state.remoteStatusCalls, 3);
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

  it.effect("an explicit refresh reads local totals after the fetch", () => {
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
      const fetchStarted = yield* Deferred.make<void>();
      const finishFetch = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(fetchStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishFetch)),
      );
      const refresh = yield* broadcaster.refreshStatus("/repo").pipe(Effect.forkScoped);
      yield* Deferred.await(fetchStarted);

      const fetchedLocal: VcsStatusLocalResult = {
        ...baseLocalStatus,
        branchChanges: { baseRef: "origin/main", insertions: 0, deletions: 0 },
      };
      state.currentLocalStatus = fetchedLocal;
      yield* Deferred.succeed(finishFetch, undefined);

      const status = yield* Fiber.join(refresh);
      assert.deepStrictEqual(status.branchChanges, fetchedLocal.branchChanges);
    }).pipe(Effect.provide(layerTestFor(state)));
  });

  it.effect("a background poll publishes a branch checked out outside T3 Code", () => {
    const state = {
      currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
      currentRemoteStatus: remoteStatusWithPr as VcsStatusRemoteResult | null,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      // Seeding the cache leaves the 30s poll as the only refresh.
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const clientStates: Array<VcsStatusResult> = [];
      const subscribed = yield* Deferred.make<void>();
      const polled = yield* Deferred.make<void>();
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        Effect.gen(function* () {
          clientStates.push(applyGitStatusStreamEvent(clientStates.at(-1) ?? null, event));
          yield* Deferred.succeed(clientStates.length === 1 ? subscribed : polled, undefined);
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(subscribed);

      // `git switch -c repro` in the terminal: nothing calls a refresh RPC.
      state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName: "repro" };
      state.currentRemoteStatus = { ...baseRemoteStatus, hasUpstream: false };
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Deferred.await(polled);

      // One event, so the new branch is never shown with the previous branch's PR.
      assert.strictEqual(clientStates.length, 2);
      assert.strictEqual(clientStates[1]?.refName, "repro");
      assert.strictEqual(clientStates[1]?.pr, null);
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("a checkout during a poll's remote read cannot pair branches", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
      currentRemoteStatus: { ...remoteStatusWithPr, aheadCount: 1 },
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
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

      const lookupStarted = yield* Deferred.make<void>();
      const finishLookup = yield* Deferred.make<void>();
      state.beforeRemoteStatus = Deferred.succeed(lookupStarted, undefined).pipe(
        Effect.andThen(Deferred.await(finishLookup)),
      );
      // The poll reads main's remote and is still looking up its PR.
      state.currentRemoteStatus = { ...remoteStatusWithPr, aheadCount: 2 };
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Deferred.await(lookupStarted);
      delete state.beforeRemoteStatus;
      // `git switch -c repro` in the terminal lands before the poll reads local status.
      state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName: "repro" };
      state.currentRemoteStatus = { ...baseRemoteStatus, hasUpstream: false };
      yield* Deferred.succeed(finishLookup, undefined);
      yield* Deferred.await(checkedOut);

      assert.deepStrictEqual(
        clientStates.map((status) => [
          status.refName,
          status.pr?.number ?? null,
          status.aheadCount,
        ]),
        [
          ["main", remoteStatusWithPr.pr?.number, 1],
          ["repro", null, 0],
        ],
      );
    }).pipe(Effect.provide(layerTestFor(state)), Effect.scoped);
  });

  it.effect("a poll whose local read fails publishes nothing and the next poll recovers", () => {
    const state: Parameters<typeof layerTestFor>[0] = {
      currentLocalStatus: { ...baseLocalStatus, isDefaultRef: true, refName: "main" },
      currentRemoteStatus: remoteStatusWithPr,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      const clientStates: Array<VcsStatusResult> = [];
      const received = [yield* Deferred.make<void>()];
      yield* Stream.runForEach(broadcaster.streamStatus({ cwd: "/repo" }), (event) =>
        Effect.gen(function* () {
          clientStates.push(applyGitStatusStreamEvent(clientStates.at(-1) ?? null, event));
          yield* Deferred.succeed(received[clientStates.length - 1]!, undefined);
        }),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(received[0]!);

      // An editor commit holds index.lock while main moves ahead.
      state.failLocalStatus = true;
      state.currentRemoteStatus = { ...remoteStatusWithPr, aheadCount: 1 };
      let failedLocalCalls = state.localStatusCalls;
      received.push(yield* Deferred.make<void>());
      yield* TestClock.adjust(Duration.seconds(30));
      assert.strictEqual(state.localStatusCalls, failedLocalCalls + 1);
      assert.strictEqual(clientStates.length, 1);

      // The lock clears on the same branch: the counts still differ from the cache, so the
      // next poll reads local status again instead of keeping the old totals.
      state.failLocalStatus = false;
      state.currentLocalStatus = {
        ...state.currentLocalStatus,
        hasWorkingTreeChanges: true,
        workingTree: { files: [], insertions: 3, deletions: 0 },
      };
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Deferred.await(received[1]!);
      assert.deepStrictEqual(
        [
          clientStates[1]?.refName,
          clientStates[1]?.aheadCount,
          clientStates[1]?.pr,
          clientStates[1]?.hasWorkingTreeChanges,
        ],
        ["main", 1, remoteStatusWithPr.pr, true],
      );

      // Still locked after `git switch -c repro`: repro's remote cannot go out under main.
      state.currentLocalStatus = { ...baseLocalStatus, isDefaultRef: false, refName: "repro" };
      state.currentRemoteStatus = { ...baseRemoteStatus, hasUpstream: false };
      state.failLocalStatus = true;
      failedLocalCalls = state.localStatusCalls;
      received.push(yield* Deferred.make<void>());
      yield* TestClock.adjust(Duration.seconds(30));
      assert.strictEqual(state.localStatusCalls, failedLocalCalls + 1);
      assert.strictEqual(clientStates.length, 2);

      state.failLocalStatus = false;
      yield* TestClock.adjust(Duration.seconds(30));
      yield* Deferred.await(received[2]!);
      assert.strictEqual(clientStates.length, 3);
      assert.deepStrictEqual(
        [clientStates[2]?.refName, clientStates[2]?.hasUpstream, clientStates[2]?.pr],
        ["repro", false, null],
      );
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
          checkedOutBranch: () => Effect.succeed(baseLocalStatus.refName),
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
