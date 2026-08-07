import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorktreeLifecycle from "../vcs/WorktreeLifecycle.ts";

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(WorktreeLifecycle.layer),
  );
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
      Layer.provide(WorktreeLifecycle.layer),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("serializes PR worktree preparation and publishes inventory changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lifecycle = yield* WorktreeLifecycle.make;
        const permitRequested = yield* Deferred.make<void>();
        const blockerEntered = yield* Deferred.make<void>();
        const releaseBlocker = yield* Deferred.make<void>();
        const managerEffectEntered = yield* Deferred.make<void>();
        const instrumentedLifecycle = WorktreeLifecycle.WorktreeLifecycle.of({
          ...lifecycle,
          withMutationPermit: (effect) =>
            Deferred.succeed(permitRequested, undefined).pipe(
              Effect.andThen(lifecycle.withMutationPermit(effect)),
            ),
        });
        const vcsDriver = yield* VcsDriver.VcsDriver.pipe(
          Effect.provide(
            Layer.mock(VcsDriver.VcsDriver)({
              capabilities: {
                kind: "git",
                supportsWorktrees: true,
                supportsBookmarks: false,
                supportsAtomicSnapshot: false,
                supportsPushDefaultRemote: true,
                ignoreClassifier: "native",
              },
            }),
          ),
        );
        const expectedResult = {
          pullRequest: {
            number: 4_742,
            title: "Worktree management",
            url: "https://github.com/pingdotgg/t3code/pull/4742",
            baseBranch: "main",
            headBranch: "worktree-management",
            state: "open" as const,
          },
          branch: "worktree-management",
          worktreePath: "/worktrees/worktree-management",
        };
        const preparePullRequestThread = vi.fn(() =>
          Deferred.succeed(managerEffectEntered, undefined).pipe(Effect.as(expectedResult)),
        );
        const testLayer = GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () =>
                Effect.succeed({
                  kind: "git",
                  repository: {
                    kind: "git",
                    rootPath: "/repo",
                    metadataPath: "/repo/.git",
                    freshness: {
                      source: "live-local",
                      observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
                      expiresAt: Option.none(),
                    },
                  },
                  driver: vcsDriver,
                }),
            }),
          ),
          Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
          Layer.provide(
            Layer.mock(GitManager.GitManager)({
              preparePullRequestThread,
            }),
          ),
          Layer.provide(Layer.succeed(WorktreeLifecycle.WorktreeLifecycle, instrumentedLifecycle)),
        );

        const blocker = yield* lifecycle
          .withMutationPermit(
            Deferred.succeed(blockerEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBlocker)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(blockerEntered);

        const preparation = yield* Effect.gen(function* () {
          const workflow = yield* GitWorkflowService.GitWorkflowService;
          return yield* workflow.preparePullRequestThread({
            cwd: "/repo",
            reference: "#4742",
            mode: "worktree",
          });
        }).pipe(Effect.provide(testLayer), Effect.forkChild);

        yield* Deferred.await(permitRequested);
        assert.isTrue(Option.isNone(yield* Deferred.poll(managerEffectEntered)));

        yield* Deferred.succeed(releaseBlocker, undefined);
        yield* Fiber.join(blocker);
        const result = yield* Fiber.join(preparation);

        assert.deepStrictEqual(result, expectedResult);
        assert.equal(preparePullRequestThread.mock.calls.length, 1);
        assert.isTrue(Option.isSome(yield* Deferred.poll(managerEffectEntered)));
        const change = yield* Stream.runHead(lifecycle.changes);
        assert.deepStrictEqual(Option.getOrThrow(change), { revision: 1 });
      }),
    ),
  );
});
