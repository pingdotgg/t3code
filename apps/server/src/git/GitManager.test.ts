// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vitest";
import type {
  GitActionProgressEvent,
  GitPreparePullRequestThreadInput,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";

import { GitCommandError, TextGenerationError } from "@t3tools/contracts";
import { type GitManagerShape } from "./GitManager.ts";
import {
  GitHubCliError,
  type GitHubCliShape,
  type GitHubPullRequestSummary,
  GitHubCli,
} from "../sourceControl/GitHubCli.ts";
import { type TextGenerationShape, TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubSourceControlProvider from "../sourceControl/GitHubSourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { makeGitManager } from "./GitManager.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ProjectSetupScriptRunner,
  ProjectSetupScriptRunnerError,
  type ProjectSetupScriptRunnerInput,
  type ProjectSetupScriptRunnerShape,
} from "../project/Services/ProjectSetupScriptRunner.ts";

interface FakeGhScenario {
  prListSequence?: string[];
  prListByHeadSelector?: Record<string, string>;
  prListSequenceByHeadSelector?: Record<string, string[]>;
  createdPrUrl?: string;
  defaultBranch?: string;
  pullRequest?: {
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
  failWith?: GitHubCliError;
}

function fakeGhOutput(stdout: string): VcsProcess.VcsProcessOutput {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

interface FakeGitTextGeneration {
  generateCommitMessage: (input: {
    cwd: string;
    branch: string | null;
    stagedSummary: string;
    stagedPatch: string;
    includeBranch?: boolean;
    modelSelection: ModelSelection;
  }) => Effect.Effect<
    { subject: string; body: string; branch?: string | undefined },
    TextGenerationError
  >;
  generatePrContent: (input: {
    cwd: string;
    baseBranch: string;
    headBranch: string;
    commitSummary: string;
    diffSummary: string;
    diffPatch: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ title: string; body: string }, TextGenerationError>;
  generateBranchName: (input: {
    cwd: string;
    message: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ branch: string }, TextGenerationError>;
  generateThreadTitle: (input: {
    cwd: string;
    message: string;
    modelSelection: ModelSelection;
  }) => Effect.Effect<{ title: string }, TextGenerationError>;
}

type FakePullRequest = NonNullable<FakeGhScenario["pullRequest"]>;

function normalizeFakePullRequestSummary(raw: unknown): GitHubPullRequestSummary | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const number = record.number;
  const title = record.title;
  const url = record.url;
  const baseRefName = record.baseRefName;
  const headRefName = record.headRefName;
  const headRepository =
    typeof record.headRepository === "object" && record.headRepository !== null
      ? (record.headRepository as Record<string, unknown>)
      : null;
  const headRepositoryOwner =
    typeof record.headRepositoryOwner === "object" && record.headRepositoryOwner !== null
      ? (record.headRepositoryOwner as Record<string, unknown>)
      : null;

  if (
    typeof number !== "number" ||
    typeof title !== "string" ||
    typeof url !== "string" ||
    typeof baseRefName !== "string" ||
    typeof headRefName !== "string"
  ) {
    return null;
  }

  const state =
    typeof record.state === "string"
      ? record.state === "OPEN" || record.state === "open"
        ? "open"
        : record.state === "CLOSED" || record.state === "closed"
          ? "closed"
          : "merged"
      : undefined;
  const isCrossRepository =
    typeof record.isCrossRepository === "boolean" ? record.isCrossRepository : undefined;
  const headRepositoryNameWithOwner =
    typeof record.headRepositoryNameWithOwner === "string"
      ? record.headRepositoryNameWithOwner
      : typeof headRepository?.nameWithOwner === "string"
        ? headRepository.nameWithOwner
        : undefined;
  const headRepositoryOwnerLogin =
    typeof record.headRepositoryOwnerLogin === "string"
      ? record.headRepositoryOwnerLogin
      : typeof headRepositoryOwner?.login === "string"
        ? headRepositoryOwner.login
        : undefined;

  return {
    number,
    title,
    url,
    baseRefName,
    headRefName,
    ...(state ? { state } : {}),
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
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

function isGitHubCliError(error: unknown): error is GitHubCliError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "GitHubCliError"
  );
}

function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

function removePath(
  targetPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(targetPath, { recursive: true, force: true });
  });
}

function makeDirectory(
  dirPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(dirPath, { recursive: true });
  });
}

function runGit(
  cwd: string,
  args: readonly string[],
  allowNonZeroExit = false,
): Effect.Effect<
  {
    readonly exitCode: GitVcsDriver.ExecuteGitResult["exitCode"];
    readonly stdout: string;
    readonly stderr: string;
  },
  GitCommandError,
  GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* git.execute({
      operation: "GitManager.test.runGit",
      cwd,
      args,
      allowNonZeroExit,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
}

function initRepo(
  cwd: string,
): Effect.Effect<
  void,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* runGit(cwd, ["init", "--initial-branch=main"]);
    yield* runGit(cwd, ["config", "user.email", "test@example.com"]);
    yield* runGit(cwd, ["config", "user.name", "Test User"]);
    yield* fs.writeFileString(path.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

function createBareRemote(): Effect.Effect<
  string,
  PlatformError.PlatformError | GitCommandError,
  FileSystem.FileSystem | Scope.Scope | GitVcsDriver.GitVcsDriver
> {
  return Effect.gen(function* () {
    const remoteDir = yield* makeTempDir("t3code-git-remote-");
    yield* runGit(remoteDir, ["init", "--bare"]);
    return remoteDir;
  });
}

function configureRemote(
  cwd: string,
  remoteName: string,
  remotePath: string,
  fetchNamespace: string,
): Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, remotePath]);
    yield* runGit(cwd, [
      "config",
      "--replace-all",
      `remote.${remoteName}.fetch`,
      `+refs/heads/*:refs/remotes/${fetchNamespace}/*`,
    ]);
  });
}

function configureVisibleRemoteUrlWithLocalRewrite(
  cwd: string,
  remoteName: string,
  visibleUrl: string,
  localRemotePath: string,
): Effect.Effect<void, GitCommandError, GitVcsDriver.GitVcsDriver> {
  return Effect.gen(function* () {
    yield* runGit(cwd, ["config", `remote.${remoteName}.url`, visibleUrl]);
    yield* runGit(cwd, ["config", `url.${localRemotePath}.insteadOf`, visibleUrl]);
  });
}

