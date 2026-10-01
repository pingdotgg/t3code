// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
import { expect } from "vite-plus/test";
import type {
  GitActionProgressEvent,
  GitPreparePullRequestThreadInput,
  ThreadId,
} from "@t3tools/contracts";

import {
  DEFAULT_SERVER_SETTINGS,
  GitCommandError,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  VcsProcessExitError,
} from "@t3tools/contracts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitLabCli from "../sourceControl/GitLabCli.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubSourceControlProvider from "../sourceControl/GitHubSourceControlProvider.ts";
import * as GitLabSourceControlProvider from "../sourceControl/GitLabSourceControlProvider.ts";
import {
  ForgejoPullRequestSchema,
  toForgejoChangeRequest,
} from "../sourceControl/forgejoPullRequests.ts";
import type { SourceControlProvider } from "../sourceControl/SourceControlProvider.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitManager from "./GitManager.ts";

const encodeCliJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeForgejoPullRequest = Schema.decodeEffect(ForgejoPullRequestSchema);

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
    isDraft?: boolean;
    isCrossRepository?: boolean;
    headRepositoryNameWithOwner?: string | null;
    headRepositoryOwnerLogin?: string | null;
  };
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
  failWith?: GitHubCli.GitHubCliError;
  /** Let this many gh calls succeed before failWith kicks in (default 0 = fail immediately). */
  failAfterCalls?: number;
  /**
   * Mirror gh 2.94's `pr checkout` against origin's `refs/pull/<n>/head`: `--force` hard-resets
   * the branch onto the pull head, otherwise gh only fast-forwards it.
   */
  syncCheckoutWithPullHead?: boolean;
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

type FakeGitTextGeneration = TextGeneration.TextGeneration["Service"];

type FakePullRequest = NonNullable<FakeGhScenario["pullRequest"]>;

