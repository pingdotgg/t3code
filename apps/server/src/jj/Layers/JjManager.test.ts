import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { describe, expect } from "vitest";
import type { ThreadId } from "@t3tools/contracts";

import { GitHubCliError } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import { GitHubCli, type GitHubCliShape } from "../../git/Services/GitHubCli.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerInput,
  type ProjectSetupScriptRunnerShape,
} from "../../project/Services/ProjectSetupScriptRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { JjCore } from "../Services/JjCore.ts";
import { JjCoreLive } from "./JjCore.ts";
import { makeJjManager } from "./JjManager.ts";
import {
  addRemoteAndPush,
  createBareRemote,
  initJjRepo,
  makeTempDir,
  runJj,
  writeTextFile,
} from "./JjTestUtils.ts";

interface FakeGhScenario {
  pullRequest: {
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
    state?: "open" | "closed" | "merged";
    isCrossRepository?: boolean;
    headRepositoryNameWithOwner?: string | null;
    headRepositoryOwnerLogin?: string | null;
  };
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
}

function runGitSyncForFakeGh(cwd: string, args: readonly string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  throw new GitHubCliError({
    operation: "execute",
    detail: `Failed to simulate gh checkout with git ${args.join(" ")}: ${result.stderr?.trim() || "unknown error"}`,
  });
}