function createTextGeneration(overrides: Partial<FakeGitTextGeneration> = {}): TextGenerationShape {
  const implementation: FakeGitTextGeneration = {
    generateCommitMessage: (input) =>
      Effect.succeed({
        subject: "Implement stacked git actions",
        body: "",
        ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
      }),
    generatePrContent: () =>
      Effect.succeed({
        title: "Add stacked git actions",
        body: "## Summary\n- Add stacked git workflow\n\n## Testing\n- Not run",
      }),
    generateBranchName: () =>
      Effect.succeed({
        branch: "update-workflow",
      }),
    generateThreadTitle: () =>
      Effect.succeed({
        title: "Update workflow",
      }),
    ...overrides,
  };

  return {
    generateCommitMessage: (input) =>
      implementation.generateCommitMessage(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generatePrContent: (input) =>
      implementation.generatePrContent(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateBranchName: (input) =>
      implementation.generateBranchName(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
    generateThreadTitle: (input) =>
      implementation.generateThreadTitle(input).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "fake text generation failed",
              ...(cause !== undefined ? { cause } : {}),
            }),
        ),
      ),
  };
}

function createGitHubCliWithFakeGh(scenario: FakeGhScenario = {}): {
  service: GitHubCliShape;
  ghCalls: string[];
} {
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const prListQueueByHeadSelector = new Map(
    Object.entries(scenario.prListSequenceByHeadSelector ?? {}).map(([headSelector, values]) => [
      headSelector,
      [...values],
    ]),
  );
  const ghCalls: string[] = [];

  const execute: GitHubCliShape["execute"] = (input) => {
    const args = [...input.args];
    ghCalls.push(args.join(" "));

    if (scenario.failWith) {
      return Effect.fail(scenario.failWith);
    }

    if (args[0] === "pr" && args[1] === "list") {
      const headSelectorIndex = args.findIndex((value) => value === "--head");
      const headSelector =
        headSelectorIndex >= 0 && headSelectorIndex < args.length - 1
          ? args[headSelectorIndex + 1]
          : undefined;
      const mappedQueue =
        typeof headSelector === "string"
          ? prListQueueByHeadSelector.get(headSelector)?.shift()
          : undefined;
      const mappedStdout =
        typeof headSelector === "string"
          ? scenario.prListByHeadSelector?.[headSelector]
          : undefined;
      const stdout = (mappedQueue ?? mappedStdout ?? prListQueue.shift() ?? "[]") + "\n";
      return Effect.succeed(fakeGhOutput(stdout));
    }

    if (args[0] === "pr" && args[1] === "create") {
      return Effect.succeed(
        fakeGhOutput(
          (scenario.createdPrUrl ?? "https://github.com/pingdotgg/codething-mvp/pull/101") + "\n",
        ),
      );
    }

    if (args[0] === "pr" && args[1] === "view") {
      const pullRequest: FakePullRequest = scenario.pullRequest ?? {
        number: 101,
        title: "Pull request",
        url: "https://github.com/pingdotgg/codething-mvp/pull/101",
        baseRefName: "main",
        headRefName: "feature/pull-request",
        state: "open",
      };
      return Effect.succeed(
        fakeGhOutput(
          JSON.stringify({
            ...pullRequest,
            ...(pullRequest.headRepositoryNameWithOwner
              ? {
                  headRepository: {
                    nameWithOwner: pullRequest.headRepositoryNameWithOwner,
                  },
                }
              : {}),
            ...(pullRequest.headRepositoryOwnerLogin
              ? {
                  headRepositoryOwner: {
                    login: pullRequest.headRepositoryOwnerLogin,
                  },
                }
              : {}),
          }) + "\n",
        ),
      );
    }

    if (args[0] === "pr" && args[1] === "checkout") {
      return Effect.try({
        try: () => {
          const headBranch = scenario.pullRequest?.headRefName;
          if (headBranch) {
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
          }
          return fakeGhOutput("");
        },
        catch: (error) =>
          isGitHubCliError(error)
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
        return Effect.succeed(
          fakeGhOutput(
            JSON.stringify({
              nameWithOwner: repository,
              url: cloneUrls.url,
              sshUrl: cloneUrls.sshUrl,
            }) + "\n",
          ),
        );
      }
      return Effect.succeed(fakeGhOutput(`${scenario.defaultBranch ?? "main"}\n`));
    }

    return Effect.fail(
      new GitHubCliError({
        operation: "execute",
        detail: `Unexpected gh command: ${args.join(" ")}`,
      }),
    );
  };

  return {
    service: {
      execute,
      listOpenPullRequests: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "list",
            "--head",
            input.headSelector,
            "--state",
            "open",
            "--limit",
            String(input.limit ?? 1),
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(
          Effect.map((result) => JSON.parse(result.stdout) as unknown[]),
          Effect.map((raw) =>
            raw
              .map((entry) => normalizeFakePullRequestSummary(entry))
              .filter((entry): entry is GitHubPullRequestSummary => entry !== null),
          ),
        ),
      createPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "create",
            "--base",
            input.baseBranch,
            "--head",
            input.headSelector,
            "--title",
            input.title,
            "--body-file",
            input.bodyFile,
          ],
        }).pipe(Effect.asVoid),
      getDefaultBranch: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        }).pipe(
          Effect.map((result) => {
            const value = result.stdout.trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            input.reference,
            "--json",
            "number,title,url,baseRefName,headRefName,state,mergedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout) as GitHubPullRequestSummary)),
      getRepositoryCloneUrls: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout))),
      createRepository: (input) =>
        Effect.fail(
          new GitHubCliError({
            operation: "createRepository",
            detail: `Unexpected repository create: ${input.repository}`,
          }),
        ),
      checkoutPullRequest: (input) =>
        execute({
          cwd: input.cwd,
          args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
        }).pipe(Effect.asVoid),
    },
    ghCalls,
  };
}

function runStackedAction(
  manager: GitManagerShape,
  input: {
    cwd: string;
    action: "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  },
  options?: Parameters<GitManagerShape["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

function resolvePullRequest(manager: GitManagerShape, input: { cwd: string; reference: string }) {
  return manager.resolvePullRequest(input);
}

function preparePullRequestThread(
  manager: GitManagerShape,
  input: GitPreparePullRequestThreadInput,
) {
  return manager.preparePullRequestThread(input);
}

function makeManager(input?: {
  ghScenario?: FakeGhScenario;
  textGeneration?: Partial<FakeGitTextGeneration>;
  setupScriptRunner?: ProjectSetupScriptRunnerShape;
}) {
  const { service: gitHubCli, ghCalls } = createGitHubCliWithFakeGh(input?.ghScenario);
  const textGeneration = createTextGeneration(input?.textGeneration);
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-git-manager-test-",
  });

  const serverSettingsLayer = ServerSettingsService.layerTest();

  const vcsDriverLayer = GitVcsDriver.layer.pipe(
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ServerConfigLayer),
  );
  const sourceControlRegistryLayer = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    GitHubSourceControlProvider.make().pipe(
      Effect.map((provider) =>
        SourceControlProviderRegistry.SourceControlProviderRegistry.of({
          get: () => Effect.succeed(provider),
          resolveHandle: () => Effect.succeed({ provider, context: null }),
          resolve: () => Effect.succeed(provider),
          discover: Effect.succeed([]),
        }),
      ),
      Effect.provide(Layer.succeed(GitHubCli, gitHubCli)),
    ),
  );

  const managerLayer = Layer.mergeAll(
    Layer.succeed(TextGeneration, textGeneration),
    Layer.succeed(
      ProjectSetupScriptRunner,
      input?.setupScriptRunner ?? {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
    ),
    vcsDriverLayer,
    serverSettingsLayer,
  ).pipe(Layer.provideMerge(sourceControlRegistryLayer), Layer.provideMerge(NodeServices.layer));

  return makeGitManager().pipe(
    Effect.provide(managerLayer),
    Effect.map((manager) => ({ manager, ghCalls })),
  );
}

