import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  DEFAULT_SERVER_SETTINGS,
  VcsRepositoryDetectionError,
  type VcsCreateWorktreeInput,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

/** Settings stub with no per-project worktree overrides configured. */
export function mockServerSettingsLayer(worktreeDirectoryOverrides: Record<string, string> = {}) {
  return Layer.mock(ServerSettings.ServerSettingsService)({
    getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, worktreeDirectoryOverrides }),
    streamChanges: Stream.empty,
  });
}

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
    Layer.provide(mockServerSettingsLayer()),
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
      Layer.provide(mockServerSettingsLayer()),
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

  describe("createWorktree worktree location", () => {
    // ensureGitCommand only inspects `kind`, so the rest of the handle is stubbed.
    const gitRepoHandle = (cwd: string) =>
      Effect.succeed({ kind: "git", repository: { kind: "git", rootPath: cwd } } as never);

    const makeCreateWorktreeLayer = (input: {
      readonly overrides: Record<string, string>;
      readonly createWorktree: GitVcsDriver.GitVcsDriver["Service"]["createWorktree"];
    }) =>
      GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            detect: (request) => gitRepoHandle(request.cwd),
            resolve: (request) => gitRepoHandle(request.cwd),
          }),
        ),
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({ createWorktree: input.createWorktree }),
        ),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
        Layer.provide(mockServerSettingsLayer(input.overrides)),
      );

    it.effect("leaves path null when the project has no configured location", () => {
      const createWorktree = vi.fn((_input: VcsCreateWorktreeInput) =>
        Effect.succeed({ worktree: { path: "/default/path", refName: "feature" } }),
      );

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.createWorktree({
          cwd: "/repos/alpha",
          refName: "main",
          newRefName: "feature",
          path: null,
        });

        expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({ path: null });
      }).pipe(Effect.provide(makeCreateWorktreeLayer({ overrides: {}, createWorktree })));
    });

    it.effect("substitutes the configured location for the project", () => {
      const createWorktree = vi.fn((_input: VcsCreateWorktreeInput) =>
        Effect.succeed({ worktree: { path: "/custom/feature-login", refName: "feature" } }),
      );

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.createWorktree({
          cwd: "/repos/alpha",
          refName: "main",
          newRefName: "feature/login",
          path: null,
        });

        expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({
          path: "/custom/feature-login",
        });
      }).pipe(
        Effect.provide(
          makeCreateWorktreeLayer({
            overrides: { "/repos/alpha": "/custom" },
            createWorktree,
          }),
        ),
      );
    });

    it.effect("fails instead of silently falling back when the location is invalid", () => {
      const createWorktree = vi.fn((_input: VcsCreateWorktreeInput) =>
        Effect.succeed({ worktree: { path: "/unused", refName: "feature" } }),
      );

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const error = yield* workflow
          .createWorktree({ cwd: "/repos/alpha", refName: "main", path: null })
          .pipe(Effect.flip);

        expect(error._tag).toBe("GitCommandError");
        expect(error.detail).toContain("absolute");
        expect(createWorktree.mock.calls.length).toBe(0);
      }).pipe(
        Effect.provide(
          makeCreateWorktreeLayer({
            overrides: { "/repos/alpha": "not/absolute" },
            createWorktree,
          }),
        ),
      );
    });

    it.effect("honours an explicit path over the configured location", () => {
      const createWorktree = vi.fn((_input: VcsCreateWorktreeInput) =>
        Effect.succeed({ worktree: { path: "/explicit", refName: "feature" } }),
      );

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.createWorktree({
          cwd: "/repos/alpha",
          refName: "main",
          path: "/explicit",
        });

        expect(createWorktree.mock.calls[0]?.[0]).toMatchObject({ path: "/explicit" });
      }).pipe(
        Effect.provide(
          makeCreateWorktreeLayer({
            overrides: { "/repos/alpha": "/custom" },
            createWorktree,
          }),
        ),
      );
    });
  });

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
});