function createGitHubCliWithFakeGh(scenario: FakeGhScenario): GitHubCliShape {
  const execute: GitHubCliShape["execute"] = (input) => {
    const args = [...input.args];

    if (args[0] === "pr" && args[1] === "view") {
      const pullRequest = scenario.pullRequest;
      return Effect.succeed({
        stdout: `${JSON.stringify(pullRequest)}\n`,
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "checkout") {
      return Effect.try({
        try: () => {
          const headBranch = scenario.pullRequest.headRefName;
          const existingBranch = spawnSync(
            "git",
            ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
            {
              cwd: input.cwd,
              encoding: "utf8",
            },
          );
          if (existingBranch.status === 0) {
            runGitSyncForFakeGh(input.cwd, ["checkout", headBranch]);
          } else {
            runGitSyncForFakeGh(input.cwd, ["checkout", "-b", headBranch]);
          }
          return {
            stdout: "",
            stderr: "",
            code: 0,
            signal: null,
            timedOut: false,
          };
        },
        catch: (error) =>
          Schema.is(GitHubCliError)(error)
            ? error
            : new GitHubCliError({
                operation: "execute",
                detail:
                  error instanceof Error
                    ? `Failed to simulate gh checkout: ${error.message}`
                    : "Failed to simulate gh checkout.",
              }),
      });
    }

    if (args[0] === "repo" && args[1] === "view") {
      const repository = args[2];
      if (typeof repository === "string" && args.includes("nameWithOwner,url,sshUrl")) {
        const cloneUrls = scenario.repositoryCloneUrls?.[repository];
        if (!cloneUrls) {
          return Effect.fail(
            new GitHubCliError({
              operation: "execute",
              detail: `Unexpected repository lookup: ${repository}`,
            }),
          );
        }
        return Effect.succeed({
          stdout:
            JSON.stringify({
              nameWithOwner: repository,
              url: cloneUrls.url,
              sshUrl: cloneUrls.sshUrl,
            }) + "\n",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
        });
      }

      return Effect.succeed({
        stdout: "main\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    if (args[0] === "pr" && args[1] === "list") {
      return Effect.succeed({
        stdout: "[]\n",
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });
    }

    return Effect.fail(
      new GitHubCliError({
        operation: "execute",
        detail: `Unexpected gh command: ${args.join(" ")}`,
      }),
    );
  };

  return {
    execute,
    listOpenPullRequests: () => Effect.succeed([]),
    createPullRequest: () => Effect.void,
    getDefaultBranch: () => Effect.succeed("main"),
    getPullRequest: () => Effect.succeed(scenario.pullRequest),
    getRepositoryCloneUrls: (input) => {
      const cloneUrls = scenario.repositoryCloneUrls?.[input.repository];
      if (!cloneUrls) {
        return Effect.fail(
          new GitHubCliError({
            operation: "getRepositoryCloneUrls",
            detail: `Unexpected repository lookup: ${input.repository}`,
          }),
        );
      }
      return Effect.succeed({
        nameWithOwner: input.repository,
        url: cloneUrls.url,
        sshUrl: cloneUrls.sshUrl,
      });
    },
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  };
}

function makeManager(input: {
  ghScenario: FakeGhScenario;
  setupScriptRunner?: ProjectSetupScriptRunnerShape;
}) {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-jj-manager-test-",
  });
  const serverSettingsLayer = ServerSettingsService.layerTest();
  const gitCoreLayer = GitCoreLive.pipe(
    Layer.provide(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const jjCoreLayer = JjCoreLive.pipe(
    Layer.provide(serverConfigLayer),
    Layer.provide(gitCoreLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  const managerLayer = Layer.mergeAll(
    Layer.succeed(GitHubCli, createGitHubCliWithFakeGh(input.ghScenario)),
    Layer.succeed(TextGeneration, {
      generateCommitMessage: () => Effect.die("unused in JjManager tests"),
      generatePrContent: () => Effect.die("unused in JjManager tests"),
      generateBranchName: () => Effect.die("unused in JjManager tests"),
      generateThreadTitle: () => Effect.die("unused in JjManager tests"),
    }),
    Layer.succeed(
      ProjectSetupScriptRunner,
      input.setupScriptRunner ?? {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
    ),
    gitCoreLayer,
    jjCoreLayer,
    serverSettingsLayer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

  return makeJjManager().pipe(Effect.provide(managerLayer));
}

const asThreadId = (threadId: string) => threadId as ThreadId;

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-jj-manager-test-",
});
const GitCoreTestLayer = GitCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(NodeServices.layer),
);
const JjCoreTestLayer = JjCoreLive.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provide(GitCoreTestLayer),
  Layer.provideMerge(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(NodeServices.layer, GitCoreTestLayer, JjCoreTestLayer);

it.layer(TestLayer)("JjManager", (it) => {
  describe("preparePullRequestThread", () => {
    it.effect("prepares pull request threads in local mode on the PR head branch", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-manager-");
        yield* initJjRepo(repoDir);
        yield* writeTextFile(path.join(repoDir, "local.txt"), "local\n");
        yield* runJj(repoDir, ["file", "track", "local.txt"]);
        yield* runJj(repoDir, ["describe", "-m", "Local PR branch"]);
        yield* runJj(repoDir, ["bookmark", "create", "feature/pr-local", "-r", "@"]);
        yield* runJj(repoDir, ["new", "main"]);

        const manager = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 64,
              title: "Local PR",
              url: "https://github.com/pingdotgg/t3code/pull/64",
              baseRefName: "main",
              headRefName: "feature/pr-local",
              state: "open",
            },
          },
        });

        const result = yield* manager.preparePullRequestThread({
          cwd: repoDir,
          reference: "#64",
          mode: "local",
        });

        expect(result.branch).toBe("feature/pr-local");
        expect(result.worktreePath).toBeNull();
        const status = yield* manager.status({ cwd: repoDir });
        expect(status.branch).toBe("feature/pr-local");
      }),
    );

    it.effect("creates a new JJ workspace for a same-repo PR and launches setup once", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-manager-");
        yield* initJjRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* addRemoteAndPush(repoDir, "origin", remoteDir);
        yield* writeTextFile(path.join(repoDir, "worktree.txt"), "worktree\n");
        yield* runJj(repoDir, ["file", "track", "worktree.txt"]);
        yield* runJj(repoDir, ["describe", "-m", "PR worktree branch"]);
        yield* runJj(repoDir, ["bookmark", "create", "feature/pr-worktree", "-r", "@"]);
        yield* runJj(repoDir, ["new", "main"]);
        yield* runJj(repoDir, ["git", "fetch", "--remote", "origin"], true);
        yield* runJj(repoDir, ["bookmark", "track", "feature/pr-worktree@origin"], true);
        yield* runJj(repoDir, ["git", "push", "--remote", "origin", "-b", "feature/pr-worktree"]);
        yield* runJj(repoDir, ["git", "export"]);
        yield* runJj(repoDir, [
          "util",
          "exec",
          "--",
          "git",
          "push",
          "origin",
          "feature/pr-worktree:refs/pull/77/head",
        ]);
        yield* runJj(repoDir, ["git", "import"]);

        const setupCalls: ProjectSetupScriptRunnerInput[] = [];
        const manager = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 77,
              title: "Worktree PR",
              url: "https://github.com/pingdotgg/t3code/pull/77",
              baseRefName: "main",
              headRefName: "feature/pr-worktree",
              state: "open",
            },
          },
          setupScriptRunner: {
            runForThread: (setupInput) =>
              Effect.sync(() => {
                setupCalls.push(setupInput);
                return { status: "no-script" as const };
              }),
          },
        });

        const result = yield* manager.preparePullRequestThread({
          cwd: repoDir,
          reference: "77",
          mode: "worktree",
          threadId: asThreadId("thread-jj-pr-worktree"),
        });

        expect(result.branch).toBe("feature/pr-worktree");
        expect(result.worktreePath).not.toBeNull();
        expect(fs.existsSync(result.worktreePath as string)).toBe(true);
        const jjCore = yield* JjCore;
        const worktreeStatus = yield* jjCore.statusDetails(result.worktreePath as string);
        const rootStatus = yield* jjCore.statusDetails(repoDir);

        expect(worktreeStatus.branch).toBe("feature/pr-worktree");
        expect(rootStatus.branch).toBe("main");
        expect(setupCalls).toEqual([
          {
            threadId: "thread-jj-pr-worktree",
            projectCwd: repoDir,
            worktreePath: result.worktreePath as string,
          },
        ]);
      }),
    );

    it.effect("preserves fork upstream tracking when preparing a JJ PR workspace", () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-jj-manager-");
        yield* initJjRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* addRemoteAndPush(repoDir, "origin", originDir);
        yield* writeTextFile(path.join(repoDir, "fork.txt"), "fork\n");
        yield* runJj(repoDir, ["file", "track", "fork.txt"]);
        yield* runJj(repoDir, ["describe", "-m", "Fork PR branch"]);
        yield* runJj(repoDir, ["bookmark", "create", "feature/pr-fork", "-r", "@"]);
        yield* runJj(repoDir, ["new", "main"]);
        yield* runJj(repoDir, ["git", "remote", "add", "fork-seed", forkDir]).pipe(Effect.asVoid);
        yield* runJj(repoDir, ["git", "export"]);
        yield* runJj(repoDir, [
          "util",
          "exec",
          "--",
          "git",
          "push",
          "fork-seed",
          "feature/pr-fork",
        ]);
        yield* runJj(repoDir, ["bookmark", "delete", "feature/pr-fork"]);
        yield* runJj(repoDir, ["git", "import"]);

        const manager = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 81,
              title: "Fork PR",
              url: "https://github.com/pingdotgg/t3code/pull/81",
              baseRefName: "main",
              headRefName: "feature/pr-fork",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/t3code",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/t3code": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* manager.preparePullRequestThread({
          cwd: repoDir,
          reference: "81",
          mode: "worktree",
        });

        expect(result.branch).toBe("t3code/pr-81/feature/pr-fork");
        expect(result.worktreePath).not.toBeNull();
        const jjCore = yield* JjCore;
        const worktreeStatus = yield* jjCore.statusDetails(result.worktreePath as string);
        const rootStatus = yield* jjCore.statusDetails(repoDir);

        expect(worktreeStatus.branch).toBe("t3code/pr-81/feature/pr-fork");
        // The upstream remote name depends on URL normalization between jj and
        // the fake GH CLI; assert the branch portion is correct.
        expect(worktreeStatus.upstreamRef).toMatch(/\/feature\/pr-fork$/);
        expect(rootStatus.branch).toBe("main");
      }),
    );
  });
});
