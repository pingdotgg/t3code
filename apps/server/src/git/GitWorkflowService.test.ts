import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GitCommandError, VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

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

  const gitHandle = {
    kind: "git",
    repository: {},
    driver: {},
  } as unknown as VcsDriverRegistry.VcsDriverHandle;

  function makeGitRepoLayer(input: {
    readonly fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"];
    readonly createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"];
    readonly resolveRemoteTrackingCommit?: GitVcsDriver.GitVcsDriver["Service"]["resolveRemoteTrackingCommit"];
    readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
  }) {
    return GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          resolve: input.resolve ?? (() => Effect.succeed(gitHandle)),
        }),
      ),
      Layer.provide(
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          fetchRemoteTrackingBranch: input.fetchRemoteTrackingBranch,
          createWorktree: input.createWorktree,
          resolveRemoteTrackingCommit:
            input.resolveRemoteTrackingCommit ??
            (() =>
              Effect.succeed({
                commitSha: "fetched-main-sha",
                remoteRefName: "origin/main",
              })),
        }),
      ),
      Layer.provide(Layer.mock(GitManager.GitManager)({})),
    );
  }

  it.effect("fetches the latest remote base before creating a worktree from an origin ref", () => {
    const operations: string[] = [];
    const fetchRemoteTrackingBranch = vi.fn(
      (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]>[0]) =>
        Effect.sync(() => {
          operations.push("fetch");
        }),
    );
    const createWorktree = vi.fn(
      (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
        Effect.sync(() => {
          operations.push("create-worktree");
          return {
            worktree: {
              refName: "sergecode/abc12345",
              path: "/tmp/worktree",
            },
          };
        }),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow.createWorktree({
        cwd: "/tmp/project",
        refName: "origin/main",
        newRefName: "sergecode/abc12345",
        baseRefName: "main",
        path: null,
      });

      assert.deepEqual(fetchRemoteTrackingBranch.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        remoteName: "origin",
        remoteBranch: "main",
      });
      assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
        cwd: "/tmp/project",
        refName: "fetched-main-sha",
        newRefName: "sergecode/abc12345",
        baseRefName: "main",
        path: null,
      });
      assert.deepEqual(operations, ["fetch", "create-worktree"]);
      assert.equal(result.worktree.path, "/tmp/worktree");
    }).pipe(
      Effect.provide(
        makeGitRepoLayer({
          fetchRemoteTrackingBranch,
          createWorktree,
        }),
      ),
    );
  });

  it.effect("aborts worktree creation when the remote base fetch fails", () => {
    const fetchRemoteTrackingBranch = vi.fn(
      (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]>[0]) =>
        Effect.fail(
          new GitCommandError({
            operation: "fetchRemoteTrackingBranch",
            command: "git fetch origin main",
            cwd: "/tmp/project",
            detail: "network unreachable",
          }),
        ),
    );
    const createWorktree = vi.fn(
      (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
        Effect.succeed({
          worktree: {
            refName: "sergecode/abc12345",
            path: "/tmp/worktree",
          },
        }),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const exit = yield* Effect.exit(
        workflow.createWorktree({
          cwd: "/tmp/project",
          refName: "origin/main",
          newRefName: "sergecode/abc12345",
          baseRefName: "main",
          path: null,
        }),
      );

      assert.equal(fetchRemoteTrackingBranch.mock.calls.length, 1);
      assert.equal(createWorktree.mock.calls.length, 0);
      assert.equal(exit._tag, "Failure");
    }).pipe(
      Effect.provide(
        makeGitRepoLayer({
          fetchRemoteTrackingBranch,
          createWorktree,
        }),
      ),
    );
  });

  const originWorktreeInput = (newRefName: string) =>
    ({
      cwd: "/tmp/project",
      refName: "origin/main",
      newRefName,
      baseRefName: "main",
      path: null,
    }) as const;

  const succeedingCreateWorktree = () =>
    vi.fn((input: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) => {
      const refName = input.newRefName ?? input.refName;
      return Effect.succeed({
        worktree: { refName, path: `/tmp/worktree/${refName}` },
      });
    });

  it.effect("fetches the remote base for every worktree creation", () => {
    const fetchRemoteTrackingBranch = vi.fn(
      (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]>[0]) =>
        Effect.void,
    );
    const createWorktree = succeedingCreateWorktree();

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;

      yield* workflow.createWorktree(originWorktreeInput("sergecode/aaaaaaaa"));
      yield* workflow.createWorktree(originWorktreeInput("sergecode/bbbbbbbb"));

      assert.equal(fetchRemoteTrackingBranch.mock.calls.length, 2);
      assert.equal(createWorktree.mock.calls.length, 2);
    }).pipe(Effect.provide(makeGitRepoLayer({ fetchRemoteTrackingBranch, createWorktree })));
  });

  it.effect("refreshes each base branch independently", () => {
    const fetchRemoteTrackingBranch = vi.fn(
      (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]>[0]) =>
        Effect.void,
    );
    const createWorktree = succeedingCreateWorktree();

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;

      yield* workflow.createWorktree(originWorktreeInput("sergecode/aaaaaaaa"));
      yield* workflow.createWorktree({
        ...originWorktreeInput("sergecode/bbbbbbbb"),
        refName: "origin/release",
        baseRefName: "release",
      });

      assert.deepEqual(
        fetchRemoteTrackingBranch.mock.calls.map((call) => call[0].remoteBranch),
        ["main", "release"],
      );
    }).pipe(Effect.provide(makeGitRepoLayer({ fetchRemoteTrackingBranch, createWorktree })));
  });

  it.effect("does not fetch when the worktree base is a local ref", () => {
    const fetchRemoteTrackingBranch = vi.fn(
      (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["fetchRemoteTrackingBranch"]>[0]) =>
        Effect.void,
    );
    const createWorktree = vi.fn(
      (_: Parameters<GitVcsDriver.GitVcsDriver["Service"]["createWorktree"]>[0]) =>
        Effect.succeed({
          worktree: {
            refName: "sergecode/abc12345",
            path: "/tmp/worktree",
          },
        }),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.createWorktree({
        cwd: "/tmp/project",
        refName: "main",
        newRefName: "sergecode/abc12345",
        baseRefName: "main",
        path: null,
      });

      assert.equal(fetchRemoteTrackingBranch.mock.calls.length, 0);
      assert.equal(createWorktree.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        makeGitRepoLayer({
          fetchRemoteTrackingBranch,
          createWorktree,
        }),
      ),
    );
  });
});
