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
import { SOURCE_CONTROL_PANEL_REF_AFFECTING_ACTION_METHODS } from "./SourceControlPanelActions.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { GIT_COMMAND_TIMEOUT_MS } from "../vcs/GitCommandTimeout.ts";
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
  gitDriver: Partial<GitVcsDriver["Service"]> = {},
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
        ...gitDriver,
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
  it.effect("keeps the default branch as its own stable comparison base", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const details = yield* service.branchDetails({
        cwd: "/repo",
        branch: {
          name: "develop",
          current: true,
          isDefault: true,
          worktreePath: "/repo",
        },
        defaultCompareRef: "develop",
      });

      assert.equal(details.baseRef, "develop");
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => success(input.args[0] === "rev-list" ? "0" : "")),
        ),
      ),
    ),
  );

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

  it.effect("does not fetch provider account avatar URLs by default", () => {
    let avatarLookupCount = 0;

    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      assert.equal(result.commits[0]?.authorAvatarUrl, null);
      assert.equal(result.commits[1]?.authorAvatarUrl, null);
      assert.equal(avatarLookupCount, 0);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.args[0]) {
                case "rev-list":
                  return success("2");
                case "log":
                  return success(
                    [
                      "a".repeat(40),
                      "aaaaaaa",
                      "Ada Lovelace",
                      "ada@example.test",
                      "2026-06-27T10:00:00+00:00",
                      "Add source control avatars",
                    ].join("\t") +
                      "\n" +
                      [
                        "b".repeat(40),
                        "bbbbbbb",
                        "Grace Hopper",
                        "grace@example.test",
                        "2026-06-27T09:00:00+00:00",
                        "Keep avatars distinct",
                      ].join("\t"),
                  );
                case "remote":
                  return success(
                    [
                      "origin\thttps://github.com/pingdotgg/t3code.git (fetch)",
                      "origin\thttps://github.com/pingdotgg/t3code.git (push)",
                    ].join("\n"),
                  );
                default:
                  return success("");
              }
            }),
          {},
          {
            github: SourceControlProvider.SourceControlProvider.of({
              ...emptyProvider,
              kind: "github",
              getCommitAvatarUrl: () =>
                Effect.sync(() => {
                  avatarLookupCount += 1;
                  return "https://avatars.githubusercontent.com/u/101?v=4";
                }),
            }),
          },
        ),
      ),
    );
  });

  it.effect("uses opted-in provider account avatar URLs for commit authors", () => {
    const avatarLookups: Array<{
      readonly sha: string;
      readonly authorEmail: string | null | undefined;
      readonly remoteUrl: string | undefined;
    }> = [];

    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const result = yield* service.branchCommits({
        cwd: "/repo",
        branch: branchRef,
        baseRef: "main",
        kind: "history",
        skip: 0,
        limit: 10,
      });

      const firstAvatar = result.commits[0]?.authorAvatarUrl;
      const secondAvatar = result.commits[1]?.authorAvatarUrl;

      if (typeof firstAvatar !== "string" || typeof secondAvatar !== "string") {
        assert.fail("expected commit authors to have provider avatar URLs");
      }
      assert.equal(firstAvatar, "https://avatars.githubusercontent.com/u/101?v=4");
      assert.equal(secondAvatar, "https://avatars.githubusercontent.com/u/202?v=4");
      assert.notStrictEqual(firstAvatar, secondAvatar);
      assert.deepStrictEqual(avatarLookups, [
        {
          sha: "a".repeat(40),
          authorEmail: "ada@example.test",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
        {
          sha: "b".repeat(40),
          authorEmail: "grace@example.test",
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
        },
      ]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.sync(() => {
              switch (input.args[0]) {
                case "rev-list":
                  return success("2");
                case "log":
                  return success(
                    [
                      "a".repeat(40),
                      "aaaaaaa",
                      "Ada Lovelace",
                      "ada@example.test",
                      "2026-06-27T10:00:00+00:00",
                      "Add source control avatars",
                    ].join("\t") +
                      "\n" +
                      [
                        "b".repeat(40),
                        "bbbbbbb",
                        "Grace Hopper",
                        "grace@example.test",
                        "2026-06-27T09:00:00+00:00",
                        "Keep avatars distinct",
                      ].join("\t"),
                  );
                case "remote":
                  return success(
                    [
                      "origin\thttps://github.com/pingdotgg/t3code.git (fetch)",
                      "origin\thttps://github.com/pingdotgg/t3code.git (push)",
                    ].join("\n"),
                  );
                default:
                  return success("");
              }
            }),
          {},
          {
            github: SourceControlProvider.SourceControlProvider.of({
              ...emptyProvider,
              kind: "github",
              getCommitAvatarUrl: (input) =>
                Effect.sync(() => {
                  avatarLookups.push({
                    sha: input.sha,
                    authorEmail: input.authorEmail,
                    remoteUrl: input.context?.remoteUrl,
                  });
                  return input.sha.startsWith("a")
                    ? "https://avatars.githubusercontent.com/u/101?v=4"
                    : "https://avatars.githubusercontent.com/u/202?v=4";
                }),
            }),
          },
          {
            sourceControl: {
              providers: {
                github: {
                  showCommitAuthorAvatar: true,
                },
              },
            },
          },
        ),
      ),
    );
  });

  it.effect("keeps wrapper messages structural while preserving sanitized causes", () => {
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
      assert.strictEqual(error.detail, "Source control operation failed.");
      assert.strictEqual(error.message.includes("transport closed"), false);
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

  it.effect("keeps action wrapper messages structural while preserving sanitized causes", () => {
    const cause = new Error("credential-bearing workflow failure");
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .commitStaged({
          cwd: "/repo",
          message: "Test commit",
          push: true,
        })
        .pipe(Effect.flip);

      assert.strictEqual(isGitCommandError(error), true);
      assert.strictEqual(error.operation, "vcs.panel.commitStaged.status");
      assert.strictEqual(error.detail, "Git command failed.");
      assert.strictEqual(error.message.includes(cause.message), false);
      assert.deepStrictEqual(error.cause, {
        name: "Error",
        message: cause.message,
      });
    }).pipe(
      Effect.provide(
        makeTestLayer(() => Effect.succeed(success()), {
          status: () =>
            Effect.fail(cause) as unknown as ReturnType<GitWorkflowService["Service"]["status"]>,
        }),
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
          ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "HEAD", "--", "new-file.ts"],
          ["--literal-pathspecs", "reset", "--", "new-file.ts"],
          ["--literal-pathspecs", "clean", "-fd", "--", "new-file.ts"],
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
          ["--literal-pathspecs", "ls-files", "--cached", "--", "tracked.ts", "new-file.ts"],
          ["--literal-pathspecs", "restore", "--worktree", "--", "tracked.ts"],
          ["--literal-pathspecs", "clean", "-fd", "--", "tracked.ts", "new-file.ts"],
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
            ["--literal-pathspecs", "ls-files", "--cached", "--", "tracked.ts", "new-file.ts"],
          ],
          [
            "vcs.panel.discardUnstagedFiles",
            ["--literal-pathspecs", "restore", "--worktree", "--", "tracked.ts"],
          ],
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

  it.effect("does not abort a successful commit because of hook diagnostics", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        message: "Commit selected file",
      });
      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [["commit", "-m", "Commit selected file"]],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.gen(function* () {
            calls.push(input);
            yield* (
              input.progress?.onStderrLine?.("Error: Cannot find native binding") ?? Effect.void
            );
            yield* (
              input.progress?.onStderrLine?.("VITE+ - pre-commit script failed (code 1)") ??
                Effect.void
            );
            yield* Effect.yieldNow;
            return success();
          }),
        ),
      ),
    );
  });

  it.effect("enriches a failed commit with detected hook diagnostics", () => {
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const error = yield* service
        .commitStaged({
          cwd: "/repo",
          message: "Commit selected file",
        })
        .pipe(Effect.flip);

      assert.equal(
        error.detail,
        "The Git pre-commit hook could not load a required native dependency. Reinstall the repository dependencies and try again.",
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.gen(function* () {
            yield* (
              input.progress?.onStderrLine?.("Error: Cannot find native binding") ?? Effect.void
            );
            return failure("pre-commit hook failed");
          }),
        ),
      ),
    );
  });

  it.effect("stages and unstages selected files with literal pathspecs", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;
      const paths = ["src/[literal].ts"];

      yield* service.stageFiles({ cwd: "/repo", paths });
      yield* service.unstageFiles({ cwd: "/repo", paths });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          ["--literal-pathspecs", "add", "-A", "--", "src/[literal].ts"],
          ["--literal-pathspecs", "reset", "--", "src/[literal].ts"],
        ],
      );
      assert.isTrue(calls.every((call) => call.timeoutMs === GIT_COMMAND_TIMEOUT_MS.local));
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

  it.effect("stashes selected files with literal pathspecs", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.createStash({
        cwd: "/repo",
        paths: ["src/[literal].ts"],
        includeUntracked: true,
        message: "Save literal file",
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          [
            "--literal-pathspecs",
            "stash",
            "push",
            "--include-untracked",
            "-m",
            "Save literal file",
            "--",
            "src/[literal].ts",
          ],
        ],
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

  it.effect("commits selected files through an isolated temporary index", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        paths: ["src/mixed.ts"],
        message: "Commit selected file",
      });

      assert.deepStrictEqual(
        calls.map((call) => ({ operation: call.operation, args: call.args })),
        [
          {
            operation: "vcs.panel.commitStaged.tempIndexResolveHead",
            args: ["rev-parse", "--verify", "HEAD"],
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexReadTree",
            args: ["read-tree", "HEAD"],
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexAddSelected",
            args: ["--literal-pathspecs", "add", "-A", "--", "src/mixed.ts"],
          },
          {
            operation: "vcs.panel.commitStaged",
            args: ["commit", "-m", "Commit selected file"],
          },
          {
            operation: "vcs.panel.stageFiles",
            args: ["--literal-pathspecs", "add", "-A", "--", "src/mixed.ts"],
          },
        ],
      );
      const selectedIndexCalls = calls.filter((call) =>
        call.operation.startsWith("vcs.panel.commitStaged"),
      );
      assert.isTrue(selectedIndexCalls.every((call) => Boolean(call.env?.GIT_INDEX_FILE?.length)));
      assert.strictEqual(
        calls.find((call) => call.operation === "vcs.panel.commitStaged")?.timeoutMs,
        GIT_COMMAND_TIMEOUT_MS.commit,
      );
      assert.isUndefined(calls.at(-1)?.env?.GIT_INDEX_FILE);
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

  it.effect("leaves the real index untouched when a selected-file commit fails", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service
        .commitStaged({
          cwd: "/repo",
          paths: ["src/mixed.ts"],
          message: "Commit selected file",
        })
        .pipe(Effect.flip);

      assert.deepStrictEqual(
        calls.map((call) => call.operation),
        [
          "vcs.panel.commitStaged.tempIndexResolveHead",
          "vcs.panel.commitStaged.tempIndexReadTree",
          "vcs.panel.commitStaged.tempIndexAddSelected",
          "vcs.panel.commitStaged",
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.commitStaged"
              ? failure("commit failed")
              : success();
          }),
        ),
      ),
    );
  });

  it.effect("reports success when real-index sync fails after a selected-file commit", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        paths: ["src/[literal].ts"],
        message: "Commit selected file",
      });

      assert.deepStrictEqual(
        calls.map((call) => ({ operation: call.operation, args: call.args })),
        [
          {
            operation: "vcs.panel.commitStaged.tempIndexResolveHead",
            args: ["rev-parse", "--verify", "HEAD"],
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexReadTree",
            args: ["read-tree", "HEAD"],
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexAddSelected",
            args: ["--literal-pathspecs", "add", "-A", "--", "src/[literal].ts"],
          },
          {
            operation: "vcs.panel.commitStaged",
            args: ["commit", "-m", "Commit selected file"],
          },
          {
            operation: "vcs.panel.stageFiles",
            args: ["--literal-pathspecs", "add", "-A", "--", "src/[literal].ts"],
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.stageFiles"
              ? failure("index sync failed")
              : success();
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

  it.effect("initializes an empty selected-file index for an unborn HEAD", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        paths: ["README.md"],
        message: "Initial commit",
      });

      assert.deepStrictEqual(
        calls.slice(0, 3).map((call) => ({
          operation: call.operation,
          args: call.args,
          allowNonZeroExit: call.allowNonZeroExit,
        })),
        [
          {
            operation: "vcs.panel.commitStaged.tempIndexResolveHead",
            args: ["rev-parse", "--verify", "HEAD"],
            allowNonZeroExit: true,
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexReadTree",
            args: ["read-tree", "--empty"],
            allowNonZeroExit: false,
          },
          {
            operation: "vcs.panel.commitStaged.tempIndexAddSelected",
            args: ["--literal-pathspecs", "add", "-A", "--", "README.md"],
            allowNonZeroExit: false,
          },
        ],
      );
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          Effect.sync(() => {
            calls.push(input);
            return input.operation === "vcs.panel.commitStaged.tempIndexResolveHead"
              ? failure("Needed a single revision")
              : success();
          }),
        ),
      ),
    );
  });

  it.effect("reports success when post-commit index synchronization defects", () => {
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.commitStaged({
        cwd: "/repo",
        paths: ["src/selected.ts"],
        message: "Commit selected file",
      });
    }).pipe(
      Effect.provide(
        makeTestLayer((input) =>
          input.operation === "vcs.panel.stageFiles"
            ? Effect.die(new Error("index sync defect"))
            : Effect.succeed(success()),
        ),
      ),
    );
  });

  it.effect("scopes generated stash input to literal selected paths", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.createStash({
        cwd: "/repo",
        mode: "all",
        paths: ["src/[literal].ts"],
        includeUntracked: true,
      });

      assert.deepStrictEqual(
        calls.map((call) => ({ operation: call.operation, args: call.args })),
        [
          {
            operation: "vcs.panel.stashMessageSummary",
            args: ["--literal-pathspecs", "diff", "HEAD", "--stat", "--", "src/[literal].ts"],
          },
          {
            operation: "vcs.panel.stashMessagePatch",
            args: [
              "--literal-pathspecs",
              "diff",
              "HEAD",
              "--no-ext-diff",
              "--patch",
              "--minimal",
              "--",
              "src/[literal].ts",
            ],
          },
          {
            operation: "vcs.panel.stashMessageStatus",
            args: ["--literal-pathspecs", "status", "--short", "--", "src/[literal].ts"],
          },
          {
            operation: "vcs.panel.createStash",
            args: [
              "--literal-pathspecs",
              "stash",
              "push",
              "--include-untracked",
              "-m",
              "T3 Code all stash",
              "--",
              "src/[literal].ts",
            ],
          },
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

  it.effect("reverses comparisons with the working tree on the left", () => {
    const calls: ExecuteGitInput[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.compare({
        cwd: "/repo",
        left: { kind: "working-tree" },
        right: { kind: "branch", refName: "feature/right" },
      });
      yield* service.compare({
        cwd: "/repo",
        left: { kind: "branch", refName: "feature/left" },
        right: { kind: "working-tree" },
      });
      yield* service.compare({
        cwd: "/repo",
        left: { kind: "working-tree" },
        right: { kind: "working-tree" },
      });

      assert.deepStrictEqual(
        calls.map((call) => call.args),
        [
          [
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
            "--reverse",
            "feature/right",
          ],
          [
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
            "feature/left",
          ],
          [
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
          ],
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

  it("classifies only ref-affecting panel actions for shared ref invalidation", () => {
    assert.deepStrictEqual(SOURCE_CONTROL_PANEL_REF_AFFECTING_ACTION_METHODS, [
      "commitStaged",
      "pullBranch",
      "pushBranch",
      "deleteBranch",
      "undoLatestCommit",
      "revertCommit",
      "checkoutCommit",
      "createBranchFromCommit",
      "mergeBranchIntoCurrent",
      "rebaseCurrentOnto",
      "fetchBranch",
      "fetchRemote",
      "addRemote",
      "removeRemote",
    ]);
  });

  it.effect("invalidates shared refs only after attempted ref mutations", () => {
    const invalidations: string[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.createBranchFromCommit({
        cwd: "/repo",
        sha: "abc123",
        branchName: "feature/success",
      });
      assert.deepStrictEqual(invalidations, ["/repo"]);

      const failed = yield* Effect.exit(
        service.createBranchFromCommit({
          cwd: "/repo",
          sha: "abc123",
          branchName: "feature/failure",
        }),
      );
      assert(Exit.isFailure(failed));
      assert.deepStrictEqual(invalidations, ["/repo", "/repo"]);

      yield* service.fetchAllRemotes({ cwd: "/repo", force: true });
      assert.deepStrictEqual(invalidations, ["/repo", "/repo", "/repo"]);

      yield* service.fetchAllRemotes({ cwd: "/repo" });
      assert.deepStrictEqual(invalidations, ["/repo", "/repo", "/repo"]);

      const validationFailure = yield* Effect.exit(
        service.addRemote({
          cwd: "/repo",
          name: "-invalid",
          url: "https://example.com/repo.git",
        }),
      );
      assert(Exit.isFailure(validationFailure));
      assert.deepStrictEqual(invalidations, ["/repo", "/repo", "/repo"]);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          (input) =>
            Effect.succeed(
              input.args.includes("feature/failure")
                ? failure("branch creation failed")
                : success(),
            ),
          {},
          {},
          {},
          {
            invalidateRefs: (cwd) =>
              Effect.sync(() => {
                invalidations.push(cwd);
              }),
          },
        ),
      ),
    );
  });

  it.effect("does not invalidate shared refs for working-tree-only panel actions", () => {
    const invalidations: string[] = [];
    return Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      yield* service.stageFiles({ cwd: "/repo", paths: ["file.ts"] });

      assert.deepStrictEqual(invalidations, []);
    }).pipe(
      Effect.provide(
        makeTestLayer(
          () => Effect.succeed(success()),
          {},
          {},
          {},
          {
            invalidateRefs: (cwd) =>
              Effect.sync(() => {
                invalidations.push(cwd);
              }),
          },
        ),
      ),
    );
  });
});