function normalizeFakePullRequestSummary(raw: unknown): GitHubCli.GitHubPullRequestSummary | null {
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
  const isDraft = typeof record.isDraft === "boolean" ? record.isDraft : undefined;
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
    ...(isDraft === true ? { isDraft: true } : {}),
    ...(isCrossRepository !== undefined ? { isCrossRepository } : {}),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function runGitSyncForFakeGh(cwd: string, args: readonly string[]): void {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  throw new Error(
    `Failed to simulate gh checkout with git ${args.join(" ")}: ${result.stderr?.trim() || "unknown error"}`,
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
    yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "hello\n");
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

const PULL_REQUEST_REPOSITORY_URL = "https://github.com/pingdotgg/codething-mvp.git";

// What the fake provider reports as the clone URLs of the pull requests' repository.
const pullRequestRepositoryCloneUrls = {
  "pingdotgg/codething-mvp": {
    url: PULL_REQUEST_REPOSITORY_URL,
    sshUrl: "git@github.com:pingdotgg/codething-mvp.git",
  },
};

// Points the provider-reported repository URL at a local bare repository, as a user's own
// `insteadOf` rewrite would, without touching any remote.
function servePullRequestRepository(
  cwd: string,
  localRemotePath: string,
  url = PULL_REQUEST_REPOSITORY_URL,
) {
  return runGit(cwd, ["config", "--add", `url.${localRemotePath}.insteadOf`, url]).pipe(
    Effect.asVoid,
  );
}

function createTextGeneration(
  overrides: Partial<FakeGitTextGeneration> = {},
): TextGeneration.TextGeneration["Service"] {
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
  service: GitHubCli.GitHubCli["Service"];
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

  const execute: GitHubCli.GitHubCli["Service"]["execute"] = (input) => {
    const args = [...input.args];
    ghCalls.push(args.join(" "));

    if (scenario.failWith && ghCalls.length > (scenario.failAfterCalls ?? 0)) {
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
          if (headBranch && scenario.syncCheckoutWithPullHead) {
            const force = args.includes("--force");
            runGitSyncForFakeGh(input.cwd, [
              "fetch",
              "origin",
              `refs/pull/${scenario.pullRequest?.number}/head`,
            ]);
            const current = NodeChildProcess.spawnSync("git", ["branch", "--show-current"], {
              cwd: input.cwd,
              encoding: "utf8",
            }).stdout.trim();
            const exists =
              NodeChildProcess.spawnSync(
                "git",
                ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
                { cwd: input.cwd },
              ).status === 0;
            if (!exists) {
              runGitSyncForFakeGh(input.cwd, ["checkout", "-b", headBranch, "FETCH_HEAD"]);
            } else {
              if (current !== headBranch) {
                runGitSyncForFakeGh(input.cwd, [
                  "checkout",
                  ...(force ? ["--force"] : []),
                  headBranch,
                ]);
              }
              runGitSyncForFakeGh(
                input.cwd,
                force ? ["reset", "--hard", "FETCH_HEAD"] : ["merge", "--ff-only", "FETCH_HEAD"],
              );
            }
          } else if (headBranch) {
            const existingBranch = NodeChildProcess.spawnSync(
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
          GitHubCli.isGitHubCliError(error)
            ? error
            : new GitHubCli.GitHubCliCommandError({
                command: "gh",
                cwd: input.cwd,
                cause: error,
              }),
      });
    }

    if (args[0] === "repo" && args[1] === "view") {
      const repository = args[2];
      if (typeof repository === "string" && args.includes("nameWithOwner,url,sshUrl")) {
        const cloneUrls = scenario.repositoryCloneUrls?.[repository];
        if (!cloneUrls) {
          return Effect.fail(
            new GitHubCli.GitHubCliCommandError({
              command: "gh",
              cwd: input.cwd,
              cause: new Error(`Unexpected repository lookup: ${repository}`),
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
      new GitHubCli.GitHubCliCommandError({
        command: "gh",
        cwd: input.cwd,
        cause: new Error(`Unexpected gh command: ${args.join(" ")}`),
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
            "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(
          Effect.map((result) => JSON.parse(result.stdout) as unknown[]),
          Effect.map((raw) =>
            raw
              .map((entry) => normalizeFakePullRequestSummary(entry))
              .filter((entry): entry is GitHubCli.GitHubPullRequestSummary => entry !== null),
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
            "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(
          Effect.map((result) => JSON.parse(result.stdout) as GitHubCli.GitHubPullRequestSummary),
        ),
      getRepositoryCloneUrls: (input) =>
        execute({
          cwd: input.cwd,
          args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout))),
      createRepository: (input) =>
        Effect.fail(
          new GitHubCli.GitHubCliCommandError({
            command: "gh",
            cwd: input.cwd,
            cause: new Error(`Unexpected repository create: ${input.repository}`),
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
  manager: GitManager.GitManager["Service"],
  input: {
    cwd: string;
    action: "commit" | "push" | "create_pr" | "commit_push" | "commit_push_pr";
    actionId?: string;
    commitMessage?: string;
    featureBranch?: boolean;
    filePaths?: readonly string[];
  },
  options?: Parameters<GitManager.GitManager["Service"]["runStackedAction"]>[1],
) {
  return manager.runStackedAction(
    {
      ...input,
      actionId: input.actionId ?? "test-action-id",
    },
    options,
  );
}

function resolvePullRequest(
  manager: GitManager.GitManager["Service"],
  input: { cwd: string; reference: string },
) {
  return manager.resolvePullRequest(input);
}

function preparePullRequestThread(
  manager: GitManager.GitManager["Service"],
  input: GitPreparePullRequestThreadInput,
) {
  return manager.preparePullRequestThread(input);
}

function makeManager(input?: {
  ghScenario?: FakeGhScenario;
  sourceControlProvider?: SourceControlProvider["Service"];
  textGeneration?: Partial<FakeGitTextGeneration>;
  serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  setupScriptRunner?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  gitConfigReads?: string[];
}) {
  const { service: gitHubCli, ghCalls } = createGitHubCliWithFakeGh(input?.ghScenario);
  const textGeneration = createTextGeneration(input?.textGeneration);
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-git-manager-test-",
  });

  const serverSettingsLayer = ServerSettings.ServerSettingsService.layerTest(input?.serverSettings);

  const vcsDriverLayer = input?.gitConfigReads
    ? Layer.effect(
        GitVcsDriver.GitVcsDriver,
        GitVcsDriver.make.pipe(
          Effect.map((service) =>
            GitVcsDriver.GitVcsDriver.of({
              ...service,
              readConfigValue: (cwd, key) =>
                Effect.sync(() => input.gitConfigReads?.push(key)).pipe(
                  Effect.andThen(service.readConfigValue(cwd, key)),
                ),
            }),
          ),
        ),
      ).pipe(
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(serverConfigLayer),
      )
    : GitVcsDriver.layer.pipe(
        Layer.provideMerge(VcsProcess.layer),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(serverConfigLayer),
      );
  const sourceControlRegistryLayer = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    (input?.sourceControlProvider === undefined
      ? GitHubSourceControlProvider.make
      : Effect.succeed(input.sourceControlProvider)
    ).pipe(
      Effect.map((provider) =>
        SourceControlProviderRegistry.SourceControlProviderRegistry.of({
          repositoryHosts: () => Effect.succeed([]),
          resolveLink: (input) => provider.resolveLink?.(input),
          get: () => Effect.succeed(provider),
          resolveHandle: () => Effect.succeed({ provider, context: null }),
          resolve: () => Effect.succeed(provider),
          discover: Effect.succeed([]),
        }),
      ),
      Effect.provide(Layer.succeed(GitHubCli.GitHubCli, gitHubCli)),
    ),
  );

  const managerLayer = Layer.mergeAll(
    Layer.succeed(TextGeneration.TextGeneration, textGeneration),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([]),
    }),
    Layer.succeed(
      ProjectSetupScriptRunner.ProjectSetupScriptRunner,
      input?.setupScriptRunner ?? {
        runForThread: () => Effect.succeed({ status: "no-script" as const }),
      },
    ),
    vcsDriverLayer,
    serverSettingsLayer,
  ).pipe(Layer.provideMerge(sourceControlRegistryLayer), Layer.provideMerge(NodeServices.layer));

  return GitManager.make.pipe(
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
  it.effect("status includes draft PR metadata when branch already has a draft PR", () =>
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
                isDraft: true,
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
        isDraft: true,
        updatedAt: null,
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
        updatedAt: null,
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
        updatedAt: null,
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
        updatedAt: "2026-01-02T00:00:00.000Z",
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
      const cwd = NodePath.join(rootDir, "deleted-repo");
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

  it.effect("a warm PR cache does not reread repository identity for status", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-identity-cache"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-identity-cache"]);

      const gitConfigReads: string[] = [];
      const { manager } = yield* makeManager({ gitConfigReads });

      yield* manager.remoteStatus({ cwd: repoDir }, { refreshUpstream: false });
      gitConfigReads.length = 0;
      yield* manager.remoteStatus({ cwd: repoDir }, { refreshUpstream: false });

      const identityReads = gitConfigReads.filter(
        (key) =>
          key === "branch.feature/status-identity-cache.remote" || key === "remote.origin.url",
      );
      expect(identityReads).toHaveLength(0);
    }),
  );

  it.effect("turn-end refresh finds a new PR and keeps known PRs cached", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/turn-refresh", "origin/main"]);
      yield* runGit(repoDir, ["push", "origin", "feature/turn-refresh"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            "[]",
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 114,
                title: "Opened during the turn",
                url: "https://github.com/pingdotgg/codething-mvp/pull/114",
                baseRefName: "main",
                headRefName: "feature/turn-refresh",
              },
            ]),
          ],
        },
      });
      expect((yield* manager.remoteStatus({ cwd: repoDir }))?.pr).toBeNull();
      expect(
        (yield* manager.remoteStatus({ cwd: repoDir }, { refreshUpstream: false }))?.pr,
      ).toBeNull();

      const refreshed = yield* manager.remoteStatus(
        { cwd: repoDir },
        { refreshUpstream: false, refreshMissingPullRequest: true },
      );
      expect(refreshed?.pr?.number).toBe(114);
      yield* manager.remoteStatus(
        { cwd: repoDir },
        { refreshUpstream: false, refreshMissingPullRequest: true },
      );
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);
    }),
  );

  it.effect("turn-end refresh preserves failed PR lookup backoff", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/rate-limited"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/rate-limited"]);
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
        },
      });
      yield* manager.remoteStatus({ cwd: repoDir });
      const callsAfterFailure = ghCalls.length;
      yield* manager.remoteStatus(
        { cwd: repoDir },
        { refreshUpstream: false, refreshMissingPullRequest: true },
      );
      expect(callsAfterFailure).toBeGreaterThan(0);
      expect(ghCalls).toHaveLength(callsAfterFailure);
    }),
  );

  it.effect("status skips the provider lookup for a branch that was never pushed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/never-pushed"]);

      const { manager, ghCalls } = yield* makeManager();

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.refName).toBe("feature/never-pushed");
      expect(status.pr).toBeNull();
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(0);
    }),
  );

  it.effect("branch PR lookup returns null when the repository has no remotes", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const { manager, ghCalls } = yield* makeManager();

      const pullRequest = yield* manager.branchPullRequest({ cwd: repoDir, branch: "main" });

      expect(pullRequest).toBeNull();
      expect(ghCalls).toHaveLength(0);
    }),
  );

  it.effect("branch PR lookup uses a saved tracked branch without changing checkout", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/saved-branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/saved-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 216,
                title: "Saved branch PR",
                url: "https://github.com/pingdotgg/t3code/pull/216",
                baseRefName: "main",
                headRefName: "feature/saved-branch",
                state: "OPEN",
                updatedAt: "2026-04-03T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/saved-branch",
      });

      expect(pullRequest).toMatchObject({
        number: 216,
        title: "Saved branch PR",
        url: "https://github.com/pingdotgg/t3code/pull/216",
        baseRef: "main",
        headRef: "feature/saved-branch",
        state: "open",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-03T15:00:00.000Z",
      });
      expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
    }),
  );

  it.effect("branch PR lookup uses the default branch from a non-origin remote", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "upstream", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "develop"]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "develop"]);
      yield* runGit(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
      yield* runGit(repoDir, ["remote", "set-head", "upstream", "develop"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 221,
                title: "Merged main PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/221",
                baseRefName: "develop",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2026-04-07T15:00:00Z",
                updatedAt: "2026-04-08T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({ cwd: repoDir, branch: "main" });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: "2026-04-07T15:00:00Z",
        updatedAt: "2026-04-08T15:00:00.000Z",
      });
    }),
  );

  it.effect("branch PR lookup uses the saved name after the local branch is deleted", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/deleted-local-branch"]);
      yield* runGit(repoDir, ["branch", "feature/deleted-local-branch/child"]);
      yield* runGit(repoDir, [
        "branch",
        "--set-upstream-to",
        "origin/main",
        "feature/deleted-local-branch/child",
      ]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 217,
                title: "Deleted local branch PR",
                url: "https://github.com/pingdotgg/t3code/pull/217",
                baseRefName: "main",
                headRefName: "feature/deleted-local-branch",
                state: "MERGED",
                updatedAt: "2026-04-04T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/deleted-local-branch",
      });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-04T15:00:00.000Z",
      });
      expect(ghCalls.some((call) => call.includes("--head feature/deleted-local-branch"))).toBe(
        true,
      );
    }),
  );

  it.effect("branch PR lookup recovers a deleted fork branch from its remote-tracking ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* configureRemote(repoDir, "team/fork", forkDir, "team/fork");
      yield* runGit(repoDir, ["checkout", "-b", "feature/deleted-fork-branch"]);
      yield* runGit(repoDir, ["push", "-u", "team/fork", "feature/deleted-fork-branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/deleted-fork-branch"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "team/fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "feature/deleted-fork-branch": JSON.stringify([
              {
                number: 218,
                title: "Deleted fork branch PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/218",
                baseRefName: "main",
                headRefName: "feature/deleted-fork-branch",
                state: "MERGED",
                updatedAt: "2026-04-05T15:00:00Z",
                isCrossRepository: true,
                headRepository: { nameWithOwner: "contributor/codething-mvp" },
                headRepositoryOwner: { login: "contributor" },
              },
            ]),
          },
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/deleted-fork-branch",
      });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-04-05T15:00:00.000Z",
      });
      expect(
        ghCalls.some((call) => call.includes("--head feature/deleted-fork-branch --state all")),
      ).toBe(true);
      expect(ghCalls.some((call) => call.includes("--head contributor:"))).toBe(false);
    }),
  );

  it.effect("branch PR lookup rejects ambiguous deleted-branch remote refs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["push", "origin", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["push", "fork", "feature/ambiguous-remote"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/ambiguous-remote"]);
      const { manager, ghCalls } = yield* makeManager();

      const error = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/ambiguous-remote" })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        detail: "Multiple remotes track feature/ambiguous-remote. Its pull request is ambiguous.",
      });
      expect(ghCalls).toHaveLength(0);
    }),
  );

  it.effect("branch PR lookup does not reuse a cached PR after the remote is repointed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originalRemoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originalRemoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/repointed-lookup"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/repointed-lookup"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:old-owner/old-repository.git",
        originalRemoteDir,
      );
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 219,
                title: "Old repository PR",
                url: "https://github.com/old-owner/old-repository/pull/219",
                baseRefName: "main",
                headRefName: "feature/repointed-lookup",
                state: "MERGED",
                updatedAt: "2026-04-06T15:00:00Z",
              },
            ]),
            "[]",
          ],
        },
      });

      const first = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/repointed-lookup",
      });
      expect(first?.state).toBe("merged");

      const replacementRemoteDir = yield* createBareRemote();
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:new-owner/new-repository.git",
        replacementRemoteDir,
      );

      const second = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/repointed-lookup",
      });

      expect(second).toBeNull();
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);
    }),
  );

  it.effect("branch PR lookup shares the status cache for the same repository identity", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/shared-pr-cache"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/shared-pr-cache"]);
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 220,
                title: "Shared cache PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/220",
                baseRefName: "main",
                headRefName: "feature/shared-pr-cache",
                state: "MERGED",
                updatedAt: "2026-04-07T15:00:00Z",
              },
            ]),
            encodeCliJson([
              {
                number: 221,
                title: "New PR on the same branch",
                url: "https://github.com/pingdotgg/codething-mvp/pull/221",
                baseRefName: "main",
                headRefName: "feature/shared-pr-cache",
                state: "OPEN",
                updatedAt: "2026-04-08T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/shared-pr-cache",
      });

      expect(status.pr?.state).toBe("merged");
      expect(pullRequest?.state).toBe("merged");
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
      const refreshed = yield* manager.branchPullRequest(
        { cwd: repoDir, branch: "feature/shared-pr-cache" },
        { refresh: true },
      );
      expect(refreshed).toMatchObject({
        number: 221,
        state: "open",
        repositoryKey: "github.com/pingdotgg/codething-mvp",
      });
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);
    }),
  );

  it.effect("branch PR lookup rechecks open PRs every minute and settled answers less often", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      for (const branch of ["feature/open-pr", "feature/merged-pr", "feature/no-pr"]) {
        yield* runGit(repoDir, ["checkout", "-b", branch, "main"]);
        yield* runGit(repoDir, ["push", "-u", "origin", branch]);
      }
      const pullRequest = (number: number, headRefName: string, state: string) => ({
        number,
        title: headRefName,
        url: `https://github.com/pingdotgg/codething-mvp/pull/${number}`,
        baseRefName: "main",
        headRefName,
        state,
        updatedAt: "2026-04-07T15:00:00Z",
      });
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            "feature/open-pr": encodeCliJson([pullRequest(301, "feature/open-pr", "OPEN")]),
            "feature/merged-pr": encodeCliJson([pullRequest(302, "feature/merged-pr", "MERGED")]),
          },
        },
      });
      const lookupAll = Effect.forEach(
        ["feature/open-pr", "feature/merged-pr", "feature/no-pr"],
        (branch) => manager.branchPullRequest({ cwd: repoDir, branch }),
      );
      const prListCalls = () => ghCalls.filter((call) => call.startsWith("pr list "));

      yield* lookupAll;
      expect(prListCalls()).toHaveLength(3);

      yield* TestClock.adjust("61 seconds");
      yield* lookupAll;
      expect(prListCalls()).toHaveLength(4);
      expect(prListCalls().at(-1)).toContain("--head feature/open-pr");

      // Just inside the 5-minute window only the open PR is asked again.
      yield* TestClock.adjust("238 seconds");
      yield* lookupAll;
      expect(prListCalls()).toHaveLength(5);
      expect(prListCalls().at(-1)).toContain("--head feature/open-pr");

      // Just past it the settled answers expire too.
      yield* TestClock.adjust("2 seconds");
      yield* lookupAll;
      expect(prListCalls()).toHaveLength(7);
      expect(prListCalls().slice(-2).join("\n")).not.toContain("--head feature/open-pr");
    }),
  );

  it.effect("branch PR lookup propagates provider failures", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/lookup-failure"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/lookup-failure"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("gh is not available on PATH"),
          }),
        },
      });

      const error = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/lookup-failure" })
        .pipe(Effect.flip);

      expect(error._tag).toBe("SourceControlProviderError");
      const refreshError = yield* manager
        .branchPullRequest({ cwd: repoDir, branch: "feature/lookup-failure" }, { refresh: true })
        .pipe(Effect.flip);
      expect(refreshError._tag).toBe("SourceControlProviderError");
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(1);
    }),
  );

  it.effect("status finds a merged PR after its remote branch was deleted", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/merged-branch-deleted"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/merged-branch-deleted"]);

      // GitHub commonly deletes a pull request's head branch after merge. Git
      // removes the remote-tracking ref, but preserves the local branch's
      // remote and merge configuration as evidence that it was published.
      yield* runGit(repoDir, ["push", "origin", "--delete", "feature/merged-branch-deleted"]);
      const configuredRemote = yield* runGit(repoDir, [
        "config",
        "--get",
        "branch.feature/merged-branch-deleted.remote",
      ]);
      const configuredMerge = yield* runGit(repoDir, [
        "config",
        "--get",
        "branch.feature/merged-branch-deleted.merge",
      ]);
      const trackingRef = yield* runGit(repoDir, [
        "for-each-ref",
        "--format=%(refname)",
        "refs/remotes/origin/feature/merged-branch-deleted",
      ]);
      expect(configuredRemote.stdout.trim()).toBe("origin");
      expect(configuredMerge.stdout.trim()).toBe("refs/heads/feature/merged-branch-deleted");
      expect(trackingRef.stdout.trim()).toBe("");

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 215,
                title: "Merged branch was deleted",
                url: "https://github.com/pingdotgg/t3code/pull/215",
                baseRefName: "main",
                headRefName: "feature/merged-branch-deleted",
                state: "MERGED",
                mergedAt: "2026-04-02T15:00:00Z",
                updatedAt: "2026-04-02T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.hasUpstream).toBe(false);
      expect(status.pr).toEqual({
        number: 215,
        title: "Merged branch was deleted",
        url: "https://github.com/pingdotgg/t3code/pull/215",
        baseRef: "main",
        headRef: "feature/merged-branch-deleted",
        state: "merged",
        updatedAt: "2026-04-02T15:00:00.000Z",
      });
      expect(ghCalls.filter((call) => call.startsWith("pr list ")).length).toBeGreaterThan(0);
    }),
  );

  it.effect("status still looks up PRs for a branch pushed without --set-upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pushed-no-upstream"]);
      // No `-u`, so the remote-tracking ref exists but branch.<name>.merge does
      // not. Most terminal and agent pushes land this way, and they can still
      // have a PR, so the skip must not trigger here.
      yield* runGit(repoDir, ["push", "origin", "feature/pushed-no-upstream"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 214,
                title: "Pushed without upstream",
                url: "https://github.com/pingdotgg/t3code/pull/214",
                baseRefName: "main",
                headRefName: "feature/pushed-no-upstream",
                state: "OPEN",
                updatedAt: "2026-04-01T15:00:00Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });

      expect(status.pr?.number).toBe(214);
      expect(ghCalls.filter((call) => call.startsWith("pr list ")).length).toBeGreaterThan(0);
    }),
  );

  it("backs off repeated PR lookup failures past the healthy refresh cadence", () => {
    expect(Duration.toMillis(GitManager.prLookupFailureTtl(1))).toBe(20_000);
    expect(Duration.toMillis(GitManager.prLookupFailureTtl(2))).toBe(40_000);
    // The point of the backoff: by the third retry a failing branch must not be
    // asking more often than a healthy one, which refreshes every 2 minutes.
    expect(Duration.toMillis(GitManager.prLookupFailureTtl(4))).toBeGreaterThan(120_000);
    expect(Duration.toMillis(GitManager.prLookupFailureTtl(20))).toBe(900_000);
  });

  it.each([
    [
      "https://github.example.com/team/repository/pull/42?tab=files",
      "github.example.com/team/repository",
    ],
    [
      "https://gitlab.example.com/group/subgroup/repository/-/merge_requests/42",
      "gitlab.example.com/group/subgroup/repository",
    ],
    ["https://bitbucket.org/team/repository/pull-requests/42", "bitbucket.org/team/repository"],
    [
      "https://dev.azure.com/org/project/_git/repository/pullrequest/42",
      "dev.azure.com/org/project/_git/repository",
    ],
    [
      "https://org.visualstudio.com/project/_git/repository/pullrequest/42",
      "org.visualstudio.com/project/_git/repository",
    ],
    [
      "https://gitlab.example/group/pull/123/repository/-/merge_requests/42",
      "gitlab.example/group/pull/123/repository",
    ],
    ["https://github.example.com/team/repository/issues/42", null],
  ] as const)("reads the repository from the returned PR URL %s", (url, expected) => {
    expect(GitManager.pullRequestRepositoryKey(url)).toBe(expected);
  });

  it.effect("distinguishes Enterprise forks with the same head branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature"]);
      yield* runGit(repoDir, ["push", "-u", "fork", "feature"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.example.com:team/repository.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.example.com:alice/repository.git",
        forkDir,
      );
      const output = encodeCliJson([
        {
          number: 2,
          title: "Another fork",
          url: "https://github.example.com/team/repository/pull/2",
          baseRefName: "main",
          headRefName: "feature",
          state: "OPEN",
          updatedAt: "2026-04-08T15:00:00Z",
          isCrossRepository: true,
          headRepository: { nameWithOwner: "bob/repository" },
          headRepositoryOwner: { login: "bob" },
        },
        {
          number: 1,
          title: "This fork",
          url: "https://github.example.com/team/repository/pull/1",
          baseRefName: "main",
          headRefName: "feature",
          state: "OPEN",
          updatedAt: "2026-04-07T15:00:00Z",
          isCrossRepository: true,
          headRepository: { nameWithOwner: "alice/repository" },
          headRepositoryOwner: { login: "alice" },
        },
      ]);
      const { manager } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            feature: output,
          },
        },
      });
      expect(yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature" })).toMatchObject({
        number: 1,
        repositoryKey: "github.example.com/team/repository",
      });
    }),
  );

  it.effect.each([
    "git@gitlab.com:Group/Subgroup/Fork.git",
    "https://gitlab.com/Group/Subgroup/Fork.git",
  ])("matches nested GitLab forks through the adapter for %s", (remoteUrl) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      const branch = "feature/NestedGroups";
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", branch]);
      yield* runGit(repoDir, ["push", "-u", "fork", branch]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@gitlab.com:Group/Upstream/Repository.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(repoDir, "fork", remoteUrl, forkDir);
      const output = encodeCliJson([
        {
          iid: 2,
          title: "Another subgroup's fork",
          web_url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/2",
          target_branch: "main",
          source_branch: branch,
          state: "opened",
          updated_at: "2026-04-08T15:00:00Z",
          source_project_id: 102,
          target_project_id: 100,
          source_project: { path_with_namespace: "Group/Other/Fork" },
        },
        {
          iid: 1,
          title: "This subgroup's fork",
          web_url: "https://gitlab.com/Group/Upstream/Repository/-/merge_requests/1",
          target_branch: "main",
          source_branch: branch,
          state: "opened",
          updated_at: "2026-04-07T15:00:00Z",
          source_project_id: 101,
          target_project_id: 100,
          source_project: { path_with_namespace: "Group/Subgroup/Fork" },
        },
      ]);
      const calls: VcsProcess.VcsProcessInput[] = [];
      const provider = yield* GitLabSourceControlProvider.make.pipe(
        Effect.provide(
          GitLabCli.layer.pipe(
            Layer.provide(
              Layer.mock(VcsProcess.VcsProcess)({
                run: (input) =>
                  Effect.sync(() => {
                    calls.push(input);
                    return fakeGhOutput(output);
                  }),
              }),
            ),
          ),
        ),
      );
      const { manager } = yield* makeManager({ sourceControlProvider: provider });

      expect(yield* manager.branchPullRequest({ cwd: repoDir, branch })).toMatchObject({
        number: 1,
        repositoryKey: "gitlab.com/group/upstream/repository",
      });
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.command).toBe("glab");
        expect(call.args).toEqual([
          "mr",
          "list",
          "--source-branch",
          branch,
          "--all",
          "--per-page",
          "20",
          "--output",
          "json",
        ]);
      }
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
        NodeFS.writeFileSync(NodePath.join(repoDir, "fork-pr.txt"), "fork pr\n");
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
          updatedAt: "2026-03-10T07:00:00.000Z",
        });
        expect(ghCalls).toContain(
          "pr list --head statemachine --state all --limit 100 --json number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        );
      }),
    20_000,
  );

  it.effect(
    "status preserves a fork PR whose head is named after the default branch",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "fork-seed", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "t3code/pr-777/main"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to", "fork-seed/main"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "fork-seed",
          "git@github.com:contributor/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              main: JSON.stringify([
                {
                  number: 777,
                  title: "Fork PR from main",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/777",
                  baseRefName: "main",
                  headRefName: "main",
                  state: "OPEN",
                  updatedAt: "2026-03-10T07:00:00Z",
                  isCrossRepository: true,
                  headRepository: {
                    nameWithOwner: "contributor/codething-mvp",
                  },
                  headRepositoryOwner: {
                    login: "contributor",
                  },
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.refName).toBe("t3code/pr-777/main");
        expect(status.pr).toEqual({
          number: 777,
          title: "Fork PR from main",
          url: "https://github.com/pingdotgg/codething-mvp/pull/777",
          baseRef: "main",
          headRef: "main",
          state: "open",
          updatedAt: "2026-03-10T07:00:00.000Z",
        });
        expect(ghCalls).toContain(
          "pr list --head main --state all --limit 100 --json number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
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
          updatedAt: "2026-03-01T10:00:00.000Z",
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
        updatedAt: "2026-01-30T10:00:00.000Z",
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

  it.effect("status does not inherit a merged PR from a feature branch's default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/from-main", "origin/main"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListSequence: [
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 54,
                title: "Reverse merge from main",
                url: "https://github.com/pingdotgg/codething-mvp/pull/54",
                baseRefName: "je-filter-list",
                headRefName: "main",
                state: "MERGED",
                mergedAt: "2023-09-28T03:21:10Z",
                updatedAt: "2023-09-28T03:21:10Z",
              },
            ]),
          ],
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/from-main");
      expect(status.pr).toBeNull();
      expect(ghCalls.some((call) => call.includes("pr list"))).toBe(false);
    }),
  );

  it.effect("status finds a PR pushed under the branch's own name despite a default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pushed-plain", "origin/main"]);
      // A plain push (no -u) leaves the upstream on origin/main.
      yield* runGit(repoDir, ["push", "origin", "feature/pushed-plain"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "feature/pushed-plain": JSON.stringify([
              {
                number: 88,
                title: "Pushed without -u",
                url: "https://github.com/pingdotgg/codething-mvp/pull/88",
                baseRefName: "main",
                headRefName: "feature/pushed-plain",
                state: "OPEN",
                updatedAt: "2026-05-01T10:00:00Z",
              },
            ]),
          },
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/pushed-plain");
      expect(status.pr?.number).toBe(88);
      expect(ghCalls.some((call) => call.includes("--head main"))).toBe(false);
    }),
  );

  it.effect(
    "status finds a fork PR pushed under the branch's own name despite a default upstream",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
        yield* configureRemote(repoDir, "team/fork", forkDir, "team/fork");
        yield* runGit(repoDir, ["checkout", "-b", "feature/fork-plain", "origin/main"]);
        // Pushed to the fork without -u: upstream stays origin/main.
        yield* runGit(repoDir, ["push", "team/fork", "feature/fork-plain"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "git@github.com:pingdotgg/codething-mvp.git",
          originDir,
        );
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "team/fork",
          "git@github.com:contributor/codething-mvp.git",
          forkDir,
        );

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListByHeadSelector: {
              // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              "feature/fork-plain": JSON.stringify([
                {
                  number: 89,
                  title: "Fork PR pushed without -u",
                  url: "https://github.com/pingdotgg/codething-mvp/pull/89",
                  baseRefName: "main",
                  headRefName: "feature/fork-plain",
                  state: "OPEN",
                  updatedAt: "2026-05-01T10:00:00Z",
                  isCrossRepository: true,
                  headRepository: { nameWithOwner: "contributor/codething-mvp" },
                  headRepositoryOwner: { login: "contributor" },
                },
              ]),
            },
          },
        });

        const status = yield* manager.status({ cwd: repoDir });
        expect(status.pr?.number).toBe(89);
        expect(ghCalls.some((call) => call.includes("--head feature/fork-plain"))).toBe(true);
        expect(ghCalls.some((call) => call.includes("--head contributor:"))).toBe(false);
        expect(ghCalls.some((call) => call.includes("--head main"))).toBe(false);
      }),
  );

  it.effect("branch PR lookup verifies identity on the fork that holds the own-name ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* configureRemote(repoDir, "team/fork", forkDir, "team/fork");
      yield* runGit(repoDir, ["checkout", "-b", "feature/fork-settle", "origin/main"]);
      yield* runGit(repoDir, ["push", "team/fork", "feature/fork-settle"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "team/fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const { manager } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "feature/fork-settle": JSON.stringify([
              {
                number: 91,
                title: "Fork PR to settle",
                url: "https://github.com/pingdotgg/codething-mvp/pull/91",
                baseRefName: "main",
                headRefName: "feature/fork-settle",
                state: "MERGED",
                updatedAt: "2026-05-02T10:00:00Z",
                isCrossRepository: true,
                headRepository: { nameWithOwner: "contributor/codething-mvp" },
                headRepositoryOwner: { login: "contributor" },
              },
            ]),
          },
        },
      });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/fork-settle",
      });

      expect(pullRequest).toMatchObject({
        state: "merged",
        closedAt: null,
        mergedAt: null,
        updatedAt: "2026-05-02T10:00:00.000Z",
      });
    }),
  );

  it.effect("status keeps an own-name PR when a later lookup fails on a default upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/sticky-plain", "origin/main"]);
      yield* runGit(repoDir, ["push", "origin", "feature/sticky-plain"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
            // Fake gh returns raw JSON stdout, matching the CLI boundary under test.
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            "feature/sticky-plain": JSON.stringify([
              {
                number: 90,
                title: "Sticky own-name PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/90",
                baseRefName: "main",
                headRefName: "feature/sticky-plain",
                state: "OPEN",
                updatedAt: "2026-05-01T10:00:00Z",
              },
            ]),
          },
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(90);

      yield* manager.invalidateStatus(repoDir);
      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(90);
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
        updatedAt: "2026-01-30T10:00:00.000Z",
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
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("gh is not available on PATH"),
          }),
        },
      });

      const status = yield* manager.status({ cwd: repoDir });
      expect(status.refName).toBe("feature/status-no-gh");
      expect(status.pr).toBeNull();
    }),
  );

  it.effect("status logs actionable provider detail without exposing the upstream cause", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-rate-limited"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/status-rate-limited"]);

      const upstreamCause = "GraphQL rate limit for user ID 51714798 and token secret-value";
      const { manager } = yield* makeManager({
        ghScenario: {
          failWith: new GitHubCli.GitHubCliRateLimitError({
            command: "gh",
            cwd: repoDir,
            cause: new Error(upstreamCause),
          }),
        },
      });
      const logs: Array<{ message: string; annotations: Record<string, unknown> }> = [];
      const logger = Logger.make<unknown, void>(({ fiber, message }) => {
        logs.push({
          message: String(message),
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
        });
      });

      const status = yield* manager
        .status({ cwd: repoDir })
        .pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

      expect(status.pr).toBeNull();
      const warning = logs.find((entry) => entry.message.includes("PR lookup failed"));
      expect(warning?.annotations).toMatchObject({
        operation: "lookupStatusPr",
        branch: "feature/status-rate-limited",
        errorTag: "SourceControlProviderError",
        provider: "github",
        providerOperation: "listChangeRequests",
        providerCommand: "gh",
        errorDetail:
          "GitHub API rate limit exceeded. Run `gh api rate_limit` to inspect the quota and reset time.",
      });
      const loggedText = [
        warning?.message ?? "",
        ...Object.values(warning?.annotations ?? {}).map(String),
      ].join("\n");
      expect(loggedText).not.toContain(upstreamCause);
      expect(loggedText).not.toContain("secret-value");
    }),
  );

  it.effect("status keeps the last known PR when a later lookup fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-sticky"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-sticky"]);

      const existingPr = {
        number: 214,
        title: "Sticky PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/214",
        baseRefName: "main",
        headRefName: "feature/pr-sticky",
      };
      const { manager } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr])],
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(214);

      // An explicit invalidation (user refresh, git action) bypasses the PR
      // cache and forces a live lookup — which now fails. The badge must keep
      // the last known PR instead of blanking out.
      yield* manager.invalidateStatus(repoDir);
      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(214);
    }),
  );

  it.effect(
    "status does not reuse a stale PR after the branch is retargeted to a different upstream",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "feature/pr-retarget"]);

        const originRemote = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originRemote]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-retarget"]);

        const existingPr = {
          number: 214,
          title: "Sticky PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/214",
          baseRefName: "main",
          headRefName: "feature/pr-retarget",
        };
        const { manager } = yield* makeManager({
          ghScenario: {
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            prListSequence: [JSON.stringify([existingPr])],
            failWith: new GitHubCli.GitHubCliUnavailableError({
              command: "gh",
              cwd: repoDir,
              cause: new Error("rate limited"),
            }),
            failAfterCalls: 1,
          },
        });

        const first = yield* manager.status({ cwd: repoDir });
        expect(first.pr?.number).toBe(214);

        // Retarget the branch to a different remote/upstream (e.g. the PR was
        // reopened against a fork). The previously cached PR belonged to the
        // old upstream and must not be shown against the new one.
        const forkRemote = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork", forkRemote]);
        yield* runGit(repoDir, ["push", "fork", "feature/pr-retarget"]);
        yield* runGit(repoDir, [
          "branch",
          "--set-upstream-to=fork/feature/pr-retarget",
          "feature/pr-retarget",
        ]);

        yield* manager.invalidateStatus(repoDir);
        const second = yield* manager.status({ cwd: repoDir });
        expect(second.pr).toBeNull();
      }),
  );

  it.effect("status keeps the last known PR when the branch gains its first upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-sticky-first-push"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);

      const existingPr = {
        number: 215,
        title: "Sticky first-push PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/215",
        baseRefName: "main",
        headRefName: "feature/pr-sticky-first-push",
      };
      const { manager } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr])],
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(215);

      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-sticky-first-push"]);
      yield* manager.invalidateStatus(repoDir);

      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(215);
    }),
  );

  it.effect("status drops the last known PR when the tracked remote is repointed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-repointed"]);
      const originalRemoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originalRemoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-repointed"]);

      const existingPr = {
        number: 216,
        title: "Old remote PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/216",
        baseRefName: "main",
        headRefName: "feature/pr-repointed",
      };
      const { manager } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr])],
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(216);

      const replacementRemoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "replacement", replacementRemoteDir]);
      yield* runGit(repoDir, ["push", "replacement", "feature/pr-repointed"]);
      yield* runGit(repoDir, ["remote", "set-url", "origin", replacementRemoteDir]);
      yield* manager.invalidateStatus(repoDir);

      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr).toBeNull();
    }),
  );

  it.effect("status keeps the last known PR when the current remote URL can't be resolved", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-config-hiccup"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-config-hiccup"]);

      const existingPr = {
        number: 217,
        title: "Config hiccup PR",
        url: "https://github.com/pingdotgg/codething-mvp/pull/217",
        baseRefName: "main",
        headRefName: "feature/pr-config-hiccup",
      };
      const { manager } = yield* makeManager({
        ghScenario: {
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          prListSequence: [JSON.stringify([existingPr])],
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("rate limited"),
          }),
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(217);

      // `remote.origin.url` reads go through readConfigValueNullable, which
      // maps ANY failed read (a real "no remote configured" state or a
      // transient git-config hiccup) to null the same way. Unsetting the
      // key here reproduces that ambiguity without touching branch
      // tracking (refs/remotes/origin/* and branch.<b>.remote are
      // untouched) — the remote identity has not actually changed, so the
      // sticky PR must survive even though the current lookup can no
      // longer resolve a remote URL to compare against.
      yield* runGit(repoDir, ["config", "--unset", "remote.origin.url"]);
      yield* manager.invalidateStatus(repoDir);

      const second = yield* manager.status({ cwd: repoDir });
      expect(second.pr?.number).toBe(217);
    }),
  );

  it.effect("creates a commit when working tree is dirty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"] = undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Use a direct tone.",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedPolicy = input.policy;
            return Effect.succeed({ subject: "Implement stacked git actions", body: "" });
          },
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(result.branch.status).toBe("skipped_not_requested");
      expect(result.commit.status).toBe("created");
      expect(result.push.status).toBe("skipped_not_requested");
      expect(result.pr.status).toBe("skipped_not_requested");
      expect(generatedPolicy).toMatchObject({ commitInstructions: "Use a direct tone." });
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

  it.effect("preserves custom style when instructions are empty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"] = undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedPolicy = input.policy;
            return Effect.succeed({ subject: "Preserve custom style", body: "" });
          },
        },
      });
      yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(generatedPolicy).toEqual({
        kind: "custom",
        inferRepositoryConventions: false,
      });
    }),
  );

  it.effect("falls back when the dedicated source control writer is unavailable", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nworld\n");
      const missingInstanceId = ProviderInstanceId.make("missing_writer");
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          providerInstances: {
            [missingInstanceId]: {
              driver: ProviderDriverKind.make("missing-driver"),
              config: {},
            },
          },
          sourceControlWriterModelSelection: {
            instanceId: missingInstanceId,
            model: "missing-model",
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the available writer", body: "" });
          },
        },
      });

      yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(generatedModelSelection).toEqual(DEFAULT_SERVER_SETTINGS.textGenerationModelSelection);
    }),
  );

  it.effect("includes local agent instructions when recent history is empty", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* runGit(repoDir, ["init", "--initial-branch=main"]);
      yield* runGit(repoDir, ["config", "user.email", "test@example.com"]);
      yield* runGit(repoDir, ["config", "user.name", "Test User"]);
      const agentInstructions = "Use lowercase source control text.";
      const claudeInstructions = "Keep pull request bodies brief.";
      NodeFS.writeFileSync(NodePath.join(repoDir, "AGENTS.md"), agentInstructions);
      NodeFS.writeFileSync(NodePath.join(repoDir, "CLAUDE.md"), claudeInstructions);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\n");
      yield* runGit(repoDir, ["add", "README.md"]);
      let generatedPolicy: TextGeneration.CommitMessageGenerationInput["policy"] = undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          textGenerationModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          },
          sourceControlWritingStyle: {
            mode: "repo_conventions" as const,
          },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedPolicy = input.policy;
            return Effect.succeed({ subject: "Create initial commit", body: "" });
          },
        },
      });
      yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
      });

      expect(generatedPolicy).toEqual({
        kind: "repo_conventions",
        commitInstructions: `Follow the repository's established commit message style when examples are available.\n\nLocal AGENTS.md:\n${agentInstructions}\n\nLocal CLAUDE.md:\n${claudeInstructions}`,
        changeRequestInstructions: `Follow the repository's established change request title and body style when examples are available.\n\nLocal AGENTS.md:\n${agentInstructions}\n\nLocal CLAUDE.md:\n${claudeInstructions}`,
        inferRepositoryConventions: true,
      });
    }),
  );

  it.effect("uses custom commit message when provided", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\ncustom\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "a.txt"), "file a\n");
      NodeFS.writeFileSync(NodePath.join(repoDir, "b.txt"), "file b\n");

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
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nfeature-branch\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\ncustom-feature\n");
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
      const error = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
      }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "runFeatureBranchStep",
        cwd: repoDir,
      });
      expect(error.message).toContain("no changes to commit");
    }),
  );

  it.effect("commits and pushes with upstream auto-setup when needed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/stacked-flow"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "feature.txt"), "feature\n");

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
        NodeFS.writeFileSync(NodePath.join(repoDir, "feature.txt"), "feature\n");

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
      NodeFS.writeFileSync(NodePath.join(repoDir, "push-only.txt"), "push only\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "push-dirty.txt"), "push dirty\n");
      yield* runGit(repoDir, ["add", "push-dirty.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Push dirty branch"]);
      NodeFS.mkdirSync(NodePath.join(repoDir, ".vercel"));
      NodeFS.writeFileSync(NodePath.join(repoDir, ".vercel", "project.json"), "{}\n");

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
      NodeFS.writeFileSync(NodePath.join(repoDir, "create-pr-only.txt"), "create pr\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "provider-fallback.txt"), "fallback\n");
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

  it.effect("create_pr targets the remote default branch when it is not main", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      // A repository whose default branch is master, with no main anywhere.
      yield* runGit(repoDir, ["push", "origin", "HEAD:master"]);
      yield* runGit(repoDir, ["fetch", "origin"]);
      yield* runGit(repoDir, ["remote", "set-head", "origin", "master"]);

      yield* runGit(repoDir, ["checkout", "-b", "feature/master-default"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "master-default.txt"), "master default\n");
      yield* runGit(repoDir, ["add", "master-default.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Master default"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          // Mirrors a provider that cannot report a default branch, as the Azure
          // DevOps CLI does when it cannot detect the repository.
          defaultBranch: "",
          prListSequence: [
            "[]",
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 505,
                title: "Master default",
                url: "https://github.com/pingdotgg/codething-mvp/pull/505",
                baseRefName: "master",
                headRefName: "feature/master-default",
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
      expect(
        ghCalls.some((call) =>
          call.includes("pr create --base master --head feature/master-default"),
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
    "returns existing cross-repo PR metadata found under the bare branch name",
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
            call.includes("pr list --head statemachine --state open --limit 100"),
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
        NodeFS.writeFileSync(NodePath.join(repoDir, "changes.txt"), "change\n");
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
    "picks the fork PR among same-named branches from other repositories",
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
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);
        expect(
          ghCalls.some((call) => /--head [^ ]*:/u.test(call) && call.startsWith("pr list")),
        ).toBe(false);
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
              statemachine: JSON.stringify([
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
              "t3code/pr-142/statemachine": JSON.stringify([]),
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("opened_existing");
        expect(result.pr.number).toBe(142);

        const openLookupCalls = ghCalls.filter((call) => call.includes("--state open --limit 100"));
        expect(openLookupCalls).toHaveLength(1);
        expect(openLookupCalls[0]).toContain(
          "pr list --head statemachine --state open --limit 100",
        );
      }),
    12_000,
  );

  it.effect(
    "does not reuse a cross-repo PR when GitHub omits head identity metadata",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["checkout", "-b", "statemachine"]);
        const forkDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
        yield* runGit(repoDir, ["push", "-u", "fork-seed", "statemachine"]);
        yield* runGit(repoDir, [
          "config",
          "remote.fork-seed.url",
          "git@github.com:octocat/codething-mvp.git",
        ]);

        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequenceByHeadSelector: {
              statemachine: [
                `[{"number":41,"title":"Ambiguous fork PR","url":"https://github.com/pingdotgg/codething-mvp/pull/41","baseRefName":"main","headRefName":"statemachine","state":"OPEN"}]`,
                `[{"number":142,"title":"Add stacked git actions","url":"https://github.com/pingdotgg/codething-mvp/pull/142","baseRefName":"main","headRefName":"statemachine","state":"OPEN","isCrossRepository":true,"headRepository":{"nameWithOwner":"octocat/codething-mvp"},"headRepositoryOwner":{"login":"octocat"}}]`,
              ],
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit_push_pr",
        });

        expect(result.pr.status).toBe("created");
        expect(result.pr.number).toBe(142);
        expect(ghCalls.some((call) => call.startsWith("pr create "))).toBe(true);
      }),
    20_000,
  );

  it.effect("matches mounted Forgejo heads without confusing forks sharing a branch", () =>
    Effect.gen(function* () {
      for (const owner of ["maria", "reviewer"]) {
        const mapped = toForgejoChangeRequest(
          yield* decodeForgejoPullRequest({
            number: 42,
            title: "Greeting",
            html_url: "https://forgejo.example/forgejo/maria/project/pulls/42",
            state: "open",
            merged: false,
            base: {
              ref: "main",
              sha: "base",
              repo: { full_name: "maria/project", owner: { login: "maria" } },
            },
            head: {
              ref: "greeting",
              sha: "head",
              repo: { full_name: `${owner}/project`, owner: { login: owner } },
            },
          }),
        );
        const pr = {
          ...mapped,
          isDraft: mapped.isDraft ?? false,
          closedAt: mapped.closedAt ?? null,
          mergedAt: mapped.mergedAt ?? null,
        };
        const repository = GitManager.parseRepositoryNameWithOwnerFromRemoteUrl(
          `https://forgejo.example/forgejo/${owner}/project.git`,
          "forgejo",
        );
        expect(repository).toBe(`${owner}/project`);
        const context = {
          headBranch: "greeting",
          headRepositoryNameWithOwner: repository,
          headRepositoryOwnerLogin: repository?.split("/")[0] ?? null,
          isCrossRepository: owner !== "maria",
        };
        expect(GitManager.matchesBranchHeadContext(pr, context)).toBe(true);
        expect(
          GitManager.matchesBranchHeadContext(pr, {
            ...context,
            headRepositoryNameWithOwner: "other/project",
            headRepositoryOwnerLogin: "other",
          }),
        ).toBe(false);
      }
      expect(
        GitManager.parseRepositoryNameWithOwnerFromRemoteUrl(
          "git@forgejo.example:maria/project.git",
          "forgejo",
        ),
      ).toBe("maria/project");
      expect(
        GitManager.parseRepositoryNameWithOwnerFromRemoteUrl(
          "https://gitlab.example/group/maria/project.git",
          "gitlab",
        ),
      ).toBe("group/maria/project");
    }),
  );

  it.effect("rejects same-repo PR metadata when matching a cross-repo head context", () =>
    Effect.sync(() => {
      const headContext = {
        headBranch: "statemachine",
        headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
        headRepositoryOwnerLogin: "pingdotgg",
        isCrossRepository: true,
      };

      expect(
        GitManager.matchesBranchHeadContext(
          {
            number: 41,
            title: "Same-repo PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/41",
            baseRefName: "main",
            headRefName: "statemachine",
            state: "open",
            updatedAt: Option.none(),
            isCrossRepository: false,
            headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
            headRepositoryOwnerLogin: "pingdotgg",
          },
          headContext,
        ),
      ).toBe(false);

      expect(
        GitManager.matchesBranchHeadContext(
          {
            number: 142,
            title: "Fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/142",
            baseRefName: "main",
            headRefName: "statemachine",
            state: "open",
            updatedAt: Option.none(),
            isCrossRepository: true,
            headRepositoryNameWithOwner: "pingdotgg/codething-mvp",
            headRepositoryOwnerLogin: "pingdotgg",
          },
          headContext,
        ),
      ).toBe(true);
    }),
  );

  it.effect("accepts fork PR metadata when origin is the fork checkout remote", () =>
    Effect.sync(() => {
      const headContext = {
        headBranch: "t3code/git-audit-stability",
        headRepositoryNameWithOwner: "justsomelegs/t3code",
        headRepositoryOwnerLogin: "justsomelegs",
        isCrossRepository: false,
      };

      expect(
        GitManager.matchesBranchHeadContext(
          {
            number: 2284,
            title: "Improve branch mismatch warnings",
            url: "https://github.com/pingdotgg/t3code/pull/2284",
            baseRefName: "main",
            headRefName: "t3code/git-audit-stability",
            state: "open",
            updatedAt: Option.none(),
            isCrossRepository: true,
            headRepositoryNameWithOwner: "justsomelegs/t3code",
            headRepositoryOwnerLogin: "justsomelegs",
          },
          headContext,
        ),
      ).toBe(true);
    }),
  );

  it.effect("creates PR when one does not already exist", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
      NodeFS.writeFileSync(
        NodePath.join(repoDir, ".github", "pull_request_template.md"),
        "## What changed?\n\n## Verification",
      );
      yield* runGit(repoDir, ["add", ".github/pull_request_template.md"]);
      yield* runGit(repoDir, ["commit", "-m", "Add pull request template"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature-create-pr"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "changes.txt"), "change\n");
      yield* runGit(repoDir, ["add", "changes.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature-create-pr"]);
      yield* runGit(repoDir, ["config", "branch.feature-create-pr.gh-merge-base", "main"]);
      let generatedPolicy: TextGeneration.PrContentGenerationInput["policy"] = undefined;
      let generatedChangeRequestTemplate: string | undefined;

      const { manager, ghCalls } = yield* makeManager({
        serverSettings: {
          sourceControlWritingStyle: {
            mode: "custom" as const,
            customInstructions: "Lead with user impact.",
          },
        },
        textGeneration: {
          generatePrContent: (input) => {
            generatedPolicy = input.policy;
            generatedChangeRequestTemplate = input.changeRequestTemplate;
            return Effect.succeed({
              title: "Add stacked git actions",
              body: "## What changed?\nAdded stacked git actions.",
            });
          },
        },
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
      expect(generatedPolicy).toMatchObject({
        changeRequestInstructions: "Lead with user impact.",
      });
      expect(generatedChangeRequestTemplate).toBe("## What changed?\n\n## Verification");
      expect(ghCalls.filter((call) => call.startsWith("pr list "))).toHaveLength(2);
      expect(
        ghCalls.some((call) => call.includes("pr create --base main --head feature-create-pr")),
      ).toBe(true);
      expect(ghCalls.some((call) => call.startsWith("pr view "))).toBe(false);
    }),
  );

  it.effect("generates PR content from branch changes when the remote base advances", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(remoteDir, ["symbolic-ref", "HEAD", "refs/heads/main"]);

      const peerDir = yield* makeTempDir("t3code-git-peer-");
      yield* runGit(peerDir, ["clone", remoteDir, "."]);
      yield* runGit(peerDir, ["config", "user.email", "peer@example.com"]);
      yield* runGit(peerDir, ["config", "user.name", "Peer User"]);
      NodeFS.writeFileSync(NodePath.join(peerDir, "remote.txt"), "remote\n");
      yield* runGit(peerDir, ["add", "remote.txt"]);
      yield* runGit(peerDir, ["commit", "-m", "Remote base commit"]);
      yield* runGit(peerDir, ["push", "origin", "main"]);

      yield* runGit(repoDir, ["fetch", "origin"]);
      yield* runGit(repoDir, [
        "checkout",
        "--no-track",
        "-b",
        "feature/remote-base",
        "origin/main",
      ]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "feature.txt"), "feature\n");
      yield* runGit(repoDir, ["add", "feature.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/remote-base"]);
      yield* runGit(repoDir, ["config", "branch.feature/remote-base.gh-merge-base", "main"]);

      NodeFS.writeFileSync(NodePath.join(peerDir, "later-main.txt"), "unrelated\n");
      yield* runGit(peerDir, ["add", "later-main.txt"]);
      yield* runGit(peerDir, ["commit", "-m", "Later main commit"]);
      yield* runGit(peerDir, ["push", "origin", "main"]);
      yield* runGit(repoDir, ["fetch", "origin"]);

      let generatedCommitSummary = "";
      let generatedDiffSummary = "";
      let generatedDiffPatch = "";
      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: ["[]", "[]"],
        },
        textGeneration: {
          generatePrContent: (input) => {
            generatedCommitSummary = input.commitSummary;
            generatedDiffSummary = input.diffSummary;
            generatedDiffPatch = input.diffPatch;
            return Effect.succeed({ title: "Feature PR", body: "Feature body" });
          },
        },
      });

      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "create_pr",
      });

      expect(result.pr.status).toBe("created");
      expect(generatedCommitSummary).toContain("Feature commit");
      expect(generatedCommitSummary).not.toContain("Remote base commit");
      expect(generatedCommitSummary).not.toContain("Later main commit");
      expect(generatedDiffSummary).toContain("feature.txt");
      expect(generatedDiffSummary).not.toContain("later-main.txt");
      expect(generatedDiffPatch).toContain("feature.txt");
      expect(generatedDiffPatch).not.toContain("later-main.txt");
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
        NodeFS.writeFileSync(NodePath.join(repoDir, "changes.txt"), "change\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "changes.txt"), "change\n");
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
            statemachine: [
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
          failWith: new GitHubCli.GitHubCliUnavailableError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("gh is not available on PATH"),
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
          failWith: new GitHubCli.GitHubCliAuthenticationError({
            command: "gh",
            cwd: repoDir,
            cause: new Error("gh is not authenticated"),
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "local.txt"), "local\n");
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
      expect(ghCalls).toContain("pr checkout 64");
    }),
  );

  // A real repository and remote; the fake gh replays gh 2.94's own checkout, in which
  // `--force` hard-resets the PR branch onto the pull head.
  const setUpLocalCheckoutPullRequest = (number: number, headBranch: string) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", headBranch]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "pr.txt"), "first\n");
      yield* runGit(repoDir, ["add", "pr.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR first"]);
      const firstCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      // The pull head moves on without this checkout.
      NodeFS.writeFileSync(NodePath.join(repoDir, "pr.txt"), "second\n");
      yield* runGit(repoDir, ["commit", "-am", "PR second"]);
      const pullHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["push", "origin", `HEAD:refs/pull/${number}/head`]);
      yield* runGit(repoDir, ["reset", "--hard", firstCommit]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "https://github.com/pingdotgg/codething-mvp.git",
        remoteDir,
      );
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number,
            title: "Safe checkout PR",
            url: `https://github.com/pingdotgg/codething-mvp/pull/${number}`,
            baseRefName: "main",
            headRefName: headBranch,
            state: "open",
          },
          repositoryCloneUrls: pullRequestRepositoryCloneUrls,
          syncCheckoutWithPullHead: true,
        },
      });
      return { repoDir, manager, ghCalls, firstCommit, pullHead };
    });

  it.effect("local PR checkout refuses, and keeps tracked edits, when the tree is dirty", () =>
    Effect.gen(function* () {
      const { repoDir, manager } = yield* setUpLocalCheckoutPullRequest(91, "feature/pr-dirty");
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "my unsaved edit\n");

      const error = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "91",
        mode: "local",
      }).pipe(Effect.flip);

      expect(error.message).toContain("uncommitted changes");
      expect(NodeFS.readFileSync(NodePath.join(repoDir, "README.md"), "utf8")).toBe(
        "my unsaved edit\n",
      );
    }),
  );

  it.effect(
    "local PR checkout refuses, and keeps local commits, when the PR branch has diverged",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager } = yield* setUpLocalCheckoutPullRequest(
          92,
          "feature/pr-diverged",
        );
        NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
        yield* runGit(repoDir, ["add", "mine.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "My local commit"]);
        const localCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);

        const error = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "92",
          mode: "local",
        }).pipe(Effect.flip);

        expect(error.message).toContain("commits that are not on pull request #92");
        expect(
          (yield* runGit(repoDir, ["rev-parse", "refs/heads/feature/pr-diverged"])).stdout.trim(),
        ).toBe(localCommit);
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
      }),
  );

  it.effect("local PR checkout fast-forwards a clean PR branch without forcing", () =>
    Effect.gen(function* () {
      const { repoDir, manager, ghCalls, pullHead } = yield* setUpLocalCheckoutPullRequest(
        93,
        "feature/pr-behind",
      );
      yield* runGit(repoDir, ["checkout", "main"]);

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "93",
        mode: "local",
      });

      expect(result).toMatchObject({
        branch: "feature/pr-behind",
        worktreePath: null,
        isOnPullRequestHead: true,
      });
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
      expect(ghCalls).toContain("pr checkout 93");
      expect(ghCalls.some((call) => call.includes("--force"))).toBe(false);
    }),
  );

  // A host that publishes no `refs/pull/<n>/head` or checks the pull request out on a branch of
  // its own name (Forgejo's `pulls/<n>`): the scripted provider only switches to the local
  // branch, as Bitbucket and Forgejo do for a branch that already exists, without moving it.
  const setUpSwitchOnlyPullRequest = (input: {
    readonly kind?: "github" | "gitlab" | "bitbucket";
    readonly number: number;
    readonly headBranch: string;
    readonly localBranch?: string;
    readonly publishPullRef?: boolean;
    readonly pushHeadBranch?: boolean;
    readonly afterCheckout?: (cwd: string) => void;
  }) =>
    Effect.gen(function* () {
      const localBranch = input.localBranch ?? input.headBranch;
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", localBranch]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "pr.txt"), "first\n");
      yield* runGit(repoDir, ["add", "pr.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR first"]);
      const firstCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      NodeFS.writeFileSync(NodePath.join(repoDir, "pr.txt"), "second\n");
      yield* runGit(repoDir, ["commit", "-am", "PR second"]);
      const pullHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      if (input.pushHeadBranch !== false) {
        yield* runGit(repoDir, ["push", "origin", `HEAD:refs/heads/${input.headBranch}`]);
      }
      if (input.publishPullRef === true) {
        yield* runGit(repoDir, ["push", "origin", `HEAD:refs/pull/${input.number}/head`]);
      }
      yield* runGit(repoDir, ["reset", "--hard", firstCommit]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const kind = input.kind ?? "github";
      const host = { github: "github.com", gitlab: "gitlab.com", bitbucket: "bitbucket.org" }[kind];
      const pullPath = { github: "pull", gitlab: "-/merge_requests", bitbucket: "pull-requests" }[
        kind
      ];
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        `https://${host}/owner/repo.git`,
        remoteDir,
      );
      const { service } = createGitHubCliWithFakeGh();
      const base = yield* GitHubSourceControlProvider.make.pipe(
        Effect.provide(Layer.succeed(GitHubCli.GitHubCli, service)),
      );
      const provider: SourceControlProvider["Service"] = {
        ...base,
        kind,
        getChangeRequest: () =>
          Effect.succeed({
            provider: kind,
            number: input.number,
            title: "Switch-only checkout PR",
            url: `https://${host}/owner/repo/${pullPath}/${input.number}`,
            baseRefName: "main",
            headRefName: input.headBranch,
            state: "open" as const,
            updatedAt: Option.none(),
          }),
        getRepositoryCloneUrls: (lookup) =>
          Effect.succeed({
            nameWithOwner: lookup.repository,
            url: `https://${host}/owner/repo.git`,
            sshUrl: `git@${host}:owner/repo.git`,
          }),
        checkoutChangeRequest: (checkout) =>
          Effect.sync(() => {
            runGitSyncForFakeGh(checkout.cwd, ["checkout", localBranch]);
            input.afterCheckout?.(checkout.cwd);
          }),
      };
      const { manager } = yield* makeManager({ sourceControlProvider: provider });
      return { repoDir, manager, firstCommit, pullHead };
    });

  it.effect(
    "local PR checkout fast-forwards a branch the provider left behind on a host without pull refs",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpSwitchOnlyPullRequest({
          number: 94,
          headBranch: "feature/pr-switch-only",
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "94",
          mode: "local",
        });

        expect(result.isOnPullRequestHead).toBe(true);
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
      }),
  );

  it.effect(
    "local PR checkout refuses a branch with commits the PR lacks on a host without pull refs",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager } = yield* setUpSwitchOnlyPullRequest({
          number: 95,
          headBranch: "feature/pr-switch-diverged",
        });
        yield* runGit(repoDir, ["checkout", "feature/pr-switch-diverged"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
        yield* runGit(repoDir, ["add", "mine.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "My local commit"]);
        const localCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);

        const outcome = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "95",
          mode: "local",
        }).pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: () => "checked out",
          }),
        );

        expect(outcome).toContain("commits that are not on pull request #95");
        expect(
          (yield* runGit(repoDir, [
            "rev-parse",
            "refs/heads/feature/pr-switch-diverged",
          ])).stdout.trim(),
        ).toBe(localCommit);
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
      }),
  );

  it.effect(
    "a refused local PR checkout puts back the branch's upstream the provider changed",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager } = yield* setUpSwitchOnlyPullRequest({
          number: 99,
          headBranch: "feature/pr-retracked",
          // As Bitbucket's checkout does before switching to the branch.
          afterCheckout: (cwd) =>
            runGitSyncForFakeGh(cwd, [
              "branch",
              "--set-upstream-to=origin/feature/pr-retracked",
              "feature/pr-retracked",
            ]),
        });
        yield* runGit(repoDir, ["checkout", "feature/pr-retracked"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
        yield* runGit(repoDir, ["add", "mine.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "My local commit"]);
        yield* runGit(repoDir, ["branch", "--set-upstream-to=origin/main", "feature/pr-retracked"]);
        yield* runGit(repoDir, ["checkout", "main"]);

        const outcome = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "99",
          mode: "local",
        }).pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: () => "checked out",
          }),
        );

        expect(outcome).toContain("commits that are not on pull request #99");
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
        expect(
          (yield* runGit(repoDir, ["config", "--get-all", "branch.feature/pr-retracked.merge"]))
            .stdout,
        ).toBe("refs/heads/main\n");
      }),
  );

  it.effect("local PR checkout does not claim the head when the head cannot be read", () =>
    Effect.gen(function* () {
      const { repoDir, manager, firstCommit } = yield* setUpSwitchOnlyPullRequest({
        number: 96,
        headBranch: "feature/pr-switch-unreadable",
        pushHeadBranch: false,
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "96",
        mode: "local",
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(firstCommit);
    }),
  );

  it.effect(
    "local PR checkout verifies a differently named checkout branch against the pull ref",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpSwitchOnlyPullRequest({
          number: 97,
          headBranch: "feature/pr-renamed",
          localBranch: "pulls/97",
          publishPullRef: true,
          pushHeadBranch: false,
        });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "97",
          mode: "local",
        });

        expect(result).toMatchObject({ branch: "pulls/97", isOnPullRequestHead: true });
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
      }),
  );

  it.effect(
    "local PR checkout refuses, and keeps, local commits on a differently named checkout branch",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager } = yield* setUpSwitchOnlyPullRequest({
          number: 98,
          headBranch: "feature/pr-renamed-ahead",
          localBranch: "pulls/98",
          publishPullRef: true,
          pushHeadBranch: false,
        });
        yield* runGit(repoDir, ["checkout", "pulls/98"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
        yield* runGit(repoDir, ["add", "mine.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "My local commit"]);
        const localCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);

        const outcome = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "98",
          mode: "local",
        }).pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: () => "checked out",
          }),
        );

        expect(outcome).toContain("The local branch pulls/98 has commits");
        expect((yield* runGit(repoDir, ["rev-parse", "pulls/98"])).stdout.trim()).toBe(localCommit);
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
      }),
  );

  it.effect(
    "local PR checkout ignores a divergent local branch named after the head when the provider checks out another",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpSwitchOnlyPullRequest({
          number: 197,
          headBranch: "feature/source",
          localBranch: "pulls/197",
          publishPullRef: true,
          pushHeadBranch: false,
        });
        yield* runGit(repoDir, ["checkout", "-b", "feature/source"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "unrelated.txt"), "unrelated local work\n");
        yield* runGit(repoDir, ["add", "unrelated.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Unrelated local source-name branch"]);
        const unrelated = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);

        const outcome = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "197",
          mode: "local",
        }).pipe(
          Effect.match({
            onFailure: (error) => ({ error: error.message }),
            onSuccess: (result) => result,
          }),
        );

        expect(outcome).toMatchObject({ branch: "pulls/197", isOnPullRequestHead: true });
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
        expect((yield* runGit(repoDir, ["rev-parse", "feature/source"])).stdout.trim()).toBe(
          unrelated,
        );
      }),
  );

  it.effect.each(["local", "worktree"] as const)(
    "verifies GitLab's published MR head and advances a clean %s checkout",
    (mode) =>
      Effect.gen(function* () {
        const number = mode === "local" ? 320 : 321;
        const { repoDir, manager, pullHead } = yield* setUpSwitchOnlyPullRequest({
          kind: "gitlab",
          number,
          headBranch: `feature/gitlab-${mode}-published-head`,
          pushHeadBranch: false,
        });
        yield* runGit(repoDir, [
          "push",
          "origin",
          `${pullHead}:refs/merge-requests/${number}/head`,
        ]);
        const branch = `feature/gitlab-${mode}-published-head`;
        const checkoutPath =
          mode === "local"
            ? repoDir
            : NodePath.join(repoDir, "..", `gitlab-reused-${NodePath.basename(repoDir)}`);
        if (mode === "worktree") {
          yield* runGit(repoDir, ["worktree", "add", checkoutPath, branch]);
        }

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: String(number),
          mode,
        });

        expect(result).toMatchObject({ branch, isOnPullRequestHead: true });
        expect((yield* runGit(checkoutPath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
      }),
  );

  it.effect("PR checkout without a verifiable GitLab or Bitbucket head is never advanced", () =>
    Effect.gen(function* () {
      for (const [index, kind] of (["gitlab", "bitbucket"] as const).entries()) {
        const local = yield* setUpSwitchOnlyPullRequest({
          kind,
          number: 300 + index,
          headBranch: `feature/${kind}-local`,
          publishPullRef: true,
          pushHeadBranch: false,
        });
        const localResult = yield* preparePullRequestThread(local.manager, {
          cwd: local.repoDir,
          reference: String(300 + index),
          mode: "local",
        });
        expect(localResult.isOnPullRequestHead).toBe(false);
        expect((yield* runGit(local.repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
          local.firstCommit,
        );

        const reused = yield* setUpSwitchOnlyPullRequest({
          kind,
          number: 310 + index,
          headBranch: `feature/${kind}-reused`,
          publishPullRef: true,
          pushHeadBranch: false,
        });
        const worktreePath = NodePath.join(
          reused.repoDir,
          "..",
          `${kind}-reused-${NodePath.basename(reused.repoDir)}`,
        );
        yield* runGit(reused.repoDir, ["worktree", "add", worktreePath, `feature/${kind}-reused`]);
        const reusedResult = yield* preparePullRequestThread(reused.manager, {
          cwd: reused.repoDir,
          reference: String(310 + index),
          mode: "worktree",
        });
        expect(reusedResult).toMatchObject({ isOnPullRequestHead: false });
        expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
          reused.firstCommit,
        );
      }
    }),
  );

  // Azure pull request IDs are organization-wide, but `az repos show --repository repo` resolves
  // the bare name in the checkout's own project. Here the checkout belongs to ProjectA, the pull
  // request and its already-open worktree to ProjectB, and ProjectA has its own `repo` with a
  // same-named branch holding unrelated work.
  it.effect(
    "reused Azure PR worktree is not moved onto another project's same-named repository",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const anchorDir = yield* createBareRemote();
        const projectADir = yield* createBareRemote();
        const projectBDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", anchorDir]);
        yield* runGit(repoDir, ["remote", "add", "project-a", projectADir]);
        yield* runGit(repoDir, ["remote", "add", "project-b", projectBDir]);
        for (const remote of ["origin", "project-a", "project-b"]) {
          yield* runGit(repoDir, ["push", remote, "main"]);
        }
        yield* runGit(repoDir, ["checkout", "-b", "feature/right-pr"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "right.txt"), "wanted PR\n");
        yield* runGit(repoDir, ["add", "right.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Wanted PR"]);
        const wanted = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["push", "project-b", "HEAD:refs/heads/feature/right-pr"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "wrong.txt"), "another project's work\n");
        yield* runGit(repoDir, ["add", "wrong.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Unrelated descendant in ProjectA"]);
        yield* runGit(repoDir, ["push", "project-a", "HEAD:refs/heads/feature/right-pr"]);
        yield* runGit(repoDir, ["reset", "--hard", wanted]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          "https://dev.azure.com/org/ProjectA/_git/anchor",
          anchorDir,
        );
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "project-a",
          "https://dev.azure.com/org/ProjectA/_git/repo",
          projectADir,
        );
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "project-b",
          "https://dev.azure.com/org/ProjectB/_git/repo",
          projectBDir,
        );
        const worktreePath = NodePath.join(
          repoDir,
          "..",
          `azure-reused-${NodePath.basename(repoDir)}`,
        );
        yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/right-pr"]);
        const { service } = createGitHubCliWithFakeGh();
        const base = yield* GitHubSourceControlProvider.make.pipe(
          Effect.provide(Layer.succeed(GitHubCli.GitHubCli, service)),
        );
        const provider: SourceControlProvider["Service"] = {
          ...base,
          kind: "azure-devops",
          getChangeRequest: () =>
            Effect.succeed({
              provider: "azure-devops" as const,
              number: 198,
              title: "Wanted ProjectB PR",
              url: "https://dev.azure.com/org/ProjectB/_git/repo/pullrequest/198",
              baseRefName: "main",
              headRefName: "feature/right-pr",
              state: "open" as const,
              isCrossRepository: false,
              updatedAt: Option.none(),
            }),
          getRepositoryCloneUrls: () =>
            Effect.succeed({
              nameWithOwner: "ProjectA/repo",
              url: "https://dev.azure.com/org/ProjectA/_git/repo",
              sshUrl: "https://dev.azure.com/org/ProjectA/_git/repo",
            }),
          checkoutChangeRequest: () => Effect.die("A reused worktree is never checked out again"),
        };
        const { manager } = yield* makeManager({ sourceControlProvider: provider });

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "https://dev.azure.com/org/ProjectB/_git/repo/pullrequest/198",
          mode: "worktree",
        });

        expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(wanted);
        expect(result.isOnPullRequestHead).toBe(false);
      }),
  );

  // origin is a fork holding a different pull request under the same number as the upstream one
  // the provider resolved. The provider reports `upstreamUrl` (or `reportedUrl`) for it.
  const setUpCollidingPullRequestNumbers = (input: {
    readonly kind?: "github" | "gitlab";
    readonly repository: string;
    readonly originUrl: string;
    readonly upstreamUrl: string;
    readonly visibleRemotes: boolean;
    readonly originSecondaryUrl?: string;
    readonly reportedUrl?: string;
    // Like gh: a lookup that does not name the pull request's host answers for this URL instead.
    readonly unqualifiedLookupUrl?: string;
    readonly reportedNameWithOwner?: string;
  }) =>
    Effect.gen(function* () {
      const kind = input.kind ?? "github";
      const pullRequestHeadRef =
        kind === "gitlab" ? "refs/merge-requests/198/head" : "refs/pull/198/head";
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const upstreamDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["remote", "add", "upstream", upstreamDir]);
      yield* runGit(repoDir, ["push", "origin", "main"]);
      yield* runGit(repoDir, ["push", "upstream", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/right-pr"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "right.txt"), "wanted PR\n");
      yield* runGit(repoDir, ["add", "right.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Wanted PR"]);
      const wanted = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, [
        "push",
        "upstream",
        "HEAD:refs/heads/feature/right-pr",
        `HEAD:${pullRequestHeadRef}`,
      ]);
      yield* runGit(repoDir, ["checkout", "-b", "wrong-origin-pr"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "wrong.txt"), "unrelated PR in origin\n");
      yield* runGit(repoDir, ["add", "wrong.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Different PR sharing the number"]);
      yield* runGit(repoDir, ["push", "origin", `HEAD:${pullRequestHeadRef}`]);
      yield* runGit(repoDir, ["checkout", "main"]);
      if (input.visibleRemotes) {
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          input.originUrl,
          originDir,
        );
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "upstream",
          input.upstreamUrl,
          upstreamDir,
        );
      } else {
        yield* servePullRequestRepository(repoDir, upstreamDir, input.upstreamUrl);
      }
      if (input.originSecondaryUrl !== undefined) {
        yield* runGit(repoDir, ["config", "--add", "remote.origin.url", input.originSecondaryUrl]);
      }
      const reportedUrl = (input.reportedUrl ?? input.upstreamUrl).replace(
        "{upstream}",
        upstreamDir,
      );
      const pullRequestPath = kind === "gitlab" ? "-/merge_requests/198" : "pull/198";
      const pullRequestUrl = `${input.upstreamUrl.replace(/\.git$/u, "")}/${pullRequestPath}`;
      const { service } = createGitHubCliWithFakeGh();
      const base = yield* GitHubSourceControlProvider.make.pipe(
        Effect.provide(Layer.succeed(GitHubCli.GitHubCli, service)),
      );
      const provider: SourceControlProvider["Service"] = {
        ...base,
        kind,
        getChangeRequest: () =>
          Effect.succeed({
            provider: kind,
            number: 198,
            title: "Wanted upstream PR",
            url: pullRequestUrl,
            baseRefName: "main",
            headRefName: "feature/right-pr",
            state: "open" as const,
            isCrossRepository: false,
            headRepositoryNameWithOwner: input.repository,
            headRepositoryOwnerLogin: input.repository.split("/")[0] ?? null,
            updatedAt: Option.none(),
          }),
        getRepositoryCloneUrls: (lookup) => {
          if (lookup.repository !== input.repository) return base.getRepositoryCloneUrls(lookup);
          const url =
            input.unqualifiedLookupUrl !== undefined && lookup.host !== new URL(pullRequestUrl).host
              ? input.unqualifiedLookupUrl
              : reportedUrl;
          return Effect.succeed({
            nameWithOwner: input.reportedNameWithOwner ?? input.repository,
            url,
            sshUrl: url,
          });
        },
        checkoutChangeRequest: (checkout) =>
          Effect.sync(() => runGitSyncForFakeGh(checkout.cwd, ["checkout", "feature/right-pr"])),
      };
      const { manager } = yield* makeManager({ sourceControlProvider: provider });
      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: pullRequestUrl,
        mode: "local",
      });
      const head = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      return { result, head, wanted };
    });

  it.effect("local PR checkout reads the head from the URL the provider reports", () =>
    Effect.gen(function* () {
      const { result, head, wanted } = yield* setUpCollidingPullRequestNumbers({
        repository: "upstream/repo",
        originUrl: "https://github.com/fork/repo.git",
        upstreamUrl: "https://github.com/upstream/repo.git",
        visibleRemotes: true,
      });

      expect(head).toBe(wanted);
      expect(result.isOnPullRequestHead).toBe(true);
    }),
  );

  it.effect("local PR checkout needs no remote configured for the pull request's repository", () =>
    Effect.gen(function* () {
      const { result, head, wanted } = yield* setUpCollidingPullRequestNumbers({
        repository: "upstream/repo",
        originUrl: "https://github.com/fork/repo.git",
        upstreamUrl: "https://github.com/upstream/repo.git",
        visibleRemotes: false,
      });

      expect(head).toBe(wanted);
      expect(result.isOnPullRequestHead).toBe(true);
    }),
  );

  it.effect("local PR checkout keeps servers on different HTTPS ports apart", () =>
    Effect.gen(function* () {
      const { result, head, wanted } = yield* setUpCollidingPullRequestNumbers({
        repository: "team/repo",
        originUrl: "https://forge.example:9443/team/repo.git",
        upstreamUrl: "https://forge.example:8443/team/repo.git",
        visibleRemotes: true,
      });

      expect(head).toBe(wanted);
      expect(result.isOnPullRequestHead).toBe(true);
    }),
  );

  it.effect("local PR checkout looks the repository up on the pull request's own host", () =>
    Effect.gen(function* () {
      const { result, head, wanted } = yield* setUpCollidingPullRequestNumbers({
        repository: "team/repo",
        originUrl: "https://github.com/team/repo.git",
        upstreamUrl: "https://forge.example/team/repo.git",
        visibleRemotes: true,
        unqualifiedLookupUrl: "https://github.com/team/repo.git",
      });

      expect(head).toBe(wanted);
      expect(result.isOnPullRequestHead).toBe(true);
    }),
  );

  for (const kind of ["github", "gitlab"] as const) {
    it.effect(`local ${kind} PR checkout does not trust clone URLs on another host`, () =>
      Effect.gen(function* () {
        const { result, head, wanted } = yield* setUpCollidingPullRequestNumbers({
          kind,
          repository: "team/repo",
          originUrl: "https://other.example/team/repo.git",
          upstreamUrl: "https://forge.example/team/repo.git",
          visibleRemotes: true,
          reportedUrl: "https://other.example/team/repo.git",
        });

        expect(head).toBe(wanted);
        expect(result.isOnPullRequestHead).toBe(false);
      }),
    );

    it.effect(
      `local ${kind} PR checkout does not trust a lookup that names another repository`,
      () =>
        Effect.gen(function* () {
          const { result, head, wanted } = yield* setUpCollidingPullRequestNumbers({
            kind,
            repository: "upstream/repo",
            originUrl: "https://forge.example/fork/repo.git",
            upstreamUrl: "https://forge.example/upstream/repo.git",
            visibleRemotes: true,
            reportedNameWithOwner: "fork/repo",
          });

          expect(head).toBe(wanted);
          expect(result.isOnPullRequestHead).toBe(false);
        }),
    );
  }

  it.effect("local PR checkout ignores a remote that only lists the repository second", () =>
    Effect.gen(function* () {
      const { result, head, wanted } = yield* setUpCollidingPullRequestNumbers({
        repository: "upstream/repo",
        originUrl: "https://github.com/fork/repo.git",
        upstreamUrl: "https://github.com/upstream/repo.git",
        visibleRemotes: true,
        originSecondaryUrl: "https://github.com/upstream/repo.git",
      });

      expect(head).toBe(wanted);
      expect(result.isOnPullRequestHead).toBe(true);
    }),
  );

  for (const reportedUrl of ["file://{upstream}", "{upstream}", "ext::git %S {upstream}"]) {
    it.effect(`local PR checkout does not fetch from a provider URL like ${reportedUrl}`, () =>
      Effect.gen(function* () {
        const { result } = yield* setUpCollidingPullRequestNumbers({
          repository: "upstream/repo",
          originUrl: "https://github.com/fork/repo.git",
          upstreamUrl: "https://github.com/upstream/repo.git",
          visibleRemotes: true,
          reportedUrl,
        });

        expect(result.isOnPullRequestHead).toBe(false);
      }),
    );
  }

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
        NodeFS.writeFileSync(NodePath.join(repoDir, "upstream.txt"), "upstream\n");
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
        NodeFS.writeFileSync(NodePath.join(repoDir, "no-head-repo.txt"), "upstream\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "worktree.txt"), "worktree\n");
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
      expect(NodeFS.existsSync(result.worktreePath as string)).toBe(true);
      const worktreeBranch = (yield* runGit(result.worktreePath as string, [
        "branch",
        "--show-current",
      ])).stdout.trim();
      expect(worktreeBranch).toBe("feature/pr-worktree");
    }),
  );

  it.effect("preserves both branch materialization failures when the fallback also fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);

      const missingForkDir = NodePath.join(repoDir, "missing-fork.git");
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 93,
            title: "Missing fork branch",
            url: "https://github.com/pingdotgg/codething-mvp/pull/93",
            baseRefName: "main",
            headRefName: "feature/missing-fork-branch",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/codething-mvp",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/codething-mvp": {
              url: missingForkDir,
              sshUrl: missingForkDir,
            },
          },
        },
      });

      const error = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "93",
        mode: "worktree",
      }).pipe(Effect.flip);

      if (error._tag !== "GitPullRequestMaterializationError") {
        return yield* Effect.die(error);
      }
      expect(error).toMatchObject({
        cwd: repoDir,
        pullRequestNumber: 93,
        headRepository: "octocat/codething-mvp",
        headBranch: "feature/missing-fork-branch",
        localBranch: "t3code/pr-93/feature/missing-fork-branch",
      });
      if (!(error.cause instanceof AggregateError)) {
        return yield* Effect.die(error.cause);
      }
      expect(error.cause.errors).toHaveLength(2);
      expect(error.cause.errors).toEqual([
        expect.objectContaining({ _tag: "GitCommandError" }),
        expect.objectContaining({ _tag: "GitCommandError" }),
      ]);
      expect(error.cause.cause).toBe(error.cause.errors[0]);
    }),
  );

  it.effect("launches setup when creating a new PR worktree", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-worktree-setup"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "setup.txt"), "setup\n");
      yield* runGit(repoDir, ["add", "setup.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "PR worktree setup branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-worktree-setup"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/177/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "fork.txt"), "fork\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "local-fork.txt"), "local fork\n");
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

  it.effect("local PR checkout adds no remote for a fork clone URL that is not HTTPS or SSH", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-file-fork"]);
      yield* runGit(repoDir, ["push", forkDir, "feature/pr-file-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/pr-file-fork"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 83,
            title: "File fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/83",
            baseRefName: "main",
            headRefName: "feature/pr-file-fork",
            state: "open",
            isCrossRepository: true,
            headRepositoryNameWithOwner: "octocat/codething-mvp",
            headRepositoryOwnerLogin: "octocat",
          },
          repositoryCloneUrls: {
            "octocat/codething-mvp": {
              url: `file://${forkDir}`,
              sshUrl: `file://${forkDir}`,
            },
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "83",
        mode: "local",
      });

      expect(result.branch).toBe("feature/pr-file-fork");
      expect(result.isTrackingPullRequestHead).toBe(false);
      expect((yield* runGit(repoDir, ["remote"])).stdout.trim()).toBe("origin");
      expect(
        (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"], true)).exitCode,
      ).not.toBe(0);
    }),
  );

  it.effect("local PR checkout of an unnamed fork reports its tracking as unknown", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 84,
            title: "Deleted fork PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/84",
            baseRefName: "main",
            headRefName: "feature/pr-deleted-fork",
            state: "open",
            isCrossRepository: true,
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "84",
        mode: "local",
      });

      expect(result.branch).toBe("feature/pr-deleted-fork");
      expect(result).not.toHaveProperty("isTrackingPullRequestHead");
      expect(
        (yield* runGit(repoDir, ["rev-parse", "--abbrev-ref", "@{upstream}"], true)).exitCode,
      ).not.toBe(0);
    }),
  );

  it.effect.each(["gitlab.127.0.0.1.nip.io:18880", "gitlab.127.0.0.1.nip.io"])(
    "checks out the real glab MR shape from GitLab's published head on %s",
    (host) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "origin", "main"]);
        yield* runGit(repoDir, ["checkout", "-b", "vc41-fork-feature"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "VC41.txt"), "fork head\n");
        yield* runGit(repoDir, ["add", "VC41.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Fork MR head"]);
        const headCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["push", "origin", "HEAD:refs/merge-requests/1/head"]);
        yield* runGit(repoDir, ["checkout", "main"]);
        yield* runGit(repoDir, ["branch", "-D", "vc41-fork-feature"]);
        yield* configureVisibleRemoteUrlWithLocalRewrite(
          repoDir,
          "origin",
          `http://${host}/proofowner/vc41-upstream.git`,
          remoteDir,
        );
        const mrUrl = `http://${host}/proofowner/vc41-upstream/-/merge_requests/1`;
        const calls: ReadonlyArray<string>[] = [];
        const provider = yield* GitLabSourceControlProvider.make.pipe(
          Effect.provide(
            GitLabCli.layer.pipe(
              Layer.provide(
                Layer.mock(VcsProcess.VcsProcess)({
                  run: (call) => {
                    calls.push(call.args);
                    expect(call.args).toEqual(["mr", "view", mrUrl, "--output", "json"]);
                    return Effect.succeed(
                      fakeGhOutput(
                        // glab v1.80.0, captured by proof/vc41-gitlab: project IDs, no path objects.
                        encodeCliJson({
                          iid: 1,
                          title: "VC41 local fork checkout",
                          web_url: mrUrl,
                          source_branch: "vc41-fork-feature",
                          target_branch: "main",
                          state: "opened",
                          source_project_id: 2,
                          target_project_id: 1,
                        }),
                      ),
                    );
                  },
                }),
              ),
            ),
          ),
        );
        const summary = yield* provider.getChangeRequest({ cwd: repoDir, reference: mrUrl });
        expect(summary.isCrossRepository).toBe(true);
        expect(summary.headRepositoryNameWithOwner).toBeUndefined();
        calls.length = 0;
        const { manager } = yield* makeManager({ sourceControlProvider: provider });
        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: mrUrl,
          mode: "worktree",
        });
        expect(result.branch).toBe("t3code/pr-1/vc41-fork-feature");
        expect(result.worktreePath).not.toBeNull();
        const worktreePath = result.worktreePath ?? "";
        expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headCommit);
        expect(NodeFS.readFileSync(NodePath.join(worktreePath, "VC41.txt"), "utf8")).toBe(
          "fork head\n",
        );
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
        expect(calls).toHaveLength(1);
      }),
  );

  // A checkout whose origin is `originUrl`, and a fork pull request whose head branch, one commit
  // ahead of main, is served from a local bare repository wherever `forkUrl` points. The provider
  // answers each clone-URL lookup with `cloneUrl(lookup)`. GitLab lookups run the real glab
  // adapter against a glab whose `--hostname` rejects any ':', as the real one does.
  // glab selects hostname profiles, with API ports supplied by their configuration.
  const setUpForkPullRequest = (input: {
    readonly kind: "github" | "gitlab";
    readonly number: number;
    readonly pullRequestUrl: string;
    readonly originUrl: string;
    readonly headBranch: string;
    readonly headRepository: string;
    readonly forkUrl: string;
    readonly lookupNotFound?: boolean;
    readonly cloneUrl: (lookup: { readonly host?: string; readonly repository: string }) => string;
  }) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["checkout", "-b", input.headBranch]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "fork.txt"), "fork head\n");
      yield* runGit(repoDir, ["add", "fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Fork head"]);
      const headCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["push", forkDir, `HEAD:refs/heads/${input.headBranch}`]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", input.headBranch]);
      yield* runGit(repoDir, ["remote", "add", "origin", input.originUrl]);
      yield* servePullRequestRepository(repoDir, forkDir, input.forkUrl);
      const { service } = createGitHubCliWithFakeGh();
      const base = yield* GitHubSourceControlProvider.make.pipe(
        Effect.provide(Layer.succeed(GitHubCli.GitHubCli, service)),
      );
      const gitLab = yield* GitLabSourceControlProvider.make.pipe(
        Effect.provide(
          GitLabCli.layer.pipe(
            Layer.provide(
              Layer.mock(VcsProcess.VcsProcess)({
                run: (call) => {
                  if (call.args[0] === "config") {
                    expect(["user", "api_host"]).toContain(call.args[2]);
                    return Effect.succeed(fakeGhOutput(""));
                  }
                  if (input.lookupNotFound) {
                    return Effect.fail(
                      new VcsProcessExitError({
                        operation: call.operation,
                        command: call.command,
                        cwd: call.cwd,
                        exitCode: 1,
                        detail: "Not found on GitLab.",
                        failureKind: "not-found",
                      }),
                    );
                  }
                  const flag = call.args.indexOf("--hostname");
                  const flagHostname = flag === -1 ? undefined : (call.args[flag + 1] ?? "");
                  const hostname = call.env?.GITLAB_HOST ?? flagHostname;
                  if (flagHostname?.includes(":")) {
                    return Effect.fail(
                      new VcsProcessExitError({
                        operation: call.operation,
                        command: call.command,
                        cwd: call.cwd,
                        exitCode: 1,
                        detail: "error parsing --hostname: invalid hostname.",
                      }),
                    );
                  }
                  const repository = decodeURIComponent(
                    call.args[1]?.replace(/^projects\//, "") ?? "",
                  );
                  const url = input.cloneUrl({
                    ...(hostname === undefined ? {} : { host: hostname }),
                    repository,
                  });
                  return Effect.succeed(
                    fakeGhOutput(
                      encodeCliJson({
                        path_with_namespace: repository,
                        web_url: url,
                        http_url_to_repo: url,
                        ssh_url_to_repo: url,
                      }),
                    ),
                  );
                },
              }),
            ),
          ),
        ),
      );
      const provider: SourceControlProvider["Service"] = {
        ...base,
        kind: input.kind,
        getChangeRequest: () =>
          Effect.succeed({
            provider: input.kind,
            number: input.number,
            title: "Fork PR",
            url: input.pullRequestUrl,
            baseRefName: "main",
            headRefName: input.headBranch,
            state: "open" as const,
            isCrossRepository: true,
            headRepositoryNameWithOwner: input.headRepository,
            headRepositoryOwnerLogin: input.headRepository.split("/")[0] ?? "fork",
            updatedAt: Option.none(),
          }),
        getRepositoryCloneUrls:
          input.kind === "gitlab"
            ? gitLab.getRepositoryCloneUrls
            : (lookup) => {
                const url = input.cloneUrl(lookup);
                return Effect.succeed({ nameWithOwner: lookup.repository, url, sshUrl: url });
              },
        checkoutChangeRequest: () => Effect.die("A worktree checkout never runs the provider's"),
      };
      const { manager } = yield* makeManager({ sourceControlProvider: provider });
      return { repoDir, manager, headCommit };
    });

  // The URL of the remote the worktree's branch tracks, and the branch it tracks there.
  const readTracking = (cwd: string) =>
    Effect.gen(function* () {
      const branch = (yield* runGit(cwd, ["branch", "--show-current"])).stdout.trim();
      const remote = (yield* runGit(cwd, ["config", `branch.${branch}.remote`])).stdout.trim();
      return {
        url: (yield* runGit(cwd, ["config", `remote.${remote}.url`])).stdout.trim(),
        merge: (yield* runGit(cwd, ["config", `branch.${branch}.merge`])).stdout.trim(),
      };
    });

  it.effect("worktree PR checkout fetches an HTTP-only GitLab fork on origin's own server", () =>
    Effect.gen(function* () {
      const lookups: Array<string | undefined> = [];
      const { repoDir, manager, headCommit } = yield* setUpForkPullRequest({
        kind: "gitlab",
        number: 7,
        pullRequestUrl: "http://forge.example/team/repo/-/merge_requests/7",
        originUrl: "http://forge.example/team/repo.git",
        headBranch: "feature/http-fork",
        headRepository: "alex/repo",
        forkUrl: "http://forge.example/alex/repo",
        cloneUrl: (lookup) => {
          lookups.push(lookup.host);
          return "http://forge.example/alex/repo";
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "7",
        mode: "worktree",
      });

      expect(result.isTrackingPullRequestHead).toBe(true);
      const worktreePath = result.worktreePath ?? "";
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headCommit);
      expect(yield* readTracking(worktreePath)).toEqual({
        url: "http://forge.example/alex/repo",
        merge: "refs/heads/feature/http-fork",
      });
      expect(lookups.length).toBeGreaterThan(0);
      expect(lookups.every((host) => host === "forge.example")).toBe(true);
    }),
  );

  it.effect("worktree PR checkout tracks the head on its own HTTPS port, not origin's", () =>
    Effect.gen(function* () {
      const lookups: Array<string | undefined> = [];
      const { repoDir, manager, headCommit } = yield* setUpForkPullRequest({
        kind: "gitlab",
        number: 8,
        pullRequestUrl: "https://forge.example:8443/team/repo/-/merge_requests/8",
        // Never fetched: a remote picked by path alone would fail to reach this server.
        originUrl: "https://forge.example:9443/team/repo.git",
        headBranch: "feature/port-head",
        headRepository: "team/repo",
        forkUrl: "https://forge.example:8443/team/repo.git",
        cloneUrl: (lookup) => {
          lookups.push(lookup.host);
          return "https://forge.example:8443/team/repo.git";
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "8",
        mode: "worktree",
      });

      const worktreePath = result.worktreePath ?? "";
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headCommit);
      expect(yield* readTracking(worktreePath)).toEqual({
        url: "https://forge.example:8443/team/repo.git",
        merge: "refs/heads/feature/port-head",
      });
      expect(result.isTrackingPullRequestHead).toBe(true);
      expect(lookups.length).toBeGreaterThan(0);
      expect(lookups.every((host) => host === "forge.example")).toBe(true);
    }),
  );

  it.effect.each([
    { host: "gitlab.com", returned: "gitlab.corp.example" },
    { host: "forge.example:8443", returned: "forge.example:9443" },
  ])("refuses a GitLab fork on $returned when the MR belongs to $host", ({ host, returned }) =>
    Effect.gen(function* () {
      const forkUrl = `https://${returned}/alex/repo.git`;
      const { repoDir, manager } = yield* setUpForkPullRequest({
        kind: "gitlab",
        number: 18,
        pullRequestUrl: `https://${host}/team/repo/-/merge_requests/18`,
        originUrl: "https://gitlab.corp.example/team/repo.git",
        headBranch: "feature/wrong-host-fork",
        headRepository: "alex/repo",
        forkUrl,
        cloneUrl: () => forkUrl,
      });
      const error = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "18",
        mode: "worktree",
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "SourceControlProviderError",
        provider: "gitlab",
        operation: "getRepositoryCloneUrls",
        detail:
          "GitLab returned a repository on a different host. Check the glab host profile and retry.",
      });
      expect((yield* runGit(repoDir, ["remote"])).stdout.trim()).toBe("origin");
      expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
      expect((yield* runGit(repoDir, ["for-each-ref", "refs/remotes/alex"])).stdout.trim()).toBe(
        "",
      );
    }),
  );

  it.effect("surfaces a GitLab private-fork login hint without falling back to origin", () =>
    Effect.gen(function* () {
      const host = "gitlab-missing.example";
      const { repoDir, manager } = yield* setUpForkPullRequest({
        kind: "gitlab",
        number: 19,
        pullRequestUrl: `https://${host}/team/repo/-/merge_requests/19`,
        originUrl: `https://${host}/team/repo.git`,
        headBranch: "feature/private-fork",
        headRepository: "alex/repo",
        forkUrl: `https://${host}/alex/repo.git`,
        cloneUrl: () => `https://${host}/alex/repo.git`,
        lookupNotFound: true,
      });
      const error = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "19",
        mode: "worktree",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("SourceControlProviderError");
      expect(error.message).toContain("Repository not found or inaccessible on GitLab.");
      expect(error.message).toContain(`glab auth login --hostname ${host}`);
      expect((yield* runGit(repoDir, ["remote"])).stdout.trim()).toBe("origin");
      expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe("main");
    }),
  );

  // Without a host `gh repo view` answers for github.com, where a same-named fork holds other work.
  it.effect("worktree PR checkout looks the fork up on the pull request's own GitHub host", () =>
    Effect.gen(function* () {
      const lookups: Array<string | undefined> = [];
      const { repoDir, manager, headCommit } = yield* setUpForkPullRequest({
        kind: "github",
        number: 9,
        pullRequestUrl: "https://github.example:8443/team/repo/pull/9",
        originUrl: "https://github.example:8443/team/repo.git",
        headBranch: "feature/enterprise-fork",
        headRepository: "alex/repo",
        forkUrl: "https://github.example:8443/alex/repo.git",
        cloneUrl: (lookup) => {
          lookups.push(lookup.host);
          return `https://${lookup.host ?? "github.com"}/alex/repo.git`;
        },
      });
      const publicForkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["checkout", "-b", "public"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "public.txt"), "someone else's work\n");
      yield* runGit(repoDir, ["add", "public.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Public fork"]);
      yield* runGit(repoDir, ["push", publicForkDir, "HEAD:refs/heads/feature/enterprise-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* servePullRequestRepository(repoDir, publicForkDir, "https://github.com/alex/repo.git");

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "9",
        mode: "worktree",
      });

      const worktreePath = result.worktreePath ?? "";
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(headCommit);
      expect((yield* readTracking(worktreePath)).url).toBe(
        "https://github.example:8443/alex/repo.git",
      );
      expect(lookups.length).toBeGreaterThan(0);
      expect(lookups.every((host) => host === "github.example:8443")).toBe(true);
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "derived-fork.txt"), "derived fork\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "existing.txt"), "existing\n");
      yield* runGit(repoDir, ["add", "existing.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Existing worktree branch"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-existing-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-existing-worktree"]);

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
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

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
      );
      expect(result.branch).toBe("feature/pr-existing-worktree");
      // Nothing to fetch from, so the checkout keeps the commit it had and setup stays out of a
      // worktree another thread may be sitting in.
      expect(setupCalls).toHaveLength(0);
      expect(result.isOnPullRequestHead).toBe(false);
    }),
  );

  it.effect("refreshes a reused PR worktree onto the updated pull request head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* servePullRequestRepository(repoDir, remoteDir);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-stale"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "stale.txt"), "stale\n");
      yield* runGit(repoDir, ["add", "stale.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused stale PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-reused-stale"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-reused-stale-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-reused-stale"]);

      yield* runGit(repoDir, ["checkout", "-b", "author-push", "origin/feature/pr-reused-stale"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "authored.txt"), "authored\n");
      yield* runGit(repoDir, ["add", "authored.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "New PR head commit"]);
      yield* runGit(repoDir, ["push", "origin", "author-push:feature/pr-reused-stale"]);
      const updatedHead = (yield* runGit(repoDir, ["rev-parse", "author-push"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 84,
            title: "Reused stale PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/84",
            baseRefName: "main",
            headRefName: "feature/pr-reused-stale",
            state: "open",
          },
          repositoryCloneUrls: pullRequestRepositoryCloneUrls,
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "84",
        mode: "worktree",
      });

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
      );
      expect(result.branch).toBe("feature/pr-reused-stale");
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(updatedHead);
    }),
  );

  it.effect("warns without Git's output when a reused PR worktree cannot be refreshed", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* servePullRequestRepository(repoDir, remoteDir);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-locked"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "stale.txt"), "stale\n");
      yield* runGit(repoDir, ["add", "stale.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused stale PR branch"]);
      const staleHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-reused-locked"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-reused-locked-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-reused-locked"]);
      yield* runGit(repoDir, ["checkout", "-b", "author-push", "origin/feature/pr-reused-locked"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "authored.txt"), "authored\n");
      yield* runGit(repoDir, ["add", "authored.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "New PR head commit"]);
      yield* runGit(repoDir, ["push", "origin", "author-push:feature/pr-reused-locked"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      // A stale ref lock, as a crashed Git leaves behind: the fast-forward itself fails.
      NodeFS.writeFileSync(
        NodePath.join(repoDir, ".git", "refs", "heads", "feature", "pr-reused-locked.lock"),
        "",
      );

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 85,
            title: "Reused locked PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/85",
            baseRefName: "main",
            headRefName: "feature/pr-reused-locked",
            state: "open",
          },
          repositoryCloneUrls: pullRequestRepositoryCloneUrls,
        },
      });
      const logs: Array<ReadonlyArray<unknown>> = [];
      const logger = Logger.make<unknown, void>(({ message }) => {
        logs.push(Array.isArray(message) ? message : [message]);
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "85",
        mode: "worktree",
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));

      expect(result.isOnPullRequestHead).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(staleHead);
      const warning = logs.find((parts) =>
        String(parts[0]).includes("reused worktree refresh failed"),
      );
      expect(warning?.[1]).toMatchObject({
        localBranch: "feature/pr-reused-locked",
        operation: "GitVcsDriver.refreshCheckedOutBranch.move",
      });
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      expect(JSON.stringify(warning)).not.toContain(".lock");
    }),
  );

  it.effect("runs the setup script when a reused PR worktree moves onto the new head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* servePullRequestRepository(repoDir, remoteDir);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-setup"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "reused-setup.txt"), "reused setup\n");
      yield* runGit(repoDir, ["add", "reused-setup.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused setup PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-reused-setup"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-reused-setup-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-reused-setup"]);

      yield* runGit(repoDir, ["checkout", "-b", "setup-author-push", "feature/pr-reused-setup"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "reused-setup.txt"), "reused setup again\n");
      yield* runGit(repoDir, ["add", "reused-setup.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "New reused setup head"]);
      yield* runGit(repoDir, ["push", "origin", "setup-author-push:feature/pr-reused-setup"]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 85,
            title: "Reused setup PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/85",
            baseRefName: "main",
            headRefName: "feature/pr-reused-setup",
            state: "open",
          },
          repositoryCloneUrls: pullRequestRepositoryCloneUrls,
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
        reference: "85",
        mode: "worktree",
        threadId: asThreadId("thread-pr-reused-setup"),
      });

      expect(setupCalls).toHaveLength(1);
      expect(setupCalls[0]).toEqual({
        threadId: "thread-pr-reused-setup",
        projectCwd: repoDir,
        worktreePath: result.worktreePath as string,
      });
      expect(result.isOnPullRequestHead).toBe(true);
    }),
  );

  it.effect("leaves the setup script alone when a reused PR worktree is already on the head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* servePullRequestRepository(repoDir, remoteDir);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-reused-current"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "reused-current.txt"), "reused current\n");
      yield* runGit(repoDir, ["add", "reused-current.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused current PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-reused-current"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-reused-current-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-reused-current"]);
      const currentHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 95,
            title: "Reused current PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/95",
            baseRefName: "main",
            headRefName: "feature/pr-reused-current",
            state: "open",
          },
          repositoryCloneUrls: pullRequestRepositoryCloneUrls,
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
        reference: "95",
        mode: "worktree",
        threadId: asThreadId("thread-pr-reused-current"),
      });

      expect(result.isOnPullRequestHead).toBe(true);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(currentHead);
      expect(setupCalls).toHaveLength(0);
    }),
  );

  it.effect("resets a clean reused PR worktree onto a force-pushed pull request head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* servePullRequestRepository(repoDir, remoteDir);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-force-pushed"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "force-pushed.txt"), "first\n");
      yield* runGit(repoDir, ["add", "force-pushed.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Force-pushed PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-force-pushed"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-force-pushed-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-force-pushed"]);
      const staleHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      yield* runGit(repoDir, ["checkout", "-b", "author-rewrite", "feature/pr-force-pushed"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "force-pushed.txt"), "rewritten\n");
      yield* runGit(repoDir, ["add", "force-pushed.txt"]);
      yield* runGit(repoDir, ["commit", "--amend", "-m", "Rewritten PR head"]);
      yield* runGit(repoDir, [
        "push",
        "--force",
        "origin",
        "author-rewrite:feature/pr-force-pushed",
      ]);
      const rewrittenHead = (yield* runGit(repoDir, ["rev-parse", "author-rewrite"])).stdout.trim();
      // Pushing from this clone also advanced its remote-tracking ref. A head rewritten by the
      // author leaves that ref behind, which is the state a reused worktree is really opened in.
      yield* runGit(repoDir, [
        "update-ref",
        "refs/remotes/origin/feature/pr-force-pushed",
        staleHead,
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 86,
            title: "Force-pushed PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/86",
            baseRefName: "main",
            headRefName: "feature/pr-force-pushed",
            state: "open",
          },
          repositoryCloneUrls: pullRequestRepositoryCloneUrls,
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "86",
        mode: "worktree",
      });

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
      );
      expect(result.isOnPullRequestHead).toBe(true);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
        rewrittenHead,
      );
      expect(NodeFS.readFileSync(NodePath.join(worktreePath, "force-pushed.txt"), "utf8")).toBe(
        "rewritten\n",
      );
    }),
  );

  it.effect("keeps a reused PR worktree that carries its own commit off the rewritten head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-local-commit"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "local-commit.txt"), "first\n");
      yield* runGit(repoDir, ["add", "local-commit.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Local commit PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-local-commit"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-local-commit-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-local-commit"]);
      const upstreamHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      yield* runGit(repoDir, ["checkout", "-b", "local-commit-rewrite", "feature/pr-local-commit"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "local-commit.txt"), "rewritten\n");
      yield* runGit(repoDir, ["add", "local-commit.txt"]);
      yield* runGit(repoDir, ["commit", "--amend", "-m", "Rewritten local commit head"]);
      yield* runGit(repoDir, [
        "push",
        "--force",
        "origin",
        "local-commit-rewrite:feature/pr-local-commit",
      ]);
      yield* runGit(repoDir, [
        "update-ref",
        "refs/remotes/origin/feature/pr-local-commit",
        upstreamHead,
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);

      // The work that must survive: a commit made in the worktree, on top of the stale head.
      NodeFS.writeFileSync(NodePath.join(worktreePath, "thread-work.txt"), "thread work\n");
      yield* runGit(worktreePath, ["add", "thread-work.txt"]);
      yield* runGit(worktreePath, ["commit", "-m", "Work done in the reused worktree"]);
      const worktreeHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 87,
            title: "Local commit PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/87",
            baseRefName: "main",
            headRefName: "feature/pr-local-commit",
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
        reference: "87",
        mode: "worktree",
        threadId: asThreadId("thread-pr-local-commit"),
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(worktreeHead);
      expect(NodeFS.existsSync(NodePath.join(worktreePath, "thread-work.txt"))).toBe(true);
      expect(setupCalls).toHaveLength(0);
    }),
  );

  it.effect("keeps a dirty reused PR worktree off the rewritten pull request head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-dirty-worktree"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "dirty.txt"), "first\n");
      yield* runGit(repoDir, ["add", "dirty.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Dirty worktree PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/pr-dirty-worktree"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-dirty-worktree-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/pr-dirty-worktree"]);
      const staleHead = (yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();

      yield* runGit(repoDir, ["checkout", "-b", "dirty-rewrite", "feature/pr-dirty-worktree"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "dirty.txt"), "rewritten\n");
      yield* runGit(repoDir, ["add", "dirty.txt"]);
      yield* runGit(repoDir, ["commit", "--amend", "-m", "Rewritten dirty head"]);
      yield* runGit(repoDir, [
        "push",
        "--force",
        "origin",
        "dirty-rewrite:feature/pr-dirty-worktree",
      ]);
      yield* runGit(repoDir, [
        "update-ref",
        "refs/remotes/origin/feature/pr-dirty-worktree",
        staleHead,
      ]);
      yield* runGit(repoDir, ["checkout", "main"]);

      NodeFS.writeFileSync(NodePath.join(worktreePath, "dirty.txt"), "uncommitted edit\n");

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 89,
            title: "Dirty worktree PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/89",
            baseRefName: "main",
            headRefName: "feature/pr-dirty-worktree",
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
        reference: "89",
        mode: "worktree",
        threadId: asThreadId("thread-pr-dirty-worktree"),
      });

      expect(result.isOnPullRequestHead).toBe(false);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(staleHead);
      expect(NodeFS.readFileSync(NodePath.join(worktreePath, "dirty.txt"), "utf8")).toBe(
        "uncommitted edit\n",
      );
      expect(setupCalls).toHaveLength(0);
    }),
  );

  it.effect("refreshes a reused PR worktree that has no upstream from the pull request ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/pr-ref-only"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "ref-only.txt"), "ref only\n");
      yield* runGit(repoDir, ["add", "ref-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Pull ref only PR branch"]);
      // The head lives at refs/pull/90/head and nowhere else, so nothing can be tracked.
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/90/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/pr-ref-only"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "https://github.com/pingdotgg/codething-mvp.git",
        remoteDir,
      );

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 90,
            title: "Pull ref only PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/90",
            baseRefName: "main",
            headRefName: "feature/pr-ref-only",
            state: "open",
          },
          repositoryCloneUrls: pullRequestRepositoryCloneUrls,
        },
      });

      const created = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "90",
        mode: "worktree",
      });
      const worktreePath = created.worktreePath as string;
      expect(
        (yield* runGit(worktreePath, ["rev-parse", "--abbrev-ref", "@{upstream}"], true)).exitCode,
      ).not.toBe(0);

      yield* runGit(repoDir, ["fetch", "origin", "refs/pull/90/head"]);
      yield* runGit(repoDir, ["checkout", "-b", "ref-only-author", "FETCH_HEAD"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "ref-only.txt"), "ref only again\n");
      yield* runGit(repoDir, ["add", "ref-only.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "New pull ref head"]);
      yield* runGit(repoDir, ["push", "origin", "ref-only-author:refs/pull/90/head"]);
      const updatedHead = (yield* runGit(repoDir, ["rev-parse", "ref-only-author"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "90",
        mode: "worktree",
      });

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
      );
      expect(result.isOnPullRequestHead).toBe(true);
      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(updatedHead);
    }),
  );

  it.effect("leaves a reused PR worktree alone when its upstream is all that names a head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/right-pr"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "right.txt"), "wanted PR\n");
      yield* runGit(repoDir, ["add", "right.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Wanted PR"]);
      const wanted = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      // origin's same-named branch is somebody else's descendant of it.
      yield* runGit(repoDir, ["checkout", "-b", "unrelated"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "wrong.txt"), "unrelated\n");
      yield* runGit(repoDir, ["add", "wrong.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Unrelated descendant"]);
      yield* runGit(repoDir, ["push", "origin", "unrelated:refs/heads/feature/right-pr"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["fetch", "origin"]);
      yield* runGit(repoDir, [
        "branch",
        "--set-upstream-to=origin/feature/right-pr",
        "feature/right-pr",
      ]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-upstream-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", worktreePath, "feature/right-pr"]);

      // The provider cannot report a URL for the pull request's repository.
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 199,
            title: "Upstream-only PR",
            url: "https://github.com/upstream/repo/pull/199",
            baseRefName: "main",
            headRefName: "feature/right-pr",
            state: "open",
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "199",
        mode: "worktree",
      });

      expect((yield* runGit(worktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(wanted);
      expect(result.isOnPullRequestHead).toBe(false);
    }),
  );

  it.effect("never moves an unrelated local branch that shares the fork head branch name", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "fork-main-collision"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "contributor.txt"), "contributor\n");
      yield* runGit(repoDir, ["add", "contributor.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Contributor commit on the fork main"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "fork-main-collision:main"]);
      // The user's own main, checked out in its own worktree and behind the fork's main: a
      // fast-forward would land the contributor's commits in it.
      yield* runGit(repoDir, ["checkout", "-b", "feature/root-work", "main"]);
      const mainWorktreePath = NodePath.join(
        repoDir,
        "..",
        `local-main-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", mainWorktreePath, "main"]);
      const localMainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();

      const setupCalls: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 94,
            title: "Fork main collision PR",
            url: "https://github.com/pingdotgg/codething-mvp/pull/94",
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
        reference: "94",
        mode: "worktree",
        threadId: asThreadId("thread-pr-fork-main-collision"),
      });

      expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(localMainBefore);
      expect((yield* runGit(mainWorktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
        localMainBefore,
      );
      expect(NodeFS.existsSync(NodePath.join(mainWorktreePath, "contributor.txt"))).toBe(false);
      expect(result.isOnPullRequestHead).toBe(false);
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
        NodeFS.writeFileSync(NodePath.join(repoDir, "fork-main.txt"), "fork main\n");
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
        NodeFS.writeFileSync(NodePath.join(repoDir, "fork-main-second.txt"), "fork main second\n");
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "reused-fork.txt"), "reused fork\n");
      yield* runGit(repoDir, ["add", "reused-fork.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Reused fork PR branch"]);
      yield* runGit(repoDir, ["push", "-u", "fork-seed", "feature/pr-reused-fork"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      const worktreePath = NodePath.join(
        repoDir,
        "..",
        `pr-reused-fork-${NodePath.basename(repoDir)}`,
      );
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

      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(worktreePath),
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "setup-failure.txt"), "setup failure\n");
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
          runForThread: (input) =>
            Effect.fail(
              new ProjectSetupScriptRunner.ProjectSetupScriptOperationError({
                threadId: input.threadId,
                worktreePath: input.worktreePath,
                operation: "openTerminal",
                cause: new Error("terminal start failed"),
              }),
            ),
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
      expect(NodeFS.existsSync(result.worktreePath as string)).toBe(true);
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "hooked.txt"), "hooked\n");
      NodeFS.writeFileSync(
        NodePath.join(repoDir, ".git", "hooks", "pre-commit"),
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "hook-failure.txt"), "broken\n");
      NodeFS.writeFileSync(
        NodePath.join(repoDir, ".git", "hooks", "pre-commit"),
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

      expect(errorMessage).toContain("Git command failed in GitVcsDriver.commit.commit");
      expect(errorMessage).not.toContain("hook: fail");
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "hook_started",
            hookName: "pre-commit",
          }),
          expect.objectContaining({
            kind: "hook_output",
            text: "hook: fail",
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
      NodeFS.writeFileSync(NodePath.join(repoDir, "pr-only.txt"), "pr only\n");
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
