import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
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
  VcsStatusInput,
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusResult,
  VcsStatusStreamEvent,
} from "@t3tools/contracts";
import { GitManagerError, ProjectId } from "@t3tools/contracts";

import * as VcsStatusBroadcaster from "./VcsStatusBroadcaster.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";

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

function makeTestLayer(state: {
  currentLocalStatus: VcsStatusLocalResult;
  currentRemoteStatus: VcsStatusRemoteResult | null;
  localStatusCalls: number;
  remoteStatusCalls: number;
  localInvalidationCalls: number;
  remoteInvalidationCalls: number;
  remoteStatusRefreshUpstreamValues?: Array<boolean | undefined>;
  seenInputs?: VcsStatusInput[];
}) {
  return VcsStatusBroadcaster.layer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(
      Layer.mock(GitWorkflowService.GitWorkflowService)({
        localStatus: (input) =>
          Effect.sync(() => {
            state.seenInputs?.push(input);
            state.localStatusCalls += 1;
            return state.currentLocalStatus;
          }),
        remoteStatus: (input, options) =>
          Effect.sync(() => {
            state.seenInputs?.push(input);
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
      assert.equal(state.localStatusCalls, 1);
      assert.equal(state.remoteStatusCalls, 1);
      assert.equal(state.localInvalidationCalls, 0);
      assert.equal(state.remoteInvalidationCalls, 0);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("keeps project-aware status cache entries isolated", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      seenInputs: [] as VcsStatusInput[],
    };
    const projectId = ProjectId.make("project-one");

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      yield* broadcaster.getStatus({ cwd: "/repo", projectId });
      yield* broadcaster.getStatus({ cwd: "/repo", projectId });
      yield* broadcaster.refreshStatus({ cwd: "/repo", projectId });

      assert.equal(state.localStatusCalls, 2);
      assert.equal(state.remoteStatusCalls, 2);
      assert.deepStrictEqual(state.seenInputs, [
        { cwd: "/repo", projectId },
        { cwd: "/repo", projectId },
        { cwd: "/repo", projectId },
        { cwd: "/repo", projectId },
      ]);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("propagates a project-scoped refresh to sibling cache entries for the same cwd", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
    };
    const projectOne = ProjectId.make("project-one");
    const projectTwo = ProjectId.make("project-two");

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

      const initialBare = yield* broadcaster.getStatus({ cwd: "/repo" });
      const initialProjectOne = yield* broadcaster.getStatus({
        cwd: "/repo",
        projectId: projectOne,
      });
      const initialProjectTwo = yield* broadcaster.getStatus({
        cwd: "/repo",
        projectId: projectTwo,
      });

      state.currentLocalStatus = {
        ...baseLocalStatus,
        refName: "feature/project-scoped-refresh",
      };
      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        aheadCount: 4,
      };
      const expected = {
        ...state.currentLocalStatus,
        ...state.currentRemoteStatus,
      };

      const refreshed = yield* broadcaster.refreshStatus({ cwd: "/repo", projectId: projectOne });
      const cachedBare = yield* broadcaster.getStatus({ cwd: "/repo" });
      const cachedProjectTwo = yield* broadcaster.getStatus({
        cwd: "/repo",
        projectId: projectTwo,
      });

      assert.deepStrictEqual(initialBare, baseStatus);
      assert.deepStrictEqual(initialProjectOne, baseStatus);
      assert.deepStrictEqual(initialProjectTwo, baseStatus);
      assert.deepStrictEqual(refreshed, expected);
      assert.deepStrictEqual(cachedBare, expected);
      assert.deepStrictEqual(cachedProjectTwo, expected);
      // Three initial loads plus one refresh fan-out across all three cache keys.
      assert.equal(state.localStatusCalls, 6);
      assert.equal(state.remoteStatusCalls, 6);
      assert.equal(state.localInvalidationCalls, 1);
      assert.equal(state.remoteInvalidationCalls, 1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("starts every cached sibling refresh before waiting for one to finish", () => {
    const projectOne = ProjectId.make("project-one");
    const projectTwo = ProjectId.make("project-two");
    let refreshing = false;
    let bareSiblingStarted: Deferred.Deferred<void>;
    let projectSiblingStarted: Deferred.Deferred<void>;
    let releaseSiblings: Deferred.Deferred<void>;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: () => Effect.succeed(baseLocalStatus),
          remoteStatus: (input) =>
            Effect.gen(function* () {
              if (!refreshing || input.projectId === projectOne) {
                return baseRemoteStatus;
              }
              yield* Deferred.succeed(
                input.projectId === undefined ? bareSiblingStarted : projectSiblingStarted,
                undefined,
              );
              yield* Deferred.await(releaseSiblings);
              return baseRemoteStatus;
            }),
          invalidateStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      bareSiblingStarted = yield* Deferred.make<void>();
      projectSiblingStarted = yield* Deferred.make<void>();
      releaseSiblings = yield* Deferred.make<void>();

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo" });
      yield* broadcaster.getStatus({ cwd: "/repo", projectId: projectOne });
      yield* broadcaster.getStatus({ cwd: "/repo", projectId: projectTwo });

      refreshing = true;
      const refreshFiber = yield* broadcaster
        .refreshStatus({ cwd: "/repo", projectId: projectOne })
        .pipe(Effect.forkChild({ startImmediately: true }));

      yield* Deferred.await(bareSiblingStarted);
      yield* Deferred.await(projectSiblingStarted);
      yield* Deferred.succeed(releaseSiblings, undefined);
      yield* Fiber.join(refreshFiber);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect(
    "keeps the primary full refresh authoritative and continues after a typed sibling failure",
    () => {
      const projectOne = ProjectId.make("project-one");
      const projectTwo = ProjectId.make("project-two");
      const refreshedLocal = { ...baseLocalStatus, refName: "feature/isolated-sibling" };
      const refreshedRemote = { ...baseRemoteStatus, aheadCount: 7 };
      const refreshLocalInputs: VcsStatusInput[] = [];
      const refreshRemoteInputs: VcsStatusInput[] = [];
      const messages: Array<ReadonlyArray<unknown>> = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        messages.push(message as ReadonlyArray<unknown>);
      });
      let refreshing = false;
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: (input) =>
              Effect.sync(() => {
                if (refreshing) refreshLocalInputs.push(input);
                return refreshing ? refreshedLocal : baseLocalStatus;
              }),
            remoteStatus: (input) =>
              Effect.suspend(() => {
                if (refreshing) refreshRemoteInputs.push(input);
                if (refreshing && input.projectId === undefined) {
                  return Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test.sibling",
                      cwd: input.cwd,
                      detail: "private sibling detail",
                    }),
                  );
                }
                return Effect.succeed(refreshing ? refreshedRemote : baseRemoteStatus);
              }),
            invalidateStatus: () => Effect.void,
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
      );

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/private/repo" });
        yield* broadcaster.getStatus({ cwd: "/private/repo", projectId: projectOne });
        yield* broadcaster.getStatus({ cwd: "/private/repo", projectId: projectTwo });

        refreshing = true;
        const primary = yield* broadcaster.refreshStatus({
          cwd: "/private/repo",
          projectId: projectOne,
        });
        const laterSibling = yield* broadcaster.getStatus({
          cwd: "/private/repo",
          projectId: projectTwo,
        });

        assert.deepStrictEqual(primary, { ...refreshedLocal, ...refreshedRemote });
        assert.deepStrictEqual(laterSibling, primary);
        assert.deepStrictEqual(refreshLocalInputs, [
          { cwd: "/private/repo", projectId: projectOne },
          { cwd: "/private/repo" },
          { cwd: "/private/repo", projectId: projectTwo },
        ]);
        assert.deepStrictEqual(refreshRemoteInputs, refreshLocalInputs);
        assert.deepStrictEqual(
          messages.find((message) => message[0] === "VCS sibling status refresh failed"),
          [
            "VCS sibling status refresh failed",
            {
              refreshKind: "full",
              cwdLength: "/private/repo".length,
              primaryProjectId: projectOne,
              failureTag: "GitManagerError",
              failureOperation: "VcsStatusBroadcaster.test.sibling",
            },
          ],
        );
      }).pipe(
        Effect.provide(
          Layer.merge(
            testLayer,
            Logger.layer([logger], {
              mergeWithExisting: false,
            }),
          ),
        ),
      );
    },
  );

  it.effect("still fails when the primary refresh has a typed service error", () => {
    const projectOne = ProjectId.make("project-one");
    const projectTwo = ProjectId.make("project-two");
    const refreshInputs: VcsStatusInput[] = [];
    let refreshing = false;
    const testLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus: (input) =>
            Effect.sync(() => {
              if (refreshing) refreshInputs.push(input);
              return baseLocalStatus;
            }),
          remoteStatus: (input) =>
            Effect.suspend(() => {
              if (refreshing) refreshInputs.push(input);
              return refreshing && input.projectId === projectOne
                ? Effect.fail(
                    new GitManagerError({
                      operation: "VcsStatusBroadcaster.test.primary",
                      cwd: input.cwd,
                      detail: "primary failed",
                    }),
                  )
                : Effect.succeed(baseRemoteStatus);
            }),
          invalidateStatus: () => Effect.void,
        } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
      ),
    );

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo", projectId: projectOne });
      yield* broadcaster.getStatus({ cwd: "/repo", projectId: projectTwo });

      refreshing = true;
      const exit = yield* broadcaster
        .refreshStatus({ cwd: "/repo", projectId: projectOne })
        .pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.equal(
        refreshInputs.some((input) => input.projectId === projectTwo),
        false,
      );
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("does not turn sibling defects or interruption into best-effort success", () =>
    Effect.forEach(["defect", "interrupt"] as const, (failureMode) => {
      const projectOne = ProjectId.make(`project-one-${failureMode}`);
      const projectTwo = ProjectId.make(`project-two-${failureMode}`);
      let refreshing = false;
      const testLayer = VcsStatusBroadcaster.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provide(
          Layer.mock(GitWorkflowService.GitWorkflowService)({
            localStatus: () => Effect.succeed(baseLocalStatus),
            remoteStatus: (input) => {
              if (!refreshing || input.projectId === projectOne) {
                return Effect.succeed(baseRemoteStatus);
              }
              return failureMode === "defect"
                ? Effect.die(new Error("sibling defect"))
                : Effect.interrupt;
            },
            invalidateStatus: () => Effect.void,
          } satisfies Partial<GitWorkflowService.GitWorkflowService["Service"]>),
        ),
      );

      return Effect.gen(function* () {
        const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
        yield* broadcaster.getStatus({ cwd: "/repo", projectId: projectOne });
        yield* broadcaster.getStatus({ cwd: "/repo", projectId: projectTwo });

        refreshing = true;
        const exit = yield* broadcaster
          .refreshStatus({ cwd: "/repo", projectId: projectOne })
          .pipe(Effect.exit);

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          assert.equal(
            failureMode === "defect"
              ? Cause.hasDies(exit.cause)
              : Cause.hasInterruptsOnly(exit.cause),
            true,
          );
        }
      }).pipe(Effect.provide(testLayer));
    }),
  );

  it.effect("propagates periodic remote refreshes to sibling project cache entries", () => {
    const state = {
      currentLocalStatus: baseLocalStatus,
      currentRemoteStatus: baseRemoteStatus,
      localStatusCalls: 0,
      remoteStatusCalls: 0,
      localInvalidationCalls: 0,
      remoteInvalidationCalls: 0,
      remoteStatusRefreshUpstreamValues: [] as Array<boolean | undefined>,
    };
    const projectOne = ProjectId.make("project-one");
    const projectTwo = ProjectId.make("project-two");

    return Effect.gen(function* () {
      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.getStatus({ cwd: "/repo", projectId: projectOne });
      yield* broadcaster.getStatus({ cwd: "/repo", projectId: projectTwo });

      state.currentRemoteStatus = {
        ...baseRemoteStatus,
        behindCount: 3,
      };

      const scope = yield* Scope.make();
      const snapshotDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      const remoteUpdatedDeferred = yield* Deferred.make<VcsStatusStreamEvent>();
      yield* Stream.runForEach(
        broadcaster.streamStatus(
          { cwd: "/repo", projectId: projectOne },
          { automaticRemoteRefreshInterval: Effect.succeed(Duration.minutes(1)) },
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

      yield* Deferred.await(snapshotDeferred);
      yield* TestClock.adjust(Duration.minutes(1));
      yield* Deferred.await(remoteUpdatedDeferred);

      const siblingStatus = yield* broadcaster.getStatus({
        cwd: "/repo",
        projectId: projectTwo,
      });
      assert.equal(siblingStatus.behindCount, 3);
      assert.deepStrictEqual(state.remoteStatusRefreshUpstreamValues, [
        undefined,
        undefined,
        true,
        false,
      ]);

      yield* Scope.close(scope, Exit.void);
    }).pipe(Effect.provide(Layer.merge(makeTestLayer(state), TestClock.layer())));
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
      Layer.provideMerge(NodeServices.layer),
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
      Layer.provideMerge(NodeServices.layer),
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
      Layer.provideMerge(NodeServices.layer),
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