const asThreadId = (threadId: string) => threadId as ThreadId;

const GitManagerTestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-manager-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(GitManagerTestLayer)("GitManager", (it) => {
  it.effect("status includes PR metadata when branch already has an open PR", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-open-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 13,
                title: "Existing PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/13",
                baseRefName: "main",
                headRefName: "feature/status-open-pr",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.isRepo).toBe(true);
      expect(status.hasPrimaryRemote).toBe(true);
      expect(status.isDefaultRef).toBe(false);
      expect(status.refName).toBe("feature/status-open-pr");
      expect(status.pr).toEqual({
        number: 13,
        title: "Existing PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/13",
        baseRef: "main",
        headRef: "feature/status-open-pr",
        state: "open",
      });
    }),
  );

  it.effect("status trims PR metadata returned by gh before publishing it", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-trimmed-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-trimmed-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 14,
                title: "  Existing PR title  \n",
                url: " https://github.com/pingdotgg/codething-mvp/pull/14 ",
                baseRefName: " main ",
                headRefName: "\tfeature/status-trimmed-pr\t",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr).toEqual({
        number: 14,
        title: "Existing PR title",
        url: "https://github.com/pingdotgg/codething-mvp/pull/14",
        baseRef: "main",
        headRef: "feature/status-trimmed-pr",
        state: "open",
      });
    }),
  );

  it.effect("status ignores invalid gh pr list entries and keeps valid ones", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-valid-pr-entry"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-valid-pr-entry"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 0,
                title: "invalid",
                url: "https://github.com/pingdotgg/codething-mvp/pull/0",
                baseRefName: "main",
                headRefName: "feature/invalid",
              },
              {
                number: 15,
                title: "  Valid PR title  ",
                url: " https://github.com/pingdotgg/codething-mvp/pull/15 ",
                baseRefName: " main ",
                headRefName: "\tfeature/status-valid-pr-entry\t",
                headRepository: {
                  nameWithOwner: "   ",
                },
                headRepositoryOwner: {
                  login: "   ",
                },
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr).toEqual({
        number: 15,
        title: "Valid PR title",
        url: "https://github.com/pingdotgg/codething-mvp/pull/15",
        baseRef: "main",
        headRef: "feature/status-valid-pr-entry",
        state: "open",
      });
    }),
  );

  it.effect("status preserves lowercase merged and closed PR states from gh json", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-lowercase-state"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-lowercase-state"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 16,
                title: "Closed PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/16",
                baseRefName: "main",
                headRefName: "feature/status-lowercase-state",
                state: "closed",
                updatedAt: "2026-01-01T00:00:00.000Z",
              },
              {
                number: 17,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/17",
                baseRefName: "main",
                headRefName: "feature/status-lowercase-state",
                state: "merged",
                updatedAt: "2026-01-02T00:00:00.000Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr).toEqual({
        number: 17,
        title: "Merged PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/17",
        baseRef: "main",
        headRef: "feature/status-lowercase-state",
        state: "merged",
      });
    }),
  );

  it.effect("status returns an explicit non-repo result for non-git directories", () =>
    Effect.gen(function* () {
      const cwd = yield* makeTempDir("t3code-git-manager-non-repo-");
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
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
    }),
  );

  it.effect("status returns an explicit non-repo result for deleted directories", () =>
    Effect.gen(function* () {
      const rootDir = yield* makeTempDir("t3code-git-manager-missing-dir-");
      const cwd = path.join(rootDir, "deleted-repo");
      yield* makeDirectory(cwd);
      yield* removePath(cwd);
      const { manager } = yield* makeManager();

      const status = yield* manager.status({ cwd });

      expect(status).toEqual({
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
    }),
  );

  it.effect("status briefly caches repeated lookups for the same cwd", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-cache"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-cache"]);

      const existingPr = {
        number: 113,
        title: "Cached PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/113",
        baseRefName: "main",
        headRefName: "feature/status-cache",
      };
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr]), JSON.stringify([existingPr])],
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      const second = yield* manager.status({ cwd: repoDir });

      expect(first.pr?.number).toBe(113);
      expect(second.pr?.number).toBe(113);
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
    }),
  );

  it.effect(
    "status ignores unrelated fork PRs when the current branch tracks the same repository",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 1661,
                  title: "Fork PR from main",
                  url: "https://github.com/pingdotgg/t3code/pull/1661",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "OPEN",
                  updatedAt: "2026-04-01T15:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "lnieuwenhuis/t3code",
                  },
                  headRepositoryOwner: {
                    login: "lnieuwenhuis",
                  },
                },
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("main");
        expect(status.pr).toBeNull();
      }),
  );

  it.effect(
    "status detects cross-repo PRs from the upstream remote URL owner",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        fs.writeFileSync(path.join(repoDir, "fork-pr.txt"), "fork pr\n");
        yield* runGit(repoDir, ["add", "fork-pr.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-488/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "fork-seed",
          "git@github.com:jasonLaster/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 488,
                  title: "Rebase this PR on latest main",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/488",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  updatedAt: "2026-03-10T07:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "jasonLaster/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "jasonLaster",
                  },
                },
              ]),
            ],
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("t3code/pr-488/statemachine");
        expect(status.pr).toEqual({
          number: 488,
          title: "Rebase this PR on latest main",
          url: "https://github.com/pingdotgg/codething-mvp/pull/488",
          baseRef: "main",
          headRef: "statemachine",
          state: "open",
        });
        expect(ghCalls).toContain(
          "pr list --head jasonLaster:statemachine --state all --limit 20 --json number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        );
      }),
    20_000,
  );

  it.effect(
    "status ignores synthetic local branch aliases when the upstream remote name contains slashes",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* configureRemote(repoDir, "origin", originDir, "origin");
        yield* configureRemote(repoDir, "my-org/upstream", upstreamDir, "my-org/upstream");

        yield* runGit(repoDir, ["checkout", "-b", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "my-org/upstream", "effect-atom"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "git@github.com:pingdotgg/codething-mvp.git",
          originDir,
        );
        yield* runGit(repoDir, ["config", "remote.origin.pushurl", originDir]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "my-org/upstream",
          "ssh://git@github.com/pingdotgg/codething-mvp.git",
          upstreamDir,
        );
        yield* runGit(repoDir, ["config", "remote.my-org/upstream.pushurl", upstreamDir]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "effect-atom"]);
        yield* runGit(repoDir, ["checkout", "--track", "my-org/upstream/effect-atom"]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "effect-atom": JSON.stringify([
                {
                  number: 1618,
                  title: "Correct PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1618",
                  baseRefName: "main",
                  headRefName: "effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-03-01T10:00:00Z",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "pingdotgg:effect-atom": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "my-org/upstream:effect-atom": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "pingdotgg:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "my-org/upstream:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                  state: "OPEN",
                  updatedAt: "2026-04-01T10:00:00Z",
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("upstream/effect-atom");
        expect(status.pr).toEqual({
          number: 1618,
          title: "Correct PR",
          url: "https://github.com/pingdotgg/t3code/pull/1618",
          baseRef: "main",
          headRef: "effect-atom",
          state: "open",
        });
        expect(ghCalls.some((call) => call.includes("pr list --head upstream/effect-atom "))).toBe(
          false,
        );
        expect(
          ghCalls.some((call) => call.includes("pr list --head pingdotgg:upstream/effect-atom ")),
        ).toBe(false);
        expect(
          ghCalls.some((call) =>
            call.includes("pr list --head my-org/upstream:upstream/effect-atom "),
          ),
        ).toBe(false);
      }),
    20_000,
  );

  it.effect("status returns merged PR state when latest PR was merged", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-merged-pr"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 22,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/22",
                baseRefName: "main",
                headRefName: "feature/status-merged-pr",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/status-merged-pr");
      expect(status.pr).toEqual({
        number: 22,
        title: "Merged PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/22",
        baseRef: "main",
        headRef: "feature/status-merged-pr",
        state: "merged",
      });
    }),
  );

  it.effect("status hides merged PRs on the default branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 23,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/23",
                baseRefName: "feature/status-default-branch-target",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2026-01-30T10:00:00Z",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("main");
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("status prefers open PR when merged PR has newer updatedAt", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-over-merged"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 45,
                title: "Merged PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/45",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "MERGED",
                mergedAt: "2026-01-31T10:00:00Z",
                updatedAt: "2026-02-01T10:00:00Z",
              },
              {
                number: 46,
                title: "Open PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/46",
                baseRefName: "main",
                headRefName: "feature/status-open-over-merged",
                state: "OPEN",
                updatedAt: "2026-01-30T10:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/status-open-over-merged");
      expect(status.pr).toEqual({
        number: 46,
        title: "Open PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/46",
        baseRef: "main",
        headRef: "feature/status-open-over-merged",
        state: "open",
      });
    }),
  );

  it.effect("status is resilient to gh lookup failures and returns pr null", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-no-gh"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-no-gh"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCliError({
            operation: "execute",
            detail: "GitHub CLI (`gh`) is required but not available on PATH.",
          }),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/status-no-gh");
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nworld\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Push",
          action: {
            kind: "push",
          },
        },
      });
      expect(result.toast.title).toMatch(/^Committed [0-9a-f]{7}$/);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("Implement stacked git actions");
    }),
  );

  it.effect("uses custom commit message when provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "this should not be used",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%s"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feat: custom summary line");
      expect(
        yield* runGit(repoDir, ["log", "-1", "--pretty=%b"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toContain("- details from user");
    }),
  );

  it.effect("commits only selected files when filePaths is provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "a.txt"), "file a\n");
      fs.writeFileSync(path.join(repoDir, "b.txt"), "file b\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        filePaths: ["a.txt"],
      });

      expect(result.commit.status).toBe("created");

      // b.txt should remain in the working tree
      const statusStdout = yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
        Effect.map((r) => r.stdout),
      );
      expect(statusStdout).toContain("b.txt");
      expect(statusStdout).not.toContain("a.txt");
    }),
  );

  it.effect("creates feature branch, commits, and pushes with featureBranch option", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\nfeature-branch\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "Implement stacked git actions",
                body: "",
                ...(input.includeBranch ? { branch: "feature/implement-stacked-git-actions" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
        featureBranch: true,
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/implement-stacked-git-actions");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.toast).toMatchObject({
        description: "Implement stacked git actions",
        cta: {
          kind: "run_action",
          label: "Create PR",
          action: {
            kind: "create_pr",
          },
        },
      });
      expect(result.toast.title).toMatch(
        /^Pushed [0-9a-f]{7} to origin\/feature\/implement-stacked-git-actions$/,
      );
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("feature/implement-stacked-git-actions");

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", "HEAD"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
      expect(generatedCount).toBe(1);
    }),
  );

  it.effect("featureBranch uses custom commit message and derives branch name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "README.md"), "hello\ncustom-feature\n");
      let generatedCount = 0;

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: (input) =>
            Effect.sync(() => {
              generatedCount += 1;
              return {
                subject: "unused",
                body: "",
                ...(input.includeBranch ? { branch: "feature/unused" } : {}),
              };
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
        commitMessage: "feat: custom summary line\n\n- details from user",
      });

      expect(result.branch.status).toBe("created");
      expect(result.branch.name).toBe("feature/feat-custom-summary-line");
      expect(result.commit.status).toBe("created");
      expect(result.commit.subject).toBe("feat: custom summary line");
      expect(generatedCount).toBe(0);

      const mainSha = yield* runGit(repoDir, ["rev-parse", "main"]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      const mergeBase = yield* runGit(repoDir, ["merge-base", "main", result.branch.name!]).pipe(
        Effect.map((r) => r.stdout.trim()),
      );
      expect(mergeBase).toBe(mainSha);
    }),
  );

  it.effect("skips commit when there are no uncommitted changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("skipped_no_changes");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
    }),
  );

  it.effect("featureBranch returns error when worktree is clean", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("no changes to commit");
    }),
  );

  it.effect("commits and pushes with upstream auto-setup when needed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/stacked-flow"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("pushed");
      expect(result.push.setUpstream).toBe(true);
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
          Effect.map((result) => result.stdout.trim()),
        ),
      ).toBe("origin/feature/stacked-flow");
    }),
  );

  it.effect(
    "pushes and creates PR from a no-upstream branch when local commits are ahead of base",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/no-upstream-pr"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "feature.txt"), "feature\n");

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              "[]",
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 77,
                  title: "Add no-upstream PR flow",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/77",
                  baseRefName: "main",
                  headRefName: "feature/no-upstream-pr",
                },
              ]),
            ],
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.branch.status).toBe("skipped_not_requested");
        expect(result.commit.status).toBe("created");
        expect(result.push.status).toBe("pushed");
        expect(result.push.setUpstream).toBe(true);
        expect(result.pr.status).toBe("created");
        expect(
          yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
            Effect.map((result) => result.stdout.trim()),
          ),
        ).toBe("origin/feature/no-upstream-pr");
        expect(
          ghCalls.some((call) =>
            call.includes("pr create --base main --head feature/no-upstream-pr"),
          ),
        ).toBe(true);
      }),
  );

  it.effect("skips push when branch is already up to date", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/up-to-date"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/up-to-date"]);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("skipped_no_changes");
      expect(result.push.status).toBe("skipped_up_to_date");
    }),
  );

  it.effect("pushes existing clean commits without rerunning commit logic", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/push-only"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "push-only.txt"), "push only\n");
      yield* runGit(repoDir, ["add", "push-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Push only branch"]);

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "push",
      });

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("pushed");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(
        yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"]).pipe(
          Effect.map((output) => output.stdout.trim()),
        ),
      ).toBe("origin/feature/push-only");
    }),
  );

  it.effect("pushes existing commits without committing dirty worktree changes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/push-dirty"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "push-dirty.txt"), "push dirty\n");
      yield* runGit(repoDir, ["add", "push-dirty.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Push dirty branch"]);
      fs.mkdirSync(path.join(repoDir, ".vercel"));
      fs.writeFileSync(path.join(repoDir, ".vercel", "project.json"), "{}\n");

      const { manager } = yield* makeManager();
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "push",
      });

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("pushed");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(
        yield* runGit(repoDir, ["status", "--porcelain"]).pipe(
          Effect.map((output) => output.stdout.trim()),
        ),
      ).toContain("?? .vercel/");
      expect(
        yield* runGit(remoteDir, ["log", "-1", "--pretty=%s", "feature/push-dirty"]).pipe(
          Effect.map((output) => output.stdout.trim()),
        ),
      ).toBe("Push dirty branch");
    }),
  );

  it.effect("create_pr pushes a clean branch before creating the PR when needed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/create-pr-only"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "create-pr-only.txt"), "create pr\n");
      yield* runGit(repoDir, ["add", "create-pr-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Create PR only branch"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            "[]",
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 303,
                title: "Create PR only branch",
                url: "https://github.com/pingdotgg/codething-mvp/pull/303",
                baseRefName: "main",
                headRefName: "feature/create-pr-only",
              },
            ]),
          ],
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "create_pr",
      });

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("pushed");
      expect(result.push.setUpstream).toBe(true);
      expect(result.pr.status).toBe("created");
      expect(result.pr.number).toBe(303);
      expect(
        ghCalls.some((call) =>
          call.includes("pr create --base main --head feature/create-pr-only"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("create_pr falls back to main when source control provider detection fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/provider-fallback"]);
      fs.writeFileSync(path.join(repoDir, "provider-fallback.txt"), "fallback\n");
      yield* runGit(repoDir, ["add", "provider-fallback.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Provider fallback"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            "[]",
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 404,
                title: "Provider fallback",
                url: "https://github.com/pingdotgg/codething-mvp/pull/404",
                baseRefName: "main",
                headRefName: "feature/provider-fallback",
              },
            ]),
          ],
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "create_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(result.pr.number).toBe(404);
      expect(
        ghCalls.some((call) =>
          call.includes("pr create --base main --head feature/provider-fallback"),
        ),
      ).toBe(true);
    }),
  );

  it.effect("returns existing PR metadata for commit/push/pr action", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/existing-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/existing-pr"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 42,
                title: "Existing PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/42",
                baseRefName: "main",
                headRefName: "feature/existing-pr",
              },
            ]),
          ],
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("opened_existing");
      expect(result.pr.number).toBe(42);
      expect(result.toast).toEqual({
        title: "Opened PR #42",
        description: "Existing PR",
        cta: {
          kind: "open_pr",
          label: "View PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        },
      });
      expect(ghCalls.some((call) => call.startsWith("pr view "))).toBe(false);
    }),
  );

  it.effect(
    "returns existing cross-repo PR metadata using the fork owner selector",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "fork-seed",
          "git@github.com:octocat/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 142,
                  title: "Existing fork PR",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/142",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "octocat/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "octocat",
                  },
                },
              ]),
            ],
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);
        expect(
          ghCalls.some((call) =>
            call.includes("pr list --head octocat:statemachine --state open --limit 1"),
          ),
        ).toBe(true);
        expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(false);
      }),
    12_000,
  );

  it.effect(
    "returns the correct existing PR when a slash remote checks out to a synthetic local alias",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* configureRemote(repoDir, "origin", originDir, "origin");
        yield* configureRemote(repoDir, "my-org/upstream", upstreamDir, "my-org/upstream");

        yield* runGit(repoDir, ["checkout", "-b", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "effect-atom"]);
        yield* runGit(repoDir, ["push", "-u", "my-org/upstream", "effect-atom"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "git@github.com:pingdotgg/codething-mvp.git",
          originDir,
        );
        yield* runGit(repoDir, ["config", "remote.origin.pushurl", originDir]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "my-org/upstream",
          "ssh://git@github.com/pingdotgg/codething-mvp.git",
          upstreamDir,
        );
        yield* runGit(repoDir, ["config", "remote.my-org/upstream.pushurl", upstreamDir]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "effect-atom"]);
        yield* runGit(repoDir, ["checkout", "--track", "my-org/upstream/effect-atom"]);
        fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
        yield* runGit(repoDir, ["add", "changes.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "effect-atom": JSON.stringify([
                {
                  number: 1618,
                  title: "Correct PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1618",
                  baseRefName: "main",
                  headRefName: "effect-atom",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "pingdotgg:effect-atom": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "my-org/upstream:effect-atom": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "pingdotgg:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "my-org/upstream:upstream/effect-atom": JSON.stringify([
                {
                  number: 1518,
                  title: "Wrong PR",
                  url: "https://github.com/pingdotgg/t3code/pull/1518",
                  baseRefName: "main",
                  headRefName: "upstream/effect-atom",
                },
              ]),
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(1618);
        expect(ghCalls.some((call) => call.includes("pr list --head upstream/effect-atom "))).toBe(
          false,
        );
      }),
    20_000,
  );

  it.effect(
    "prefers owner-qualified selectors before bare branch names for cross-repo PRs",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-142/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "fork-seed",
          "git@github.com:octocat/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "t3code/pr-142/statemachine": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              statemachine: JSON.stringify([
                {
                  number: 41,
                  title: "Unrelated same-repo PR",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/41",
                  baseRefName: "main",
                  headRefName: "statemachine",
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "octocat:statemachine": JSON.stringify([
                {
                  number: 142,
                  title: "Existing fork PR",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/142",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "octocat/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "octocat",
                  },
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "fork-seed:statemachine": JSON.stringify([]),
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);

        const ownerSelectorCallIndex = ghCalls.findIndex((call) =>
          call.includes("pr list --head octocat:statemachine --state open --limit 1"),
        );
        expect(ownerSelectorCallIndex).toBeGreaterThanOrEqual(0);
        expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(false);
      }),
    12_000,
  );

  it.effect(
    "stops probing head selectors after finding an existing PR",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-142/statemachine"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "fork-seed",
          "git@github.com:octocat/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "octocat:statemachine": JSON.stringify([
                {
                  number: 142,
                  title: "Existing fork PR",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/142",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "octocat/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "octocat",
                  },
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "fork-seed:statemachine": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "t3code/pr-142/statemachine": JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              statemachine: JSON.stringify([]),
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);

        const openLookupCalls = ghCalls.filter((call) => call.includes("--state open --limit 1"));
        expect(openLookupCalls).toHaveLength(1);
        expect(openLookupCalls[0]).toContain(
          "pr list --head octocat:statemachine --state open --limit 1",
        );
      }),
    12_000,
  );

  it.effect("creates PR when one does not already exist", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature-create-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
      yield* runGit(repoDir, ["add", "changes.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature-create-pr"]);
      yield* runGit(repoDir, ["config", "branch.feature-create-pr.gh-merge-base", "main"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            "[]",
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 88,
                title: "Add stacked git actions",
                url: "https://github.com/pingdotgg/codething-mvp/pull/88",
                baseRefName: "main",
                headRefName: "feature-create-pr",
              },
            ]),
          ],
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("created");
      expect(result.pr.number).toBe(88);
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);
      expect(
        ghCalls.some((call) => call.includes("pr create --base main --head feature-create-pr")),
      ).toBe(true);
      expect(ghCalls.some((call) => call.startsWith("pr view "))).toBe(false);
    }),
  );

  it.effect(
    "creates a new PR instead of reusing an unrelated fork PR with the same head branch",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/no-fork-match"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
        yield* runGit(repoDir, ["add", "changes.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/no-fork-match"]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 1661,
                  title: "Fork PR with same branch name",
                  url: "https://github.com/pingdotgg/t3code/pull/1661",
                  baseRefName: "main",
                  headRefName: "feature/no-fork-match",
                  state: "OPEN",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "lnieuwenhuis/t3code",
                  },
                  headRepositoryOwner: {
                    login: "lnieuwenhuis",
                  },
                },
              ]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 188,
                  title: "Add stacked git actions",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/188",
                  baseRefName: "main",
                  headRefName: "feature/no-fork-match",
                  state: "OPEN",
                  isCrossRepository: false,
                },
              ]),
            ],
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("created");
        expect(result.pr.number).toBe(188);
        expect(result.toast).toEqual({
          title: "Created PR #188",
          description: "Add stacked git actions",
          cta: {
            kind: "open_pr",
            label: "View PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/188",
          },
        });
        expect(
          ghCalls.some((call) =>
            call.includes("pr create --base main --head feature/no-fork-match"),
          ),
        ).toBe(true);
      }),
  );

  it.effect("creates cross-repo PRs with the fork owner selector and default base branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
      fs.writeFileSync(path.join(repoDir, "changes.txt"), "change\n");
      yield* runGit(repoDir, ["add", "changes.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
      yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-91/statemachine"]);
      yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/statemachine"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork-seed",
        "git@github.com:octocat/codething-mvp.git",
        forkDir,
      );

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequenceByHeadSelector: {
            "octocat:statemachine": [
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([]),
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              JSON.stringify([
                {
                  number: 188,
                  title: "Add stacked git actions",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/188",
                  baseRefName: "main",
                  headRefName: "statemachine",
                  state: "OPEN",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "octocat/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "octocat",
                  },
                },
              ]),
            ],
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "fork-seed:statemachine": [JSON.stringify([])],
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            statemachine: [JSON.stringify([])],
          },
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(result.pr.number).toBe(188);
      expect(
        ghCalls.some((call) => call.includes("pr create --base main --head octocat:statemachine")),
      ).toBe(true);
      expect(
        ghCalls.some((call) =>
          call.includes("pr create --base statemachine --head octocat:statemachine"),
        ),
      ).toBe(false);
    }),
  );

  it.effect("rejects push/pr actions from detached HEAD", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "--detach", "HEAD"]);

      const { manager } = yield* makeManager();
      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
      expect(errorMessage).toContain("detached HEAD");
    }),
  );

  it.effect("surfaces missing gh binary errors", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/gh-missing"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/gh-missing"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCliError({
            operation: "execute",
            detail: "GitHub CLI (`gh`) is required but not available on PATH.",
          }),
        },
      });

      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
      expect(errorMessage).toContain("GitHub CLI (`gh`) is required");
    }),
  );

  it.effect("surfaces gh auth errors with guidance", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/gh-auth"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/gh-auth"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCliError({
            operation: "execute",
            detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
          }),
        },
      });

      const errorMessage = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit_push_pr",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );
      expect(errorMessage).toContain("gh auth login");
    }),
  );

  it.effect("resolves pull requests from #number references", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 42,
            title: "Resolve PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/42",
            baseRefName: "main",
            headRefName: "feature/resolve-pr",
            state: "open",
          },
        },
      });

      const result = yield* resolvePullRequest(manager, {
        cwd: repoDir,
        reference: "#42",
      });

      expect(result.pullRequest).toEqual({
        number: 42,
        title: "Resolve PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/resolve-pr",
        state: "open",
      });
      expect(ghCalls.some((call) => call.startsWith("pr view 42 "))).toBe(true);
    }),
  );

  it.effect("prepares pull request threads in local mode by checking out the PR branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local"]);
      fs.writeFileSync(path.join(repoDir, "local.txt"), "local\n");
      yield* runGit(repoDir, ["add", "local.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local PR branch"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 64,
            title: "Local PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/64",
            baseRefName: "main",
            headRefName: "feature/pr-local",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "#64",
        mode: "local",
      });

      expect(result.branch).toBe("feature/pr-local");
      expect(result.worktreePath).toBeNull();
      const branch = (yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim();
      expect(branch).toBe("feature/pr-local");
      expect(ghCalls).toContain("pr checkout 64 --force");
    }),
  );

  it.effect(
    "restores same-repository upstream tracking after local PR checkout without a remote ref",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-upstream"]);
        fs.writeFileSync(path.join(repoDir, "upstream.txt"), "upstream\n");
        yield* runGit(repoDir, ["add", "upstream.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Local upstream PR branch"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-local-upstream"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "feature/pr-local-upstream"]);
        yield* runGit(repoDir, [
          "update-ref",
          "-d",
          "refs/remotes/origin/feature/pr-local-upstream",
        ]);

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 65,
              title: "Local upstream PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/65",
              baseRefName: "main",
              headRefName: "feature/pr-local-upstream",
              state: "open",
              isCrossRepository: false,
              headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
              headRepositoryOwnerLogin: "pingdotgg",
            },
            repositoryCloneUrls: {
              "pingdotgg/codething-mvp": {
                url: remoteDir,
                sshUrl: remoteDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "65",
          mode: "local",
        });

        expect(result.worktreePath).toBeNull();
        expect(result.branch).toBe("feature/pr-local-upstream");
        expect(
          (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
        ).toBe("origin/feature/pr-local-upstream");
      }),
  );

  it.effect(
    "restores same-repository upstream tracking when provider omits head repository metadata",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-no-head-repo"]);
        fs.writeFileSync(path.join(repoDir, "no-head-repo.txt"), "upstream\n");
        yield* runGit(repoDir, ["add", "no-head-repo.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Local PR branch without repo metadata"]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-local-no-head-repo"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "feature/pr-local-no-head-repo"]);
        yield* runGit(repoDir, [
          "update-ref",
          "-d",
          "refs/remotes/origin/feature/pr-local-no-head-repo",
        ]);

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 66,
              title: "Local upstream PR without repo metadata",
              url: "https://github.com/pingdotgg/codething-mvp/pull/66",
              baseRefName: "main",
              headRefName: "feature/pr-local-no-head-repo",
              state: "open",
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "66",
          mode: "local",
        });

        expect(result.worktreePath).toBeNull();
        expect(result.branch).toBe("feature/pr-local-no-head-repo");
        expect(
          (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
        ).toBe("origin/feature/pr-local-no-head-repo");
      }),
  );

  it.effect("prepares pull request threads in worktree mode on the PR head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-worktree"]);
      fs.writeFileSync(path.join(repoDir, "worktree.txt"), "worktree\n");
      yield* runGit(repoDir, ["add", "worktree.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR worktree branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-worktree"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/77/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 77,
            title: "Worktree PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/77",
            baseRefName: "main",
            headRefName: "feature/pr-worktree",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "77",
        mode: "worktree",
      });

      expect(result.branch).toBe("feature/pr-worktree");
      expect(result.worktreePath).not.toBeNull();
      expect(fs.existsSync(result.worktreePath as string)).toBe(true);
      const worktreeBranch = (yield* runGit(result.worktreePath as string, [
        "branch",
        "--show-current",
      ])).stdout.trim();
      expect(worktreeBranch).toBe("feature/pr-worktree");
    }),
  );

  it.effect("launches setup only when creating a new PR worktree", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-worktree-setup"]);
      fs.writeFileSync(path.join(repoDir, "setup.txt"), "setup\n");
      yield* runGit(repoDir, ["add", "setup.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR worktree setup branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-worktree-setup"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/177/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const setupCalls: ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 177,
            title: "Worktree setup PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/177",
            baseRefName: "main",
            headRefName: "feature/pr-worktree-setup",
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

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "177",
        mode: "worktree",
        threadId: asThreadId("thread-pr-setup"),
      });

      expect(result.worktreePath).not.toBeNull();
      expect(setupCalls).toHaveLength(1);
      expect(setupCalls[0]).toEqual({
        threadId: "thread-pr-setup",
        projectCwd: repoDir,
        worktreePath: result.worktreePath as string,
      });
    }),
  );

  it.effect("preserves fork upstream tracking when preparing a worktree PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-fork"]);
      fs.writeFileSync(path.join(repoDir, "fork.txt"), "fork\n");
      yield* runGit(repoDir, ["add", "fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 81,
            title: "Fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/81",
            baseRefName: "main",
            headRefName: "feature/pr-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/codething-mvp",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/codething-mvp": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "81",
        mode: "worktree",
      });

      expect(result.worktreePath).not.toBeNull();
      const upstreamRef = (yield* runGit(result.worktreePath as string, [
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      ])).stdout.trim();
      expect(upstreamRef).toBe("fork-seed/feature/pr-fork");
      expect(upstreamRef.startsWith("origin/")).toBe(false);
      expect(
        (yield* runGit(result.worktreePath as string, [
          "config",
          "--get",
          "remote.fork-seed.url",
        ])).stdout.trim(),
      ).toBe(forkDir);
    }),
  );

  it.effect("preserves fork upstream tracking when preparing a local PR thread", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-fork"]);
      fs.writeFileSync(path.join(repoDir, "local-fork.txt"), "local fork\n");
      yield* runGit(repoDir, ["add", "local-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-local-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/pr-local-fork"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 82,
            title: "Local Fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/82",
            baseRefName: "main",
            headRefName: "feature/pr-local-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/codething-mvp",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/codething-mvp": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "82",
        mode: "local",
      });

      expect(result.worktreePath).toBeNull();
      expect(result.branch).toBe("feature/pr-local-fork");
      expect(
        (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("fork-seed/feature/pr-local-fork");
    }),
  );

  it.effect("derives fork repository identity from PR URL when GitHub omits nameWithOwner", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "binbandit-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "fix/git-action-default-without-origin"]);
      fs.writeFileSync(path.join(repoDir, "derived-fork.txt"), "derived fork\n");
      yield* runGit(repoDir, ["add", "derived-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Derived fork PR branch"]);
      yield* runGit(repoDir, [
        "push",
        "-u",
        "binbandit-seed",
        "fix/git-action-default-without-origin",
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "fix/git-action-default-without-origin"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 642,
            title: "fix: use commit as the default git action without origin",
            url: "https://github.com/pingdotgg/t3code/pull/642",
            baseRefName: "main",
            headRefName: "fix/git-action-default-without-origin",
            state: "open",
            isCrossRepository: true,
            headRepositoryOwnerLogin: "binbandit",
          },
          repositoryCloneUrls: {
            "binbandit/t3code": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "642",
        mode: "local",
      });

      expect(result.branch).toBe("fix/git-action-default-without-origin");
      expect(result.worktreePath).toBeNull();
      expect(
        (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("binbandit-seed/fix/git-action-default-without-origin");
    }),
  );

  it.effect("reuses an existing dedicated worktree for the PR head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-existing-worktree"]);
      fs.writeFileSync(path.join(repoDir, "existing.txt"), "existing\n");
      yield* runGit(repoDir, ["add", "existing.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Existing worktree branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-existing-${path.basename(repoDir)}`);
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-existing-worktree"]);

      const setupCalls: ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 78,
            title: "Existing worktree PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/78",
            baseRefName: "main",
            headRefName: "feature/pr-existing-worktree",
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

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "78",
        mode: "worktree",
        threadId: asThreadId("thread-pr-existing-worktree"),
      });

      expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
        fs.realpathSync.native(worktreePath),
      );
      expect(result.branch).toBe("feature/pr-existing-worktree");
      expect(setupCalls).toHaveLength(0);
    }),
  );

  it.effect(
    "does not block fork PR worktree prep when the fork head branch collides with root main",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "fork-main-source"]);
        fs.writeFileSync(path.join(repoDir, "fork-main.txt"), "fork main\n");
        yield* runGit(repoDir, ["add", "fork-main.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork main branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-source:main"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const mainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 91,
              title: "Fork main PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/91",
              baseRefName: "main",
              headRefName: "main",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/codething-mvp",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/codething-mvp": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "worktree",
        });

        expect(result.branch).toBe("t3code/pr-91/main");
        expect(result.worktreePath).not.toBeNull();
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
        expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(mainBefore);
        expect(
          (yield* runGit(result.worktreePath as string, [
            "branch",
            "--show-current",
          ])).stdout.trim(),
        ).toBe("t3code/pr-91/main");
      }),
  );

  it.effect(
    "does not overwrite an existing local main branch when preparing a fork PR worktree",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["checkout", "-b", "fork-main-source"]);
        fs.writeFileSync(path.join(repoDir, "fork-main-second.txt"), "fork main second\n");
        yield* runGit(repoDir, ["add", "fork-main-second.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork main second branch"]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-source:main"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        const localMainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "-b", "feature/root-branch"]);

        const { manager } = yield* makeManager({
          ghScenario: {
            pullRequest: {
              number: 92,
              title: "Fork main overwrite PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/92",
              baseRefName: "main",
              headRefName: "main",
              state: "open",
              isCrossRepository: true,
              headRepositoryNameWithOwner: "octocat/codething-mvp",
              headRepositoryOwnerLogin: "octocat",
            },
            repositoryCloneUrls: {
              "octocat/codething-mvp": {
                url: forkDir,
                sshUrl: forkDir,
              },
            },
          },
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "92",
          mode: "worktree",
        });

        expect(result.branch).toBe("t3code/pr-92/main");
        expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(localMainBefore);
        expect(
          (yield* runGit(result.worktreePath as string, [
            "rev-parse",
            "--abbrev-ref",
            "@{upstream}",
          ])).stdout.trim(),
        ).toBe("fork-seed/main");
      }),
  );

  it.effect("reuses an existing PR worktree and restores fork upstream tracking", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-fork"]);
      fs.writeFileSync(path.join(repoDir, "reused-fork.txt"), "reused fork\n");
      yield* runGit(repoDir, ["add", "reused-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-reused-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = path.join(repoDir, "..", `pr-reused-fork-${path.basename(repoDir)}`);
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-reused-fork"]);
      yield* runGit(worktreePath, ["branch", "--unset-upstream"], true);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 83,
            title: "Reused Fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/83",
            baseRefName: "main",
            headRefName: "feature/pr-reused-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/codething-mvp",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/codething-mvp": {
              url: forkDir,
              sshUrl: forkDir,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "83",
        mode: "worktree",
      });

      expect(result.worktreePath && fs.realpathSync.native(result.worktreePath)).toBe(
        fs.realpathSync.native(worktreePath),
      );
      expect(
        (yield* runGit(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim(),
      ).toBe("fork-seed/feature/pr-reused-fork");
    }),
  );

  it.effect("does not fail PR worktree prep when setup terminal startup fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-setup-failure"]);
      fs.writeFileSync(path.join(repoDir, "setup-failure.txt"), "setup failure\n");
      yield* runGit(repoDir, ["add", "setup-failure.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR setup failure branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-setup-failure"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/184/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 184,
            title: "Setup failure PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/184",
            baseRefName: "main",
            headRefName: "feature/pr-setup-failure",
            state: "open",
          },
        },
        setupScriptRunner: {
          runForThread: () =>
            Effect.fail(new ProjectSetupScriptRunnerError({ message: "terminal start failed" })),
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "184",
        mode: "worktree",
        threadId: asThreadId("thread-pr-setup-failure"),
      });

      expect(result.branch).toBe("feature/pr-setup-failure");
      expect(result.worktreePath).not.toBeNull();
      expect(fs.existsSync(result.worktreePath as string)).toBe(true);
    }),
  );

  it.effect("rejects worktree prep when the PR head branch is checked out in the main repo", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-root-only"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 79,
            title: "Root-only PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/79",
            baseRefName: "main",
            headRefName: "feature/pr-root-only",
            state: "open",
          },
        },
      });

      const errorMessage = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "79",
        mode: "worktree",
      }).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("already checked out in the main repo");
    }),
  );

  it.effect("emits ordered progress events for commit hooks", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "hooked.txt"), "hooked\n");
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        '#!/bin/sh\necho "hook: start" >&2\nsleep 0.05\necho "hook: end" >&2\n',
        { mode: 0o755 },
      );

      const { manager } = yield* makeManager();
      const events: GitActionProgressEvent[] = [];

      const result = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "commit",
        },
        {
          actionId: "action-1",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      );

      expect(result.commit.status).toBe("created");
      expect(events.map((event) => event.kind)).toContain("action_started");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "phase_started",
            phase: "commit",
          }),
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: start",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: end",
          }),
          expect.objectContaining({
            kind: "hook_finished",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "action_finished",
          }),
        ]),
      );
    }),
  );

  it.effect("emits action_failed when a commit hook rejects", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      fs.writeFileSync(path.join(repoDir, "hook-failure.txt"), "broken\n");
      fs.writeFileSync(
        path.join(repoDir, ".git", "hooks", "pre-commit"),
        '#!/bin/sh\necho "hook: fail" >&2\nexit 1\n',
        { mode: 0o755 },
      );

      const { manager } = yield* makeManager();
      const events: GitActionProgressEvent[] = [];

      const errorMessage = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "commit",
        },
        {
          actionId: "action-2",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      ).pipe(
        Effect.flip,
        Effect.map((error) => error.message),
      );

      expect(errorMessage).toContain("hook: fail");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "action_failed",
            phase: "commit",
          }),
        ]),
      );
    }),
  );

  it.effect("create_pr emits only the PR phase when the branch is already pushed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-only-follow-up"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      fs.writeFileSync(path.join(repoDir, "pr-only.txt"), "pr only\n");
      yield* runGit(repoDir, ["add", "pr-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR only branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-only-follow-up"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([]),
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 201,
                title: "PR only branch",
                url: "https://github.com/pingdotgg/codething-mvp/pull/201",
                baseRefName: "main",
                headRefName: "feature/pr-only-follow-up",
                state: "OPEN",
                isCrossRepository: false,
              },
            ]),
          ],
        },
      });
      const events: GitActionProgressEvent[] = [];

      const result = yield* runStackedAction(
        manager,
        {
          cwd: repoDir,
          action: "create_pr",
        },
        {
          actionId: "action-pr-only",
          progressReporter: {
            publish: (event) =>
              Effect.sync(() => {
                events.push(event);
              }),
          },
        },
      );

      expect(result.commit.status).toBe("skipped_not_requested");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("created");
      expect(
        events.filter(
          (event): event is Extract<GitActionProgressEvent, { kind: "phase_started" }> =>
            event.kind === "phase_started",
        ),
      ).toEqual([
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Preparing PR...",
        }),
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Generating PR content...",
        }),
        expect.objectContaining({
          kind: "phase_started",
          phase: "pr",
          label: "Creating pull request...",
        }),
      ]);
    }),
  );
});
