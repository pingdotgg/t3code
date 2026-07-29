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
        invalidateRefs: () => Effect.void,
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
  it.effect("passes rebase refs after a positional separator", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.rebaseCurrentOnto({
        cwd: "/repo",
        refName: "feature/source-control",
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [["rebase", "--", "feature/source-control"]],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("sets upstream when force-pushing an unpublished branch", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.pushBranch({
        cwd: "/repo",
        branchName: "feature/source-control",
        force: true,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          [
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "feature/source-control@{upstream}",
          ],
          [
            "push",
            "--force-with-lease",
            "-u",
            "origin",
            "feature/source-control:refs/heads/feature/source-control",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.upstreamForRef"
              ? failure("no upstream")
              : success();
          }),
        ),
      ),
    );
  });

  it.effect(
    "publishes to the local branch name when the configured upstream is only a base ref",
    () => {
      const calls: ExecuteGitInput[] = [];
      return Effect.gen(function* () {
        const service = yield* SourceControlPanelService;

        yield* service.pushBranch({
          cwd: "/repo",
          branchName: "split/vscode-extension-work",
        });

        assert.deepStrictEqual(
          calls.map((call) => call.args),
          [
            [
              "rev-parse",
              "--abbrev-ref",
              "--symbolic-full-name",
              "split/vscode-extension-work@{upstream}",
            ],
            ["remote"],
            [
              "push",
              "-u",
              "origin",
              "split/vscode-extension-work:refs/heads/split/vscode-extension-work",
            ],
          ],
        );
      }).pipe(
        Effect.provide(
          makeTestLayer((input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("upstream/main\n");
                case "vcs.panel.pushBranch.remotes":
                  return success("origin\nupstream\n");
                default:
                  return success();
              }
            }),
          ),
        ),
      );
    },
  );

  it.effect("keeps staged rename stats keyed by the destination path", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });
      const stagedFiles =
        snapshot.changeGroups.find((group) => group.kind === "staged")?.files ?? [];

      assert.deepStrictEqual(stagedFiles, [
        {
          path: "src/new.ts",
          originalPath: "src/old.ts",
          status: "renamed",
          insertions: 3,
          deletions: 1,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                  return success("");
                case "vcs.panel.statusPorcelain":
                  return success(
                    [
                      "# branch.oid abc",
                      "# branch.head feature/source-control",
                      "2 R. N... 100644 100644 100644 abc abc R100 src/new.ts\tsrc/old.ts",
                    ].join("\n"),
                  );
                case "vcs.panel.stagedNumstat":
                  return success("3\t1\t\0src/old.ts\0src/new.ts\0");
                case "vcs.panel.stagedNameStatus":
                  return success("R100\0src/old.ts\0src/new.ts\0");
                case "vcs.panel.unstagedNumstat":
                  return success("");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () => Effect.succeed(localStatus),
          },
        ),
      ),
    ),
  );

  it.effect("reads staged rename diffs against the original path", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.readFileDiff({
        cwd: "/repo",
        path: "src/new.ts",
        originalPath: "src/old.ts",
        source: { kind: "working-tree", staged: true },
      });

      assert.equal(result.patch, "rename patch");
      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          [
            "diff",
            "--cached",
            "--patch",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--no-relative",
            "--unified=3",
            "--inter-hunk-context=0",
            "--minimal",
            "--find-renames=20%",
            "--",
            "src/old.ts",
            "src/new.ts",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success("rename patch");
          }),
        ),
      ),
    );
  });

  it.effect("disables user-configured diff rendering for untracked files", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.readFileDiff({
        cwd: "/repo",
        path: "src/untracked.ts",
        source: { kind: "working-tree", staged: false },
      });

      assert.equal(result.patch, "untracked patch");
      assert.deepStrictEqual(
        calls.map((call) => ({
          operation: call.operation,
          args: call.args,
          allowNonZeroExit: call.allowNonZeroExit,
        })),
        [
          {
            operation: "vcs.panel.readFileDiff",
            args: [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-relative",
              "--unified=3",
              "--inter-hunk-context=0",
              "--minimal",
              "--find-renames=20%",
              "--",
              "src/untracked.ts",
            ],
            allowNonZeroExit: false,
          },
          {
            operation: "vcs.panel.readUntrackedFileDiff",
            args: [
              "diff",
              "--no-index",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-relative",
              "--unified=3",
              "--inter-hunk-context=0",
              "--",
              "/dev/null",
              "src/untracked.ts",
            ],
            allowNonZeroExit: true,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.readUntrackedFileDiff"
              ? success("untracked patch")
              : success("");
          }),
        ),
      ),
    );
  });

  it.effect("disables user-configured rendering for ref-backed Review patches", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.readFileDiff({
        cwd: "/repo",
        path: "src/commit.ts",
        source: { kind: "commit", sha: "abc123" },
      });
      yield* service.readFileDiff({
        cwd: "/repo",
        path: "src/compare.ts",
        source: {
          kind: "compare",
          baseRef: "main",
          refName: "feature/source-control",
        },
      });

      assert.deepStrictEqual(
        calls.map((call) => ({ operation: call.operation, args: call.args })),
        [
          {
            operation: "vcs.panel.readCommitFileDiff",
            args: [
              "show",
              "--format=",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-relative",
              "--unified=3",
              "--inter-hunk-context=0",
              "--minimal",
              "abc123",
              "--",
              "src/commit.ts",
            ],
          },
          {
            operation: "vcs.panel.readCompareFileDiff",
            args: [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-relative",
              "--unified=3",
              "--inter-hunk-context=0",
              "--minimal",
              "main...feature/source-control",
              "--",
              "src/compare.ts",
            ],
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success("patch");
          }),
        ),
      ),
    );
  });

  it.effect("reads tracked stash file diffs against the stash base", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.readFileDiff({
        cwd: "/repo",
        path: "src/new.ts",
        originalPath: "src/old.ts",
        source: { kind: "stash", stashRef: "stash@{0}" },
      });

      assert.equal(result.patch, "stash patch");
      assert.deepStrictEqual(
        calls.map((call) => ({ operation: call.operation, args: call.args })),
        [
          {
            operation: "vcs.panel.readStashFileDiff",
            args: [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-relative",
              "--unified=3",
              "--inter-hunk-context=0",
              "--minimal",
              "--find-renames=20%",
              "stash@{0}^1",
              "stash@{0}",
              "--",
              "src/old.ts",
              "src/new.ts",
            ],
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success("stash patch");
          }),
        ),
      ),
    );
  });

  it.effect("falls back to the stash untracked parent for untracked files", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.readFileDiff({
        cwd: "/repo",
        path: "src/untracked.ts",
        source: { kind: "stash", stashRef: "stash@{1}" },
      });

      assert.equal(result.patch, "untracked stash patch");
      assert.deepStrictEqual(
        calls.map((call) => ({
          operation: call.operation,
          args: call.args,
          allowNonZeroExit: call.allowNonZeroExit,
        })),
        [
          {
            operation: "vcs.panel.readStashFileDiff",
            args: [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-relative",
              "--unified=3",
              "--inter-hunk-context=0",
              "--minimal",
              "--find-renames=20%",
              "stash@{1}^1",
              "stash@{1}",
              "--",
              "src/untracked.ts",
            ],
            allowNonZeroExit: false,
          },
          {
            operation: "vcs.panel.readStashUntrackedFileDiff",
            args: [
              "show",
              "--format=",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-relative",
              "--unified=3",
              "--inter-hunk-context=0",
              "--minimal",
              "stash@{1}^3",
              "--",
              "src/untracked.ts",
            ],
            allowNonZeroExit: true,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.readStashUntrackedFileDiff"
              ? success("untracked stash patch")
              : success("");
          }),
        ),
      ),
    );
  });

  it.effect("reads unstaged rename diffs with a temporary intent-to-add index", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.readFileDiff({
        cwd: "/repo",
        path: "src/new.ts",
        originalPath: "src/old.ts",
        source: { kind: "working-tree", staged: false },
      });

      assert.equal(result.patch, "rename patch");
      assert.deepStrictEqual(
        calls.map((call) => ({ operation: call.operation, args: call.args })),
        [
          {
            operation: "vcs.panel.readFileDiff.gitIndexPath",
            args: ["rev-parse", "--git-path", "index"],
          },
          {
            operation: "vcs.panel.readFileDiff.tempIndexReadTree",
            args: ["read-tree", "HEAD"],
          },
          {
            operation: "vcs.panel.readFileDiff.tempIndexIntentToAdd",
            args: ["--literal-pathspecs", "add", "-N", "--", "src/new.ts"],
          },
          {
            operation: "vcs.panel.readFileDiff",
            args: [
              "diff",
              "--patch",
              "--no-color",
              "--no-ext-diff",
              "--no-textconv",
              "--src-prefix=a/",
              "--dst-prefix=b/",
              "--no-relative",
              "--unified=3",
              "--inter-hunk-context=0",
              "--minimal",
              "--find-renames=20%",
              "--",
              "src/old.ts",
              "src/new.ts",
            ],
          },
        ],
      );
      const diffCall = calls.find((call) => call.operation === "vcs.panel.readFileDiff");
      assert.equal(Boolean(diffCall?.env?.GIT_INDEX_FILE?.length), true);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.readFileDiff.gitIndexPath":
                return success("/tmp/t3-code-test-missing-index");
              case "vcs.panel.readFileDiff":
                return success("rename patch");
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("does not render unstaged rename diff fallbacks as new untracked files", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.readFileDiff({
        cwd: "/repo",
        path: "src/new.ts",
        originalPath: "src/old.ts",
        source: { kind: "working-tree", staged: false },
      });

      assert.equal(result.patch, "");
      assert.isFalse(calls.some((call) => call.operation === "vcs.panel.readUntrackedFileDiff"));
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.readFileDiff.gitIndexPath":
                return success("/tmp/t3-code-test-missing-index");
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("decodes quoted porcelain paths and keeps mixed unstaged rows in snapshots", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });
      const unstagedFiles =
        snapshot.changeGroups.find((group) => group.kind === "unstaged")?.files ?? [];

      assert.equal(snapshot.status.aheadOfDefaultCount, 4);
      assert.deepStrictEqual(unstagedFiles, [
        {
          path: "src/áudio.ts",
          originalPath: null,
          status: "untracked",
          insertions: 0,
          deletions: 0,
        },
        {
          path: "src/mixed.ts",
          originalPath: null,
          status: "modified",
          insertions: 2,
          deletions: 1,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                  return success("");
                case "vcs.panel.statusPorcelain":
                  return success(
                    [
                      "# branch.oid abc",
                      "# branch.head feature/source-control",
                      "# branch.ab +2 -0",
                      "1 MM N... 100644 100644 100644 abc abc src/mixed.ts",
                      '? "src/\\303\\241udio.ts"',
                    ].join("\n"),
                  );
                case "vcs.panel.stagedNumstat":
                  return success("1\t0\tsrc/mixed.ts\0");
                case "vcs.panel.stagedNameStatus":
                  return success("M\0src/mixed.ts\0");
                case "vcs.panel.unstagedNumstat":
                  return success("2\t1\tsrc/mixed.ts\0");
                default:
                  return success("");
              }
            }),
          {
            localStatus: () =>
              Effect.succeed({
                ...localStatus,
                aheadOfDefaultCount: 4,
              }),
          },
        ),
      ),
    ),
  );

  it.effect("enriches visible untracked files with stats and rename matches", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.enrichWorkingTreeFiles({
        cwd: "/repo",
        paths: ["blast-review/SKILL.md", "blast-review/agents/openai.yaml"],
      });

      assert.deepStrictEqual(result, {
        hiddenPaths: ["copilot-blast-review/agents/openai.yaml", "copilot-blast-review/SKILL.md"],
        files: [
          {
            path: "blast-review/agents/openai.yaml",
            originalPath: "copilot-blast-review/agents/openai.yaml",
            status: "renamed",
            insertions: 6,
            deletions: 1,
          },
          {
            path: "blast-review/SKILL.md",
            originalPath: "copilot-blast-review/SKILL.md",
            status: "renamed",
            insertions: 2,
            deletions: 1,
          },
        ],
      });
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            switch (input.operation) {
              case "vcs.panel.enrichWorkingTreeFiles.statusPorcelain":
                assert.deepStrictEqual(input.args, [
                  "status",
                  "--porcelain=2",
                  "--branch",
                  "-uall",
                ]);
                return success(
                  [
                    "# branch.oid abc",
                    "# branch.head main",
                    "1 .D N... 100644 100644 000000 abc abc copilot-blast-review/SKILL.md",
                    "? blast-review/SKILL.md",
                    "? blast-review/agents/openai.yaml",
                    "? blast-review/scripts/blast-review.ts",
                  ].join("\n"),
                );
              case "vcs.panel.enrichWorkingTreeFiles.unstagedNumstat":
                return success("0\t20\tcopilot-blast-review/SKILL.md\n");
              case "vcs.panel.enrichWorkingTreeFiles.untrackedNumstat": {
                const path = input.args.at(-1);
                if (path === "blast-review/SKILL.md") {
                  return success("21\t0\t\0/dev/null\0blast-review/SKILL.md\0");
                }
                if (path === "blast-review/agents/openai.yaml") {
                  return success("6\t0\t\0/dev/null\0blast-review/agents/openai.yaml\0");
                }
                return success("");
              }
              case "vcs.panel.gitIndexPath":
                return success("/tmp/t3-code-test-missing-index");
              case "vcs.panel.tempIndexReadTree":
              case "vcs.panel.tempIndexIntentToAdd":
                return success("");
              case "vcs.panel.unstagedNameStatusWithUntracked":
                return success(
                  [
                    "R043",
                    "copilot-blast-review/SKILL.md",
                    "blast-review/SKILL.md",
                    "R035",
                    "copilot-blast-review/agents/openai.yaml",
                    "blast-review/agents/openai.yaml",
                    "",
                  ].join("\0"),
                );
              case "vcs.panel.unstagedNumstatWithUntracked":
                return success(
                  [
                    "2\t1\t",
                    "copilot-blast-review/SKILL.md",
                    "blast-review/SKILL.md",
                    "6\t1\t",
                    "copilot-blast-review/agents/openai.yaml",
                    "blast-review/agents/openai.yaml",
                    "",
                  ].join("\0"),
                );
              default:
                return success("");
            }
          }),
        ),
      ),
    ),
  );

  it.effect("uses all untracked destinations when enriching a visible deleted source", () => {
    const calls: ExecuteGitInput[] = [];

    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.enrichWorkingTreeFiles({
        cwd: "/repo",
        paths: ["copilot-blast-review/SKILL.md"],
      });

      assert.deepStrictEqual(result.files, [
        {
          path: "blast-review/SKILL.md",
          originalPath: "copilot-blast-review/SKILL.md",
          status: "renamed",
          insertions: 2,
          deletions: 1,
        },
      ]);
      assert.deepStrictEqual(result.hiddenPaths, ["copilot-blast-review/SKILL.md"]);
      assert.deepStrictEqual(
        calls.find((call) => call.operation === "vcs.panel.tempIndexIntentToAdd")?.args,
        [
          "--literal-pathspecs",
          "add",
          "-N",
          "--",
          "blast-review/SKILL.md",
          "blast-review/agents/openai.yaml",
          "blast-review/scripts/blast-review.ts",
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.enrichWorkingTreeFiles.statusPorcelain":
                return success(
                  [
                    "# branch.oid abc",
                    "# branch.head main",
                    "1 .D N... 100644 100644 000000 abc abc copilot-blast-review/SKILL.md",
                    "? blast-review/SKILL.md",
                    "? blast-review/agents/openai.yaml",
                    "? blast-review/scripts/blast-review.ts",
                  ].join("\n"),
                );
              case "vcs.panel.enrichWorkingTreeFiles.unstagedNumstat":
                return success("0\t20\tcopilot-blast-review/SKILL.md\n");
              case "vcs.panel.gitIndexPath":
                return success("/tmp/t3-code-test-missing-index");
              case "vcs.panel.tempIndexReadTree":
              case "vcs.panel.tempIndexIntentToAdd":
                return success("");
              case "vcs.panel.unstagedNameStatusWithUntracked":
                return success(
                  [
                    "R043",
                    "copilot-blast-review/SKILL.md",
                    "blast-review/SKILL.md",
                    "R035",
                    "copilot-blast-review/agents/openai.yaml",
                    "blast-review/agents/openai.yaml",
                    "",
                  ].join("\0"),
                );
              case "vcs.panel.unstagedNumstatWithUntracked":
                return success(
                  [
                    "2\t1\t",
                    "copilot-blast-review/SKILL.md",
                    "blast-review/SKILL.md",
                    "6\t1\t",
                    "copilot-blast-review/agents/openai.yaml",
                    "blast-review/agents/openai.yaml",
                    "",
                  ].join("\0"),
                );
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("infers line-based numstat renames when name-status is missing", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(result.commits[0]?.files, [
        {
          path: "new-name.ts",
          originalPath: "old-name.ts",
          status: "renamed",
          insertions: 3,
          deletions: 1,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            switch (input.operation) {
              case "vcs.panel.branchCommitCount":
                return success("1");
              case "vcs.panel.branchCommits":
                return success(
                  "abc123\tabc123\tAda\tada@example.test\t2026-06-20T12:00:00.000Z\tRename file",
                );
              case "vcs.panel.commitRefs":
              case "vcs.panel.commitNameStatus":
                return success("");
              case "vcs.panel.commitNumstat":
                return success("3\t1\told-name.ts\tnew-name.ts\n");
              default:
                return success("");
            }
          }),
        ),
      ),
    ),
  );

  it.effect("infers nul-delimited binary numstat renames when name-status is missing", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(result.commits[0]?.files, [
        {
          path: "new\tname.bin",
          originalPath: "old\tname.bin",
          status: "renamed",
          insertions: 0,
          deletions: 0,
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            switch (input.operation) {
              case "vcs.panel.branchCommitCount":
                return success("1");
              case "vcs.panel.branchCommits":
                return success(
                  "abc123\tabc123\tAda\tada@example.test\t2026-06-20T12:00:00.000Z\tRename binary",
                );
              case "vcs.panel.commitRefs":
              case "vcs.panel.commitNameStatus":
                return success("");
              case "vcs.panel.commitNumstat":
                return success("-\t-\t\0old\tname.bin\0new\tname.bin\0");
              default:
                return success("");
            }
          }),
        ),
      ),
    ),
  );
});
