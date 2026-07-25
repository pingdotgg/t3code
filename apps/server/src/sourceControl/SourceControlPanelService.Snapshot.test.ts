import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  GitCommandError,
  SourceControlProviderError,
  type ChangeRequest,
  type SourceControlProviderKind,
  type VcsRef,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";

import {
  SourceControlPanelService,
  layer as SourceControlPanelServiceLayer,
} from "./SourceControlPanelService.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GitVcsDriver, type ExecuteGitInput, type ExecuteGitResult } from "../vcs/GitVcsDriver.ts";

const branchRef: VcsRef = {
  name: "feature/source-control",
  current: false,
  isDefault: false,
  worktreePath: null,
};
const isGitCommandError = Schema.is(GitCommandError);

const success = (stdout = ""): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const failure = (stderr: string): ExecuteGitResult => ({
  exitCode: ChildProcessSpawner.ExitCode(1),
  stdout: "",
  stderr,
  stdoutTruncated: false,
  stderrTruncated: false,
});

const emptyProvider = SourceControlProvider.SourceControlProvider.of({
  kind: "unknown",
  listChangeRequests: () => Effect.succeed([]),
  getChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.getChangeRequest",
        cwd: "/repo",
        detail: "get change request not stubbed",
      }),
    ),
  createChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.createChangeRequest",
        cwd: "/repo",
        detail: "create change request not stubbed",
      }),
    ),
  getRepositoryCloneUrls: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.getRepositoryCloneUrls",
        cwd: "/repo",
        detail: "repository clone URLs not stubbed",
      }),
    ),
  getCommitAvatarUrl: () => Effect.succeed(null),
  createRepository: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.createRepository",
        cwd: "/repo",
        detail: "create repository not stubbed",
      }),
    ),
  getDefaultBranch: () => Effect.succeed(null),
  checkoutChangeRequest: () =>
    Effect.fail(
      new SourceControlProviderError({
        provider: "unknown",
        operation: "test.checkoutChangeRequest",
        cwd: "/repo",
        detail: "checkout change request not stubbed",
      }),
    ),
});

function makeTestLayer(
  execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>,
  workflow: Partial<GitWorkflowService["Service"]> = {},
  providers: Partial<
    Record<SourceControlProviderKind, SourceControlProvider.SourceControlProvider["Service"]>
  > = {},
  settings: Parameters<typeof ServerSettingsService.layerTest>[0] = {},
) {
  return SourceControlPanelServiceLayer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest(settings)),
    Layer.provide(
      Layer.succeed(GitWorkflowService, {
        status: (input) =>
          workflow.status
            ? workflow.status(input)
            : workflow.localStatus
              ? workflow.localStatus(input).pipe(
                  Effect.map((status) => ({
                    ...status,
                    hasUpstream: false,
                    aheadCount: 0,
                    behindCount: 0,
                    aheadOfDefaultCount:
                      (status as { readonly aheadOfDefaultCount?: number }).aheadOfDefaultCount ??
                      0,
                    pr: null,
                  })),
                )
              : Effect.fail(
                  new GitCommandError({
                    operation: "test.status",
                    command: "git status",
                    cwd: "/repo",
                    detail: "status not stubbed",
                  }),
                ),
        localStatus: () =>
          Effect.fail(
            new GitCommandError({
              operation: "test.localStatus",
              command: "git status",
              cwd: "/repo",
              detail: "local status not stubbed",
            }),
          ),
        pullCurrentBranch: () =>
          Effect.fail(
            new GitCommandError({
              operation: "test.pullCurrentBranch",
              command: "git pull",
              cwd: "/repo",
              detail: "pull not stubbed",
            }),
          ),
        ...workflow,
      } as GitWorkflowService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(GitVcsDriver, {
        execute,
      } as unknown as GitVcsDriver["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        SourceControlProviderRegistry,
        SourceControlProviderRegistry.of({
          get: (kind) => Effect.succeed(providers[kind] ?? emptyProvider),
          resolveHandle: () => Effect.succeed({ provider: emptyProvider, context: null }),
          resolve: () => Effect.succeed(emptyProvider),
          discover: Effect.succeed([]),
        }),
      ),
    ),
  );
}

const localStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/source-control",
  hasWorkingTreeChanges: true,
  workingTree: {
    files: [],
    insertions: 0,
    deletions: 0,
  },
};

