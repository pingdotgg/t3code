import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as JjWorkflow from "../jj/JjWorkflow.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

/** Only `kind` reaches the routing table; the rest of the handle never does. */
function handleFor(kind: "git" | "jj"): VcsDriverRegistry.VcsDriverHandle {
  return { kind } as unknown as VcsDriverRegistry.VcsDriverHandle;
}

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly gitManager?: Partial<GitManager.GitManager["Service"]>;
  readonly jj?: Partial<JjWorkflow.JjWorkflow["Service"]>;
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(input.git ?? {})),
    Layer.provide(Layer.mock(GitManager.GitManager)(input.gitManager ?? {})),
    Layer.provide(Layer.mock(JjWorkflow.JjWorkflow)(input.jj ?? {})),
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

  it.effect("fails the status poll when detection itself fails, keeping the cause", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "the reason a healthy project could not be classified",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      // Reporting `isRepo: false` here renders a blank branch toolbar for a working repository
      // and drops the only record of why detection failed.
      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        cause,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("names the missing repository when detection reports none", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.createRef({ cwd: "/repo", refName: "feat" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.createRef",
        command: "vcs-route",
        cwd: "/repo",
      });
      expect(error.detail).toContain("found no version control repository here");
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect(
    "separates an undetectable directory from a missing one, without leaking the cause",
    () => {
      const cause = new VcsRepositoryDetectionError({
        operation: "VcsDriverRegistry.detect",
        cwd: "/repo",
        detail: "upstream command detail must stay in the cause chain",
      });

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const error = yield* workflow
          .createRef({ cwd: "/repo", refName: "feat" })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "GitCommandError",
          operation: "GitWorkflowService.createRef",
          command: "vcs-route",
          cwd: "/repo",
          cause,
        });
        expect(error.detail).not.toContain("found no version control repository here");
        expect(error.message).not.toContain(cause.detail);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.fail(cause),
          }),
        ),
      );
    },
  );

  it.effect("routes a Git cwd to the Git lane and a Jujutsu cwd to JjWorkflow", () => {
    const gitListRefs = vi.fn(() =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      }),
    );
    const jjListRefs = vi.fn(() =>
      Effect.succeed({
        refs: [],
        isRepo: true,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      }),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.listRefs({ cwd: "/git-repo" });
      yield* workflow.listRefs({ cwd: "/jj-repo" });

      assert.equal(gitListRefs.mock.calls.length, 1);
      assert.equal(jjListRefs.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: ({ cwd }) => Effect.succeed(handleFor(cwd === "/jj-repo" ? "jj" : "git")),
          git: { listRefs: gitListRefs },
          jj: { listRefs: jjListRefs },
        }),
      ),
    );
  });

  it.effect("drops both lanes' caches on every invalidation", () => {
    const gitInvalidate = vi.fn(() => Effect.void);
    const jjInvalidate = vi.fn(() => Effect.void);

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.invalidateStatus("/repo");

      assert.equal(gitInvalidate.mock.calls.length, 1);
      assert.equal(jjInvalidate.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(handleFor("git")),
          gitManager: { invalidateStatus: gitInvalidate },
          jj: { invalidateStatus: jjInvalidate },
        }),
      ),
    );
  });

  it.effect("removes a pre-flip Git worktree inside a Jujutsu project through the Git lane", () => {
    const gitRemoveWorktree = vi.fn(() => Effect.void);
    const jjRemoveWorktree = vi.fn(() => Effect.void);

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/jj-project", path: "/worktrees/pre-flip" });

      assert.equal(gitRemoveWorktree.mock.calls.length, 1);
      assert.equal(jjRemoveWorktree.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: ({ cwd }) =>
            Effect.succeed(handleFor(cwd === "/worktrees/pre-flip" ? "git" : "jj")),
          git: { removeWorktree: gitRemoveWorktree },
          jj: { removeWorktree: jjRemoveWorktree },
        }),
      ),
    );
  });

  it.effect("falls back to the project's kind when the workspace path is gone", () => {
    const jjRemoveWorktree = vi.fn(() => Effect.void);

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.removeWorktree({ cwd: "/jj-project", path: "/worktrees/vanished" });

      assert.equal(jjRemoveWorktree.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: ({ cwd }) => Effect.succeed(cwd === "/jj-project" ? handleFor("jj") : null),
          jj: { removeWorktree: jjRemoveWorktree },
        }),
      ),
    );
  });
});
