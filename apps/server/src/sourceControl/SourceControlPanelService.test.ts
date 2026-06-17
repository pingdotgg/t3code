import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GitCommandError, type VcsRef, type VcsStatusLocalResult } from "@t3tools/contracts";

import {
  SourceControlPanelService,
  layer as SourceControlPanelServiceLayer,
} from "./SourceControlPanelService.ts";
import { GitWorkflowService, type GitWorkflowServiceShape } from "../git/GitWorkflowService.ts";
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

function makeTestLayer(
  execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, never>,
  workflow: Partial<GitWorkflowServiceShape> = {},
) {
  return SourceControlPanelServiceLayer.pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provide(
      Layer.succeed(GitWorkflowService, {
        status: () =>
          Effect.fail(
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
      } as GitWorkflowServiceShape),
    ),
    Layer.provide(
      Layer.succeed(GitVcsDriver, {
        execute,
      } as unknown as GitVcsDriverShape),
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

  it.effect("detects unstaged renames from untracked destination files", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlPanelService;

      const snapshot = yield* service.snapshot({ cwd: "/repo" });
      const unstagedFiles =
        snapshot.changeGroups.find((group) => group.kind === "unstaged")?.files ?? [];

      assert.deepStrictEqual(unstagedFiles, [
        {
          path: "blast-review/agents/openai.yaml",
          originalPath: "copilot-blast-review/agents/openai.yaml",
          status: "renamed",
          insertions: 6,
          deletions: 1,
        },
        {
          path: "blast-review/scripts/blast-review.ts",
          originalPath: "copilot-blast-review/scripts/copilot-blast-review.ts",
          status: "renamed",
          insertions: 204,
          deletions: 21,
        },
        {
          path: "blast-review/SKILL.md",
          originalPath: "copilot-blast-review/SKILL.md",
          status: "renamed",
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
                case "vcs.panel.unstagedNumstat":
                  return success("0\t20\tcopilot-blast-review/SKILL.md\n");
                case "vcs.panel.untrackedNumstat": {
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
                      "R087",
                      "copilot-blast-review/scripts/copilot-blast-review.ts",
                      "blast-review/scripts/blast-review.ts",
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
                      "204\t21\t",
                      "copilot-blast-review/scripts/copilot-blast-review.ts",
                      "blast-review/scripts/blast-review.ts",
                      "",
                    ].join("\0"),
                  );
                case "vcs.panel.stagedNumstat":
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