describe("SourceControlPanelService", () => {
  it.effect("attaches worktree paths from git worktree porcelain output", () => {
    const worktreePath = process.cwd();
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: worktreePath });

      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          current: branch.current,
          worktreePath: branch.worktreePath,
        })),
        [
          {
            name: "feature/source-control",
            current: true,
            worktreePath,
          },
          {
            name: "main",
            current: false,
            worktreePath,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      "main\t\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t*\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]",
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success(
                    [
                      `worktree ${worktreePath}`,
                      "HEAD abc",
                      "branch refs/heads/main",
                      "",
                      `worktree ${worktreePath}`,
                      "HEAD def",
                      "branch refs/heads/feature/source-control",
                      "",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head feature/source-control");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("drops missing branch worktree paths before building the panel snapshot", () => {
    const missingWorktreePath = `${process.cwd()}/.missing-source-control-worktree-test`;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const service = yield* SourceControlPanelService;

      assert.isFalse(yield* fileSystem.exists(missingWorktreePath));

      const snapshot = yield* service.snapshot({ cwd: process.cwd() });

      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          current: branch.current,
          worktreePath: branch.worktreePath,
        })),
        [
          {
            name: "feature/source-control",
            current: true,
            worktreePath: null,
          },
          {
            name: "main",
            current: false,
            worktreePath: null,
          },
        ],
      );
      assert.deepStrictEqual(snapshot.worktreeChangeSets, []);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      "main\t\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t*\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]",
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success(
                    [
                      `worktree ${missingWorktreePath}`,
                      "HEAD abc",
                      "branch refs/heads/main",
                      "",
                      `worktree ${missingWorktreePath}`,
                      "HEAD def",
                      "branch refs/heads/feature/source-control",
                      "",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head feature/source-control");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("includes dirty non-current worktrees as separate change sets", () => {
    const rootPath = process.cwd();
    const worktreePath = `${process.cwd()}/..`;
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: rootPath });

      assert.deepStrictEqual(
        snapshot.worktreeChangeSets.map((changeSet) => ({
          branchName: changeSet.branchName,
          worktreePath: changeSet.worktreePath,
          files: changeSet.changeGroups.flatMap((group) =>
            group.files.map((file) => ({
              group: group.kind,
              path: file.path,
              status: file.status,
              insertions: file.insertions,
              deletions: file.deletions,
            })),
          ),
        })),
        [
          {
            branchName: "feature/source-control",
            worktreePath,
            files: [
              {
                group: "staged",
                path: "src/staged.ts",
                status: "added",
                insertions: 2,
                deletions: 0,
              },
              {
                group: "unstaged",
                path: "src/unstaged.ts",
                status: "modified",
                insertions: 3,
                deletions: 1,
              },
            ],
          },
        ],
      );
      assert.equal(snapshot.changeGroups.flatMap((group) => group.files).length, 0);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      `main\t*\t${rootPath}\t2026-06-20T12:00:00.000Z\torigin/main\t`,
                      `feature/source-control\t\t${worktreePath}\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t`,
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success(
                    [
                      `worktree ${rootPath}`,
                      "HEAD abc",
                      "branch refs/heads/main",
                      "",
                      `worktree ${worktreePath}`,
                      "HEAD def",
                      "branch refs/heads/feature/source-control",
                      "",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  if (input.cwd === worktreePath) {
                    return success(
                      [
                        "# branch.oid def",
                        "# branch.head feature/source-control",
                        "1 A. N... 000000 100644 100644 000000 111111 src/staged.ts",
                        "1 .M N... 100644 100644 100644 222222 333333 src/unstaged.ts",
                      ].join("\n"),
                    );
                  }
                  return success("# branch.oid abc\n# branch.head main");
                case "vcs.panel.stagedNumstat":
                  return input.cwd === worktreePath
                    ? success("2\t0\tsrc/staged.ts\0")
                    : success("");
                case "vcs.panel.stagedNameStatus":
                  return input.cwd === worktreePath ? success("A\0src/staged.ts\0") : success("");
                case "vcs.panel.unstagedNumstat":
                  return input.cwd === worktreePath
                    ? success("3\t1\tsrc/unstaged.ts\0")
                    : success("");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "main",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("falls back to branch-format worktree paths when worktree porcelain is empty", () => {
    const rootPath = process.cwd();
    const worktreePath = process.cwd();
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: worktreePath });

      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          current: branch.current,
          worktreePath: branch.worktreePath,
        })),
        [
          {
            name: "feature/source-control",
            current: true,
            worktreePath,
          },
          {
            name: "main",
            current: false,
            worktreePath: rootPath,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  assert.ok(input.args.join(" ").includes("%(worktreepath)"));
                  return success(
                    [
                      `main\t\t${rootPath}\t2026-06-20T12:00:00.000Z\torigin/main\t`,
                      `feature/source-control\t*\t${worktreePath}\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]`,
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success("");
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head feature/source-control");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("falls back when git branch does not support worktreepath formatting", () => {
    let localBranchesCalls = 0;

    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.equal(localBranchesCalls, 2);
      assert.deepStrictEqual(
        snapshot.localBranches.map((branch) => ({
          name: branch.name,
          current: branch.current,
          worktreePath: branch.worktreePath,
          lastActivityAt: branch.lastActivityAt,
          upstreamName: branch.upstreamName,
          aheadCount: branch.aheadCount,
          behindCount: branch.behindCount,
        })),
        [
          {
            name: "feature/source-control",
            current: true,
            worktreePath: null,
            lastActivityAt: "2026-06-21T12:00:00.000Z",
            upstreamName: "origin/feature/source-control",
            aheadCount: 1,
            behindCount: 0,
          },
          {
            name: "main",
            current: false,
            worktreePath: null,
            lastActivityAt: "2026-06-20T12:00:00.000Z",
            upstreamName: "origin/main",
            aheadCount: 0,
            behindCount: 0,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  localBranchesCalls += 1;
                  if (localBranchesCalls === 1) {
                    assert.ok(input.args.join(" ").includes("%(worktreepath)"));
                    assert.equal(input.allowNonZeroExit, true);
                    return failure("fatal: unknown field name: worktreepath");
                  }
                  assert.ok(!input.args.join(" ").includes("%(worktreepath)"));
                  assert.ok(input.args.join(" ").includes("%09%09"));
                  return success(
                    [
                      "main\t\t\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t*\t\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]",
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success("");
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head feature/source-control");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    );
  });

  it.effect("keeps git-derived actionable forks when provider change request listing fails", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.deepStrictEqual(snapshot.actionableForkBranches, [
        {
          localBranchName: "feature",
          remoteName: "upstream",
          remoteBranchName: "feature",
          remoteRefName: "upstream/feature",
          aheadCount: 2,
          behindCount: 3,
          lastActivityAt: "2026-06-17T09:00:00.000Z",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    "feature\t*\t/repo\t2026-06-17T10:00:00.000Z\torigin/feature\t[ahead 1]",
                  );
                case "vcs.panel.remotes":
                  return success(
                    [
                      "origin\tgit@github.com:fork/repo.git\t(fetch)",
                      "origin\tgit@github.com:fork/repo.git\t(push)",
                      "upstream\tgit@github.com:upstream/repo.git\t(fetch)",
                      "upstream\tgit@github.com:upstream/repo.git\t(push)",
                    ].join("\n"),
                  );
                case "vcs.panel.remoteBranches":
                  return input.args.includes("origin/*")
                    ? success("origin/feature\t2026-06-17T08:00:00.000Z\n")
                    : success("upstream/feature\t2026-06-17T09:00:00.000Z\n");
                case "vcs.panel.branchForkMergeBase":
                  return success("abc123\n");
                case "vcs.panel.branchForkAheadBehind":
                  return success("2\t3\n");
                case "vcs.panel.statusPorcelain":
                  return success(["# branch.oid abc", "# branch.head feature"].join("\n"));
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                case "vcs.panel.stashes":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature",
                hasWorkingTreeChanges: false,
              }),
          },
          {
            github: SourceControlProvider.SourceControlProvider.of({
              ...emptyProvider,
              kind: "github",
              listChangeRequests: () =>
                Effect.fail(
                  new SourceControlProviderError({
                    provider: "github",
                    operation: "test.listChangeRequests",
                    cwd: "/repo",
                    detail: "provider unavailable",
                  }),
                ),
            }),
          },
        ),
      ),
    ),
  );

  it.effect("surfaces open pull request base branches only when the local branch is behind", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.deepStrictEqual(snapshot.actionableForkBranches, [
        {
          localBranchName: "feature",
          remoteName: "origin",
          remoteBranchName: "main",
          remoteRefName: "origin/main",
          aheadCount: 0,
          behindCount: 2,
          lastActivityAt: "2026-06-17T11:00:00.000Z",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      "feature\t*\t/repo\t2026-06-17T10:00:00.000Z\t\t",
                      "fresh\t\t\t2026-06-17T09:00:00.000Z\t\t",
                    ].join("\n"),
                  );
                case "vcs.panel.remotes":
                  return success(
                    [
                      "origin\tgit@github.com:acme/repo.git\t(fetch)",
                      "origin\tgit@github.com:acme/repo.git\t(push)",
                    ].join("\n"),
                  );
                case "vcs.panel.remoteBranches":
                  return success(
                    [
                      "origin/main\t2026-06-17T11:00:00.000Z",
                      "origin/develop\t2026-06-17T08:00:00.000Z",
                    ].join("\n"),
                  );
                case "vcs.panel.branchForkMergeBase":
                  return success("abc123\n");
                case "vcs.panel.branchForkAheadBehind":
                  return input.args.includes("feature...origin/main")
                    ? success("0\t2\n")
                    : success("1\t0\n");
                case "vcs.panel.statusPorcelain":
                  return success(["# branch.oid abc", "# branch.head feature"].join("\n"));
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.unstagedNumstat":
                case "vcs.panel.stashes":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature",
                hasWorkingTreeChanges: false,
              }),
          },
          {
            github: SourceControlProvider.SourceControlProvider.of({
              ...emptyProvider,
              kind: "github",
              listChangeRequests: (input) => {
                const byHead: Record<string, readonly ChangeRequest[]> = {
                  feature: [
                    {
                      provider: "github",
                      number: 42,
                      title: "Feature",
                      url: "https://github.com/acme/repo/pull/42",
                      baseRefName: "main",
                      headRefName: "feature",
                      state: "open",
                      updatedAt: Option.none(),
                    },
                  ],
                  fresh: [
                    {
                      provider: "github",
                      number: 43,
                      title: "Fresh",
                      url: "https://github.com/acme/repo/pull/43",
                      baseRefName: "develop",
                      headRefName: "fresh",
                      state: "open",
                      updatedAt: Option.none(),
                    },
                  ],
                };
                return Effect.succeed(byHead[input.headSelector] ?? []);
              },
            }),
          },
        ),
      ),
    ),
  );
});
