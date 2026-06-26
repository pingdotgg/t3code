import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
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
import {
  GitVcsDriver,
  type ExecuteGitInput,
  type ExecuteGitResult,
  type GitVcsDriverShape,
} from "../vcs/GitVcsDriver.ts";

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
  execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, never>,
  workflow: Partial<GitWorkflowService["Service"]> = {},
  providers: Partial<
    Record<SourceControlProviderKind, SourceControlProvider.SourceControlProvider["Service"]>
  > = {},
) {
  return SourceControlPanelServiceLayer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
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
      } as unknown as GitVcsDriverShape),
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
  it.effect("uses the selected branch head for history queries", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["rev-list", "--count", "feature/source-control"],
          [
            "log",
            "--skip=0",
            "--max-count=10",
            "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
            "feature/source-control",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(input.args[0] === "rev-list" ? "0" : "");
          }),
        ),
      ),
    );
  });

  it.effect("uses the compare range for compare-history branch queries", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "compare-history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["rev-list", "--count", "main...feature/source-control"],
          [
            "log",
            "--skip=0",
            "--max-count=10",
            "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
            "main...feature/source-control",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(input.args[0] === "rev-list" ? "0" : "");
          }),
        ),
      ),
    );
  });

  it.effect("uses the selected branch for compare-history queries without a base", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: null,
        kind: "compare-history",
        skip: 0,
        limit: 10,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["rev-list", "--count", "feature/source-control"],
          [
            "log",
            "--skip=0",
            "--max-count=10",
            "--format=%H%x09%h%x09%an%x09%ae%x09%aI%x09%s",
            "feature/source-control",
          ],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success(input.args[0] === "rev-list" ? "0" : "");
          }),
        ),
      ),
    );
  });

  it.effect("preserves sanitized causes when wrapping git execution failures", () => {
    const cause = new Error("transport closed");
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .branchCommits({
          cwd: "/repo",
          branch: branchRef,
          baseRef: "main",
          kind: "history",
          skip: 0,
          limit: 10,
        })
        .pipe(Effect.flip);

      assert.strictEqual(isGitCommandError(error), true);
      assert.strictEqual(error.detail, "transport closed");
      assert.deepStrictEqual(error.cause, {
        name: "Error",
        message: "transport closed",
      });
    }).pipe(
      Effect.provide(
        makeTestLayer(
          () => Effect.fail(cause) as unknown as Effect.Effect<ExecuteGitResult, never>,
        ),
      ),
    );
  });

  it.effect("cleans staged additions missing from HEAD without failing tracked paths", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.discardFiles({
        cwd: "/repo",
        paths: ["new-file.ts"],
        staged: true,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["ls-tree", "-r", "--name-only", "HEAD", "--", "new-file.ts"],
          ["reset", "--", "new-file.ts"],
          ["clean", "-fd", "--", "new-file.ts"],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return success("");
          }),
        ),
      ),
    );
  });

  it.effect("discards mixed tracked and untracked unstaged files in one action", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.discardFiles({
        cwd: "/repo",
        paths: ["tracked.ts", "new-file.ts"],
        staged: false,
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["ls-files", "--cached", "--", "tracked.ts", "new-file.ts"],
          ["restore", "--worktree", "--", "tracked.ts"],
          ["clean", "-fd", "--", "tracked.ts", "new-file.ts"],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.discardUnstagedFiles.listIndexPaths"
              ? success("tracked.ts\n")
              : success("");
          }),
        ),
      ),
    );
  });

  it.effect("fails unstaged discard when tracked restore fails", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .discardFiles({
          cwd: "/repo",
          paths: ["tracked.ts", "new-file.ts"],
          staged: false,
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.discardUnstagedFiles");
      const relevantCalls = calls.filter((call) =>
        [
          "vcs.panel.discardUnstagedFiles.listIndexPaths",
          "vcs.panel.discardUnstagedFiles",
          "vcs.panel.cleanUntrackedFiles",
        ].includes(call.operation),
      );
      assert.deepStrictEqual(
        relevantCalls.map((call) => [call.operation, call.args]),
        [
          [
            "vcs.panel.discardUnstagedFiles.listIndexPaths",
            ["ls-files", "--cached", "--", "tracked.ts", "new-file.ts"],
          ],
          ["vcs.panel.discardUnstagedFiles", ["restore", "--worktree", "--", "tracked.ts"]],
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            if (input.operation === "vcs.panel.discardUnstagedFiles.listIndexPaths") {
              return success("tracked.ts\n");
            }
            if (input.operation === "vcs.panel.discardUnstagedFiles") {
              return failure("restore failed");
            }
            return success("");
          }),
        ),
      ),
    );
  });

  it.effect("preserves multiline commit message formatting in one git argument", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        message: "Subject\nBody without blank separator",
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [["commit", "-m", "Subject\nBody without blank separator"]],
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

  it.effect("commits the staged index without pathspecs after staging selected files", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        paths: ["src/mixed.ts"],
        message: "Commit selected file",
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [["commit", "-m", "Commit selected file"]],
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

  it.effect("passes merge refs after a positional separator", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.mergeBranchIntoCurrent({
        cwd: "/repo",
        refName: "feature/source-control",
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [["merge", "--no-edit", "--", "feature/source-control"]],
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
            "--no-ext-diff",
            "--patch",
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
            args: ["add", "-N", "--", "src/new.ts"],
          },
          {
            operation: "vcs.panel.readFileDiff",
            args: [
              "diff",
              "--no-ext-diff",
              "--patch",
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

  it.effect("pulls non-current branches from upstream remotes with slashes in their name", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.pullBranch({
        cwd: "/repo",
        branchName: "main",
      });

      const fetchCall = calls.find((call) => call.operation === "vcs.panel.pullBranch.nonCurrent");
      assert.deepStrictEqual(fetchCall?.args, [
        "fetch",
        "team/upstream",
        "refs/heads/main:refs/heads/main",
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("team/upstream/main\n");
                case "vcs.panel.pullBranch.remotes":
                  return success("origin\nteam/upstream\n");
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
        ),
      ),
    );
  });

  it.effect("rejects slashful upstreams that do not match a known remote", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .pullBranch({
          cwd: "/repo",
          branchName: "main",
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.pullBranch");
      assert.equal(error.detail, "Branch main has invalid upstream team/upstream/main.");
      assert.equal(
        calls.some((call) => call.operation === "vcs.panel.pullBranch.nonCurrent"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("team/upstream/main\n");
                case "vcs.panel.pullBranch.remotes":
                  return success("origin\n");
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "feature/source-control",
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
        ),
      ),
    );
  });

  it.effect("rejects slashless local upstreams when pulling non-current branches", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .pullBranch({
          cwd: "/repo",
          branchName: "feature/source-control",
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.pullBranch");
      assert.equal(error.detail, "Branch feature/source-control has invalid upstream main.");
      assert.equal(
        calls.some((call) => call.operation === "vcs.panel.pullBranch.nonCurrent"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.branchUpstream":
                  return success("main\n");
                case "vcs.panel.pullBranch.remotes":
                  return success("origin\nupstream\n");
                default:
                  return success("");
              }
            }),
          {
            status: () =>
              Effect.succeed({
                ...localStatus,
                refName: "main",
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                aheadOfDefaultCount: 0,
                pr: null,
              }),
          },
        ),
      ),
    );
  });

  it.effect("fetches branches from upstream remotes with slashes in their name", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.fetchBranch({
        cwd: "/repo",
        branchName: "team/upstream/main",
      });

      const fetchCall = calls.find((call) => call.operation === "vcs.panel.fetchBranch");
      assert.deepStrictEqual(fetchCall?.args, [
        "fetch",
        "team/upstream",
        "refs/heads/main:refs/remotes/team/upstream/main",
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.fetchBranch.remotes":
                return success("origin\nteam/upstream\n");
              case "vcs.panel.fetchBranch.remoteBranch":
                return success("abc123 refs/remotes/team/upstream/main\n");
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("resolves local branch deletion from the server snapshot", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.deleteBranch({
        cwd: "/repo",
        branchName: "feature/source-control",
        force: true,
      });

      const deleteCall = calls.find((call) => call.operation === "vcs.panel.deleteLocalBranch");
      assert.deepStrictEqual(deleteCall?.args, ["branch", "-D", "feature/source-control"]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    "feature/source-control\t\t\t2026-06-20T12:00:00.000Z\torigin/feature/source-control\t",
                  );
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head main");
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.stagedNameStatus":
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
    );
  });

  it.effect("resolves remote branch deletion from the server snapshot", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.deleteBranch({
        cwd: "/repo",
        branchName: "origin/feature/source-control",
      });

      const deleteCall = calls.find((call) => call.operation === "vcs.panel.deleteRemoteBranch");
      assert.deepStrictEqual(deleteCall?.args, [
        "push",
        "origin",
        "--delete",
        "feature/source-control",
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success("");
                case "vcs.panel.remotes":
                  return success(
                    [
                      "origin\tgit@example.test:fork/repo.git\t(fetch)",
                      "origin\tgit@example.test:fork/repo.git\t(push)",
                    ].join("\n"),
                  );
                case "vcs.panel.remoteBranches":
                  return success("origin/feature/source-control\t2026-06-20T12:00:00.000Z\n");
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head main");
                case "vcs.panel.stashes":
                case "vcs.panel.stagedNumstat":
                case "vcs.panel.stagedNameStatus":
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
    );
  });

  it.effect("fetches local branches with remote-looking names from their upstream", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.fetchBranch({
        cwd: "/repo",
        branchName: "origin/feature",
      });

      const fetchCall = calls.find((call) => call.operation === "vcs.panel.fetchBranch");
      assert.deepStrictEqual(fetchCall?.args, [
        "fetch",
        "upstream",
        "refs/heads/main:refs/remotes/upstream/main",
      ]);
      assert.equal(
        calls.some((call) => call.operation === "vcs.panel.fetchBranch.remoteBranch"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.fetchBranch.remotes":
                return success("origin\nupstream\n");
              case "vcs.panel.fetchBranch.localBranch":
                return success("abc123 refs/heads/origin/feature\n");
              case "vcs.panel.branchUpstream":
                return success("upstream/main\n");
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("rejects slashless local upstreams when fetching local branches", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .fetchBranch({
          cwd: "/repo",
          branchName: "feature/source-control",
        })
        .pipe(Effect.flip);

      assert.equal(error.operation, "vcs.panel.fetchBranch");
      assert.equal(error.detail, "Branch feature/source-control has invalid upstream main.");
      assert.equal(
        calls.some((call) => call.operation === "vcs.panel.fetchBranch"),
        false,
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            switch (input.operation) {
              case "vcs.panel.fetchBranch.remotes":
                return success("origin\nupstream\n");
              case "vcs.panel.fetchBranch.localBranch":
                return success("abc123 refs/heads/feature/source-control\n");
              case "vcs.panel.branchUpstream":
                return success("main\n");
              default:
                return success("");
            }
          }),
        ),
      ),
    );
  });

  it.effect("defers untracked detail loading from the initial snapshot", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });
      const unstagedFiles =
        snapshot.changeGroups.find((group) => group.kind === "unstaged")?.files ?? [];

      assert.equal(unstagedFiles.length, 101);
      assert.deepStrictEqual(unstagedFiles[0], {
        path: "generated/file-000.txt",
        originalPath: null,
        status: "untracked",
        insertions: 0,
        deletions: 0,
      });
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              assert.notInclude(
                [
                  "vcs.panel.untrackedNumstat",
                  "vcs.panel.gitIndexPath",
                  "vcs.panel.tempIndexIntentToAdd",
                  "vcs.panel.unstagedNameStatusWithUntracked",
                  "vcs.panel.unstagedNumstatWithUntracked",
                ],
                input.operation,
              );

              switch (input.operation) {
                case "vcs.panel.localBranches":
                case "vcs.panel.remotes":
                case "vcs.panel.stashes":
                  return success("");
                case "vcs.panel.statusPorcelain":
                  return success(
                    [
                      "# branch.oid abc",
                      "# branch.head main",
                      ...Array.from(
                        { length: 101 },
                        (_, index) => `? generated/file-${index.toString().padStart(3, "0")}.txt`,
                      ),
                    ].join("\n"),
                  );
                case "vcs.panel.stagedNumstat":
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

  it.effect("uses the repository default branch as the default compare ref even when current", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

      assert.equal(snapshot.defaultCompareRef, "main");
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.operation) {
                case "vcs.panel.localBranches":
                  return success(
                    [
                      "main\t*\t/repo\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t\t\t2026-06-19T12:00:00.000Z\t\t",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  return success("# branch.oid abc\n# branch.head main");
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
                refName: "main",
                isDefaultRef: true,
                hasWorkingTreeChanges: false,
              }),
          },
        ),
      ),
    ),
  );

  it.effect("surfaces same-name remote forks only when the local branch is behind", () =>
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
                      "origin\tgit@example.test:fork/repo.git\t(fetch)",
                      "origin\tgit@example.test:fork/repo.git\t(push)",
                      "upstream\tgit@example.test:upstream/repo.git\t(fetch)",
                      "upstream\tgit@example.test:upstream/repo.git\t(push)",
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
        ),
      ),
    ),
  );

  it.effect("attaches worktree paths from git worktree porcelain output", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo/worktrees/feature" });

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
            worktreePath: "/repo/worktrees/feature",
          },
          {
            name: "main",
            current: false,
            worktreePath: "/repo",
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
                      "worktree /repo",
                      "HEAD abc",
                      "branch refs/heads/main",
                      "",
                      "worktree /repo/worktrees/feature",
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
    ),
  );

  it.effect("includes dirty non-current worktrees as separate change sets", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });

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
            worktreePath: "/repo/worktrees/feature",
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
                      "main\t*\t/repo\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t\t/repo/worktrees/feature\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t",
                    ].join("\n"),
                  );
                case "vcs.panel.worktrees":
                  return success(
                    [
                      "worktree /repo",
                      "HEAD abc",
                      "branch refs/heads/main",
                      "",
                      "worktree /repo/worktrees/feature",
                      "HEAD def",
                      "branch refs/heads/feature/source-control",
                      "",
                    ].join("\n"),
                  );
                case "vcs.panel.statusPorcelain":
                  if (input.cwd === "/repo/worktrees/feature") {
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
                  return input.cwd === "/repo/worktrees/feature"
                    ? success("2\t0\tsrc/staged.ts\0")
                    : success("");
                case "vcs.panel.stagedNameStatus":
                  return input.cwd === "/repo/worktrees/feature"
                    ? success("A\0src/staged.ts\0")
                    : success("");
                case "vcs.panel.unstagedNumstat":
                  return input.cwd === "/repo/worktrees/feature"
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
    ),
  );

  it.effect("falls back to branch-format worktree paths when worktree porcelain is empty", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo/worktrees/feature" });

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
            worktreePath: "/repo/worktrees/feature",
          },
          {
            name: "main",
            current: false,
            worktreePath: "/repo",
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
                      "main\t\t/repo\t2026-06-20T12:00:00.000Z\torigin/main\t",
                      "feature/source-control\t*\t/repo/worktrees/feature\t2026-06-21T12:00:00.000Z\torigin/feature/source-control\t[ahead 1]",
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
    ),
  );

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

  it.effect("rejects option-like branch names before creating a branch", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .createBranchFromCommit({
          cwd: "/repo",
          sha: "abc",
          branchName: "-D",
        })
        .pipe(Effect.flip);

      assert.equal(error.detail, 'Branch name cannot start with "-".');
    }).pipe(
      Effect.provide(
        makeTestLayer(() =>
          Effect.sync(() => {
            throw new Error("git should not run for invalid branch names");
          }),
        ),
      ),
    ),
  );
});
