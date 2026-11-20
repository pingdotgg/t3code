import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as JjWorkflow from "../jj/JjWorkflow.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

/** Only `kind` reaches the routing table; the rest of the handle never does. */
function handleFor(kind: "git" | "jj"): VcsDriverRegistry.VcsDriverHandle {
  return { kind } as unknown as VcsDriverRegistry.VcsDriverHandle;
}

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly git?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
  readonly gitManager?: Partial<GitManager.GitManager["Service"]>;
  readonly jj?: Partial<JjWorkflow.JjWorkflow["Service"]>;
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(ServerSettingsService.layerTest()),
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
  it.effect("recognizes a Jujutsu repository for workspace bootstrap", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const repositoryRoot = yield* workflow.repositoryRoot("/jj-repo");

      assert.equal(repositoryRoot, "/jj-repo");
    }).pipe(
      Effect.provide(
        layer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

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
        layer({
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
        layer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const layerTest = GitWorkflowService.layer.pipe(
      Layer.provide(NodeServices.layer),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(JjWorkflow.JjWorkflow)({})),
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
    }).pipe(Effect.provide(layerTest));
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
        layer({
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
        layer({
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
        layer({
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
          layer({
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
      assert.equal(yield* workflow.readRefSnapshot("/git-repo"), "git-refs");
      assert.isNull(yield* workflow.readRefSnapshot("/jj-repo"));

      assert.equal(gitListRefs.mock.calls.length, 1);
      assert.equal(jjListRefs.mock.calls.length, 1);
    }).pipe(
      Effect.provide(
        layer({
          detect: ({ cwd }) => Effect.succeed(handleFor(cwd === "/jj-repo" ? "jj" : "git")),
          git: {
            listRefs: gitListRefs,
            readRefSnapshot: () => Effect.succeed("git-refs"),
          },
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
        layer({
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
        layer({
          detect: ({ cwd }) =>
            Effect.succeed(handleFor(cwd === "/worktrees/pre-flip" ? "git" : "jj")),
          git: {
            removeWorktree: gitRemoveWorktree,
            execute: () =>
              Effect.succeed({
                stdout: "/repo/.git\n",
                stderr: "",
                exitCode: ChildProcessSpawner.ExitCode(0),
                stdoutTruncated: false,
                stderrTruncated: false,
              }),
          },
          jj: { removeWorktree: jjRemoveWorktree },
        }),
      ),
    );
  });

  it.effect(
    "reports ambiguous ownership when no directory, registration, or record survives",
    () => {
      const jjRemoveWorktree = vi.fn(() => Effect.void);

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const error = yield* workflow
          .removeWorktree({ cwd: "/jj-project", path: "/worktrees/vanished" })
          .pipe(Effect.flip);
        assert.include(error.detail, "original VCS owner");
        assert.equal(jjRemoveWorktree.mock.calls.length, 0);
      }).pipe(
        Effect.provide(
          layer({
            detect: ({ cwd }) => Effect.succeed(cwd === "/jj-project" ? handleFor("jj") : null),
            jj: {
              removeWorktree: jjRemoveWorktree,
              registeredWorkspaces: () => Effect.succeed([]),
            },
            git: {
              execute: (input) =>
                Effect.succeed({
                  stdout: input.operation === "WorkspaceOwnership.commonDir" ? "/repo/.git\n" : "",
                  stderr: "",
                  exitCode: ChildProcessSpawner.ExitCode(
                    input.operation === "WorkspaceOwnership.read" ? 1 : 0,
                  ),
                  stdoutTruncated: false,
                  stderrTruncated: false,
                }),
            },
          }),
        ),
      );
    },
  );

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        [
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "--allow-empty",
          "-m",
          "init",
        ],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              detect: () => Effect.succeed(handleFor("git")),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(Layer.mock(JjWorkflow.JjWorkflow)({})),
          Layer.provide(Layer.mock(ServerSettingsService)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );

  it.effect("reads no HEAD path from a removed worktree without spawning Git", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-removed-wt-" });
      const removed = `${parent}/removed`;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      assert.strictEqual(yield* workflow.headPath(removed), null);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({})),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provide(
            Layer.mock(GitVcsDriver.GitVcsDriver)({
              execute: (input) => Effect.die(`spawned Git in ${input.cwd}`),
            }),
          ),
        ),
      ),
    ),
  );
});
