import { SourceControlProviderKind } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcessSpawner } from "effect/process";
import { expect } from "vite-plus/test";
import type {
  ChangeRequest,
  GitActionProgressEvent,
  GitPreparePullRequestThreadInput,
  ModelSelection,
} from "@t3tools/contracts";

import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  SourceControlProviderError as SourceControlProviderFailure,
  TextGenerationError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { decodeGitHubPullRequestListJson } from "@t3tools/source-control-github/server/gitHubPullRequests";
import * as GitHubChangeRequestTemplate from "@t3tools/source-control-github/server/gitHubChangeRequestTemplate";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as GitLabCli from "@t3tools/source-control-gitlab/server/GitLabCli";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  fromRunner,
  decodeJsonReply,
} from "@t3tools/provider-core/server/textGenerationOperations";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ForgejoSourceControlProvider from "@t3tools/source-control-forgejo/server/ForgejoSourceControlProvider";
import * as GitLabSourceControlProvider from "@t3tools/source-control-gitlab/server/GitLabSourceControlProvider";
import {
  ForgejoPullRequestSchema,
  toForgejoChangeRequest,
} from "@t3tools/source-control-forgejo/server/forgejoPullRequests";
import type { SourceControlProvider } from "@t3tools/source-control-core/server/SourceControlProvider";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
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
    headSha?: string;
  };
  repositoryCloneUrls?: Record<string, { url: string; sshUrl: string }>;
  failWith?: string;
  failCause?: unknown;
  failAfterCalls?: number;
  /** Check out the pull request head the way gh does: fast-forward only unless forced. */
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

type FakePullRequestSummary = Omit<ChangeRequest, "provider" | "state" | "updatedAt"> & {
  readonly state?: ChangeRequest["state"];
  readonly updatedAt?: string;
};

function normalizeFakePullRequestSummary(raw: unknown): FakePullRequestSummary | null {
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
    // Hermetic line endings: machine-global `core.autocrlf=true` on Windows
    // makes Git check out CRLF, which breaks exact-content assertions that
    // write LF with Node. Local config overrides the global so the fixture
    // (and its linked worktrees, which share config) always checks out LF.
    yield* runGit(cwd, ["config", "core.autocrlf", "false"]);
    yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

const makeGitLabTemplateProvider = Effect.fnUntraced(function* () {
  const git = yield* GitVcsDriver.GitVcsDriver;
  return yield* GitLabSourceControlProvider.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(GitLabCli.GitLabCli)({}),
        TestSourceControlHost.layer({ git: { execute: git.execute } }),
      ),
    ),
  );
});

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
    generateReviewGuide: () => Effect.succeed({ stops: [] }),
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
    generateReviewGuide: (input) => implementation.generateReviewGuide(input),
  };
}

function createGitHubProviderWithFakeGh(scenario: FakeGhScenario = {}): {
  service: SourceControlProvider["Service"];
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

  const fail = (cwd: string, detail: string, cause?: unknown, operation = "fakeGh") =>
    new SourceControlProviderFailure({
      provider: SourceControlProviderKind.make("github"),
      operation,
      cwd,
      detail,
      cause,
    });

  const execute = (input: {
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly operation: string;
  }): Effect.Effect<VcsProcess.VcsProcessOutput, SourceControlProviderFailure> => {
    const args = [...input.args];
    ghCalls.push(args.join(" "));

    if (scenario.failWith && ghCalls.length > (scenario.failAfterCalls ?? 0)) {
      return Effect.fail(fail(input.cwd, scenario.failWith, scenario.failCause, input.operation));
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
            runGitSyncForFakeGh(input.cwd, [
              "fetch",
              "origin",
              `refs/pull/${scenario.pullRequest?.number}/head`,
            ]);
            const existingBranch = NodeChildProcess.spawnSync(
              "git",
              ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
              { cwd: input.cwd },
            );
            if (existingBranch.status === 0) {
              runGitSyncForFakeGh(input.cwd, ["checkout", headBranch]);
              runGitSyncForFakeGh(
                input.cwd,
                args.includes("--force")
                  ? ["reset", "--hard", "FETCH_HEAD"]
                  : ["merge", "--ff-only", "FETCH_HEAD"],
              );
            } else {
              runGitSyncForFakeGh(input.cwd, ["checkout", "-b", headBranch, "FETCH_HEAD"]);
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
        catch: (error) => fail(input.cwd, "GitHub request failed.", error),
      });
    }

    if (args[0] === "repo" && args[1] === "view") {
      const repository = args[2];
      if (typeof repository === "string" && args.includes("nameWithOwner,url,sshUrl")) {
        const cloneUrls = scenario.repositoryCloneUrls?.[repository];
        if (!cloneUrls) {
          return Effect.fail(fail(input.cwd, `Unexpected repository lookup: ${repository}`));
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

    return Effect.fail(fail(input.cwd, `Unexpected gh command: ${args.join(" ")}`));
  };

  const toChangeRequest = (summary: FakePullRequestSummary): ChangeRequest => ({
    ...summary,
    provider: SourceControlProviderKind.make("github"),
    state: summary.state ?? "open",
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt:
      summary.updatedAt === undefined
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(summary.updatedAt)),
  });

  return {
    service: {
      kind: SourceControlProviderKind.make("github"),
      headBranchProbe: ({ headSelectors }) => ({
        headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
        limit: 100,
      }),

      listChangeRequests: (input) =>
        input.state === "open"
          ? execute({
              operation: "listChangeRequests",
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
                  .filter((entry): entry is FakePullRequestSummary => entry !== null)
                  .map(toChangeRequest),
              ),
            )
          : execute({
              operation: "listChangeRequests",
              cwd: input.cwd,
              args: [
                "pr",
                "list",
                "--head",
                input.headSelector,
                "--state",
                input.state,
                "--limit",
                String(input.limit ?? 20),
                "--json",
                "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
              ],
            }).pipe(
              Effect.map((result) => {
                const raw = result.stdout.trim();
                if (raw.length === 0) return [];
                const decoded = decodeGitHubPullRequestListJson(raw);
                return Result.isSuccess(decoded)
                  ? decoded.success.map((record) => ({
                      provider: SourceControlProviderKind.make("github"),
                      ...record,
                    }))
                  : [];
              }),
            ),
      createChangeRequest: (input) =>
        execute({
          operation: "createChangeRequest",
          cwd: input.cwd,
          args: [
            "pr",
            "create",
            "--base",
            input.baseRefName,
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
          operation: "getDefaultBranch",
          cwd: input.cwd,
          args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
        }).pipe(
          Effect.map((result) => {
            const value = result.stdout.trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getChangeRequest: (input) =>
        execute({
          operation: "getChangeRequest",
          cwd: input.cwd,
          args: [
            "pr",
            "view",
            input.reference,
            "--json",
            "number,title,url,baseRefName,headRefName,state,isDraft,mergedAt,closedAt,isCrossRepository,headRepository,headRepositoryOwner",
          ],
        }).pipe(
          Effect.map((result) =>
            toChangeRequest(JSON.parse(result.stdout) as FakePullRequestSummary),
          ),
        ),
      getRepositoryCloneUrls: (input) =>
        execute({
          operation: "getRepositoryCloneUrls",
          cwd: input.cwd,
          args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
        }).pipe(Effect.map((result) => JSON.parse(result.stdout))),
      createRepository: (input) =>
        Effect.fail(fail(input.cwd, `Unexpected repository create: ${input.repository}`)),
      checkoutChangeRequest: (input) =>
        execute({
          operation: "checkoutChangeRequest",
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
  gitCommands?: string[];
  environment?: NodeJS.ProcessEnv;
  gitSpawnGate?: {
    readonly matches: (args: ReadonlyArray<string>) => boolean;
    readonly reached: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
  seed?: Effect.Effect<
    void,
    ProjectionStore.ProjectionStoreV2Error | ProjectStore.ProjectStoreV2Error,
    ProjectionStore.ProjectionStoreV2 | ProjectStore.ProjectStoreV2
  >;
}) {
  const { service: fakeGitHubProvider, ghCalls } = createGitHubProviderWithFakeGh(
    input?.ghScenario,
  );
  const textGeneration = createTextGeneration(input?.textGeneration);
  const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-git-manager-test-",
  });

  const layerServerSettings = ServerSettings.ServerSettingsService.layerTest(input?.serverSettings);

  const gitCommands = input?.gitCommands;
  const gitSpawnGate = input?.gitSpawnGate;
  const watchesGitSpawns = gitCommands !== undefined || gitSpawnGate !== undefined;
  const layerGitDriverSpawner = watchesGitSpawns
    ? Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) => {
            // On Windows the driver starts git by its full path to git.exe.
            const args =
              command._tag === "StandardCommand" &&
              NodePath.parse(command.command).name.toLowerCase() === "git"
                ? command.args
                : null;
            if (args !== null) gitCommands?.push(args.join(" "));
            if (args === null || gitSpawnGate === undefined || !gitSpawnGate.matches(args)) {
              return spawner.spawn(command);
            }
            return spawner
              .spawn(command)
              .pipe(
                Effect.tap((handle) =>
                  handle.exitCode.pipe(
                    Effect.andThen(Deferred.succeed(gitSpawnGate.reached, undefined)),
                    Effect.andThen(Deferred.await(gitSpawnGate.release)),
                  ),
                ),
              );
          });
        }),
      ).pipe(Layer.provide(NodeServices.layer))
    : Layer.empty;
  const gitVcsDriver = input?.gitConfigReads
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
      )
    : GitVcsDriver.layer;
  const layerVcsDriver = (watchesGitSpawns ? Layer.fresh(gitVcsDriver) : gitVcsDriver).pipe(
    Layer.provide(layerGitDriverSpawner),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(layerServerConfig),
  );
  const layerSourceControlRegistry = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    Effect.gen(function* () {
      const git = yield* GitVcsDriver.GitVcsDriver;
      return (
        input?.sourceControlProvider ?? {
          ...fakeGitHubProvider,
          readChangeRequestTemplate: ({ cwd, treeish }: { cwd: string; treeish: string }) =>
            GitHubChangeRequestTemplate.detect(cwd, treeish, git.execute),
        }
      );
    }).pipe(
      Effect.map((provider) =>
        SourceControlProviderRegistry.SourceControlProviderRegistry.of({
          resolveLink: (input) => provider.resolveLink?.(input),
          get: () => Effect.succeed(provider),
          resolveHandle: () => Effect.succeed({ provider, context: null }),
          resolve: () => Effect.succeed(provider),
          discover: Effect.succeed([]),
        }),
      ),
    ),
  );

  const layerManager = Layer.mergeAll(
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
    layerServerSettings,
  ).pipe(
    Layer.provideMerge(layerSourceControlRegistry),
    Layer.provideMerge(layerVcsDriver),
    Layer.provideMerge(NodeServices.layer),
  );
  const layerStores = Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  return Effect.gen(function* () {
    const stores = yield* Layer.build(layerStores);
    if (input?.seed !== undefined) {
      yield* input.seed.pipe(Effect.provideContext(stores), Effect.orDie);
    }
    const manager = yield* GitManager.make.pipe(
      Effect.provideService(HostProcess.Environment, input?.environment ?? {}),
      Effect.provide(layerManager),
      Effect.provideContext(stores),
    );
    return { manager, ghCalls };
  });
}

const asThreadId = (threadId: string) => threadId as ThreadId;

const layerGitManagerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-manager-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layerGitManagerTest)("GitManager", (it) => {
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

  it.effect("a git read in flight during a T3 git action does not outlive it", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/racing-upstream"]);
      yield* runGit(repoDir, ["push", "-u", "origin", "feature/racing-upstream"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/heads/feature/raced-head"]);
      const pullRequest = (number: number, headRefName: string) =>
        encodeCliJson([
          {
            number,
            title: headRefName,
            url: `https://github.com/pingdotgg/codething-mvp/pull/${number}`,
            baseRefName: "main",
            headRefName,
            state: "OPEN",
            updatedAt: "2026-04-07T15:00:00Z",
          },
        ]);
      const gate = {
        matches: (args: ReadonlyArray<string>) =>
          args[0] === "for-each-ref" && args.at(-1) === "refs/heads/feature/racing-upstream",
        reached: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const { manager } = yield* makeManager({
        gitSpawnGate: gate,
        ghScenario: {
          prListByHeadSelector: {
            "feature/racing-upstream": pullRequest(237, "feature/racing-upstream"),
            "feature/raced-head": pullRequest(238, "feature/raced-head"),
          },
        },
      });
      const lookup = manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/racing-upstream",
      });

      const inFlight = yield* Effect.forkChild(lookup);
      yield* Deferred.await(gate.reached);
      yield* runGit(repoDir, ["branch", "--set-upstream-to=origin/feature/raced-head"]);
      yield* manager.invalidateStatus(repoDir);
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(inFlight);

      expect((yield* lookup)?.number).toBe(238);
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
            JSON.stringify([
              {
                number: 216,
                title: "Saved branch PR",
                url: "https://github.com/pingdotgg/t3code/pull/216",
                baseRefName: "main",
                headRefName: "feature/saved-branch",
                headRefOid: "a".repeat(40),
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
        headSha: "a".repeat(40),
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
      yield* runGit(remoteDir, ["--git-dir=.", "symbolic-ref", "HEAD", "refs/heads/develop"]);
      yield* runGit(repoDir, ["remote", "set-head", "upstream", "develop"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
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

  it.effect("finds a fork PR for a branch pushed without an upstream", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/no-upstream-fork"]);
      yield* runGit(repoDir, ["push", "fork", "feature/no-upstream-fork"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const ghScenario = {
        prListByHeadSelector: {
          "feature/no-upstream-fork": JSON.stringify([
            {
              number: 40,
              title: "Another fork's PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/40",
              baseRefName: "main",
              headRefName: "feature/no-upstream-fork",
              state: "OPEN",
              isCrossRepository: true,
              headRepository: { nameWithOwner: "someone-else/codething-mvp" },
              headRepositoryOwner: { login: "someone-else" },
            },
            {
              number: 41,
              title: "Our fork's PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/41",
              baseRefName: "main",
              headRefName: "feature/no-upstream-fork",
              state: "OPEN",
              isCrossRepository: true,
              headRepository: { nameWithOwner: "contributor/codething-mvp" },
              headRepositoryOwner: { login: "contributor" },
            },
          ]),
        },
      };
      const { manager } = yield* makeManager({ ghScenario });

      const pullRequest = yield* manager.branchPullRequest({
        cwd: repoDir,
        branch: "feature/no-upstream-fork",
      });
      expect(pullRequest?.number).toBe(41);
      expect((yield* manager.status({ cwd: repoDir })).pr?.number).toBe(41);

      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "Continue feature"]);
      const localHead = yield* runGit(repoDir, ["rev-parse", "HEAD"]);
      const pushedHead = yield* runGit(repoDir, [
        "rev-parse",
        "refs/remotes/fork/feature/no-upstream-fork",
      ]);
      expect(localHead.stdout.trim()).not.toBe(pushedHead.stdout.trim());
      const { manager: aheadManager } = yield* makeManager({ ghScenario });
      expect(
        (yield* aheadManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/no-upstream-fork",
        }))?.number,
      ).toBe(41);
      expect((yield* aheadManager.status({ cwd: repoDir })).pr?.number).toBe(41);

      yield* runGit(repoDir, ["config", "branch.feature/no-upstream-fork.remote", "origin"]);
      const upstream = yield* runGit(repoDir, [
        "for-each-ref",
        "--format=%(upstream:short)",
        "refs/heads/feature/no-upstream-fork",
      ]);
      expect(upstream.stdout.trim()).toBe("");
      const { manager: staleRemoteManager } = yield* makeManager({ ghScenario });
      expect(
        (yield* staleRemoteManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/no-upstream-fork",
        }))?.number,
      ).toBe(41);

      yield* runGit(repoDir, ["config", "--unset", "branch.feature/no-upstream-fork.remote"]);
      yield* runGit(repoDir, ["checkout", "-b", "diverged-push", "main"]);
      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "Rewrite fork head"]);
      yield* runGit(repoDir, [
        "push",
        "--force",
        "fork",
        "HEAD:refs/heads/feature/no-upstream-fork",
      ]);
      yield* runGit(repoDir, ["checkout", "feature/no-upstream-fork"]);
      const { manager: divergedManager } = yield* makeManager({ ghScenario });
      expect(
        yield* divergedManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/no-upstream-fork",
        }),
      ).toBeNull();
    }),
  );

  it.effect("prefers an exact fork ref but does not guess between equal refs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const firstForkDir = yield* createBareRemote();
      const secondForkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "first-fork", firstForkDir]);
      yield* runGit(repoDir, ["remote", "add", "second-fork", secondForkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/ambiguous-fork"]);
      yield* runGit(repoDir, ["push", "first-fork", "feature/ambiguous-fork"]);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "first-fork",
        "git@github.com:contributor/codething-mvp.git",
        firstForkDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "second-fork",
        "git@github.com:someone-else/codething-mvp.git",
        secondForkDir,
      );

      const ghScenario = {
        prListByHeadSelector: {
          "feature/ambiguous-fork": JSON.stringify([
            {
              number: 41,
              title: "One fork's PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/41",
              baseRefName: "main",
              headRefName: "feature/ambiguous-fork",
              state: "OPEN",
              isCrossRepository: true,
              headRepository: { nameWithOwner: "contributor/codething-mvp" },
              headRepositoryOwner: { login: "contributor" },
            },
          ]),
        },
      };
      const { manager: singleRemoteManager } = yield* makeManager({ ghScenario });
      expect(
        (yield* singleRemoteManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/ambiguous-fork",
        }))?.number,
      ).toBe(41);

      yield* runGit(repoDir, ["push", "second-fork", "feature/ambiguous-fork"]);
      const { manager } = yield* makeManager({ ghScenario });
      expect(
        yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature/ambiguous-fork" }),
      ).toBeNull();

      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "Continue feature"]);
      yield* runGit(repoDir, ["push", "first-fork", "feature/ambiguous-fork"]);
      const { manager: exactManager } = yield* makeManager({ ghScenario });
      expect(
        (yield* exactManager.branchPullRequest({
          cwd: repoDir,
          branch: "feature/ambiguous-fork",
        }))?.number,
      ).toBe(41);
    }),
  );

  it.effect("does not guess a fork when an ancestry probe fails", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/failed-probe"]);
      yield* runGit(repoDir, ["push", "fork", "feature/failed-probe"]);
      yield* runGit(repoDir, ["push", "origin", "feature/failed-probe"]);
      yield* runGit(repoDir, ["commit", "--allow-empty", "-m", "Local work"]);
      const treeOid = (yield* runGit(repoDir, ["rev-parse", "HEAD^{tree}"])).stdout.trim();
      yield* runGit(repoDir, ["update-ref", "refs/remotes/origin/feature/failed-probe", treeOid]);
      const forkProbe = yield* runGit(
        repoDir,
        ["merge-base", "--is-ancestor", "refs/remotes/fork/feature/failed-probe", "HEAD"],
        true,
      );
      expect(forkProbe.exitCode).toBe(0);
      const originProbe = yield* runGit(
        repoDir,
        ["merge-base", "--is-ancestor", "refs/remotes/origin/feature/failed-probe", "HEAD"],
        true,
      );
      expect(originProbe.exitCode).not.toBe(0);
      expect(originProbe.exitCode).not.toBe(1);
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
        originDir,
      );
      yield* configureVisibleRemoteUrlWithLocalRewrite(
        repoDir,
        "fork",
        "git@github.com:contributor/codething-mvp.git",
        forkDir,
      );

      const ghScenario = {
        prListByHeadSelector: {
          "feature/failed-probe": JSON.stringify([
            {
              number: 43,
              title: "Failed probe PR",
              url: "https://github.com/pingdotgg/codething-mvp/pull/43",
              baseRefName: "main",
              headRefName: "feature/failed-probe",
              state: "OPEN",
              isCrossRepository: true,
              headRepository: { nameWithOwner: "contributor/codething-mvp" },
              headRepositoryOwner: { login: "contributor" },
            },
          ]),
        },
      };
      const { manager } = yield* makeManager({ ghScenario });
      expect(
        yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature/failed-probe" }),
      ).toBeNull();
    }),
  );

  it.effect("finds a fork PR when the remote name contains a slash", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["remote", "add", "team/fork", forkDir]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/slash-remote"]);
      yield* runGit(repoDir, ["push", "team/fork", "feature/slash-remote"]);
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
            "feature/slash-remote": JSON.stringify([
              {
                number: 42,
                title: "Slash remote PR",
                url: "https://github.com/pingdotgg/codething-mvp/pull/42",
                baseRefName: "main",
                headRefName: "feature/slash-remote",
                state: "OPEN",
                isCrossRepository: true,
                headRepository: { nameWithOwner: "contributor/codething-mvp" },
                headRepositoryOwner: { login: "contributor" },
              },
            ]),
          },
        },
      });

      expect(
        (yield* manager.branchPullRequest({ cwd: repoDir, branch: "feature/slash-remote" }))
          ?.number,
      ).toBe(42);
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

  // regression: #8600 settle threads server-side
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
          failWith:
            "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.",
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
    { remoteUrl: "git@gitlab.com:Group/Subgroup/Fork.git", setUpstream: true },
    { remoteUrl: "git@gitlab.com:Group/Subgroup/Fork.git", setUpstream: false },
    { remoteUrl: "https://gitlab.com/Group/Subgroup/Fork.git", setUpstream: true },
    { remoteUrl: "https://gitlab.com/Group/Subgroup/Fork.git", setUpstream: false },
  ] as const)("matches GitLab forks for $remoteUrl/$setUpstream", ({ remoteUrl, setUpstream }) =>
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
      yield* runGit(repoDir, ["push", ...(setUpstream ? ["-u"] : []), "fork", branch]);
      const upstream = yield* runGit(repoDir, [
        "for-each-ref",
        "--format=%(upstream:short)",
        `refs/heads/${branch}`,
      ]);
      expect(upstream.stdout.trim()).toBe(setUpstream ? `fork/${branch}` : "");
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
      const calls: SourceControlHost.SourceControlProcessInput[] = [];
      const provider = yield* GitLabSourceControlProvider.make.pipe(
        Effect.provide(
          GitLabCli.layer.pipe(
            Layer.provideMerge(
              TestSourceControlHost.layer({
                process: {
                  run: (input) =>
                    Effect.sync(() => {
                      calls.push(input);
                      return fakeGhOutput(output);
                    }),
                },
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

  it.effect("status detects cross-repo PRs from the upstream remote URL owner", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const forkDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
      // Origin is the base repository; a lone remote would be the base itself.
      yield* runGit(repoDir, [
        "remote",
        "add",
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
      ]);
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
  );

  it.effect("status preserves a fork PR whose head is named after the default branch", () =>
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
  );

  it.effect("status hides merged PRs on the default branch", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
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
      yield* runGit(repoDir, ["push", "origin", "feature/pushed-plain"]);

      const { manager, ghCalls } = yield* makeManager({
        ghScenario: {
          prListByHeadSelector: {
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

  it.effect("status prefers open PR when merged PR has newer updatedAt", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/status-open-over-merged"]);

      const { manager } = yield* makeManager({
        ghScenario: {
          prListSequence: [
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
          prListSequence: [JSON.stringify([existingPr])],
          failWith:
            "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.",
          failAfterCalls: 1,
        },
      });

      const first = yield* manager.status({ cwd: repoDir });
      expect(first.pr?.number).toBe(214);

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
            prListSequence: [JSON.stringify([existingPr])],
            failWith:
              "No GitHub credential on the server. Set GH_TOKEN, or install the GitHub CLI and run `gh auth login`.",
            failAfterCalls: 1,
          },
        });

        const first = yield* manager.status({ cwd: repoDir });
        expect(first.pr?.number).toBe(214);

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

  it.effect("applies a V2-native thread's project settings to generated commit text", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nproject\n");
      const projectId = ProjectId.make("project:git-settings");
      const threadId = ThreadId.make("thread:git-settings");
      const projectModel: ModelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-project-writer",
      };
      const providerInstanceId = ProviderInstanceId.make("codex");
      const createdAt = DateTime.makeUnsafe("2026-09-27T00:00:00.000Z");
      let generatedModelSelection:
        | TextGeneration.CommitMessageGenerationInput["modelSelection"]
        | undefined;

      const { manager } = yield* makeManager({
        serverSettings: {
          projectSettingsOverrides: { [projectId]: { textGenerationModelSelection: projectModel } },
        },
        textGeneration: {
          generateCommitMessage: (input) => {
            generatedModelSelection = input.modelSelection;
            return Effect.succeed({ subject: "Use the project writer", body: "" });
          },
        },
        seed: Effect.gen(function* () {
          yield* (yield* ProjectStore.ProjectStoreV2).apply({
            sequence: 1,
            eventId: EventId.make("event:git-settings:project"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: DateTime.formatIso(createdAt),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "Git settings",
              workspaceRoot: "/elsewhere",
              defaultModelSelection: null,
              scripts: [],
              createdAt: DateTime.formatIso(createdAt),
              updatedAt: DateTime.formatIso(createdAt),
            },
          });
          yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
            id: EventId.make("event:git-settings:thread"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: createdAt,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: "Git settings",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: repoDir,
              activeProviderThreadId: null,
              lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
        }),
      });

      yield* manager.runStackedAction({
        actionId: "test-action-id",
        cwd: repoDir,
        action: "commit",
        threadId,
      });

      expect(generatedModelSelection).toEqual(projectModel);
    }),
  );

  it.effect.each([undefined, ["README.md"]])(
    "a failed generation preserves staging changed while generating (paths: %s)",
    (filePaths) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nstaged\n");
        yield* runGit(repoDir, ["add", "README.md"]);
        NodeFS.appendFileSync(NodePath.join(repoDir, "README.md"), "unstaged\n");
        NodeFS.writeFileSync(NodePath.join(repoDir, "untracked.txt"), "untracked\n");
        const indexBefore = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
        const headBefore = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout;
        const gitDriver = yield* GitVcsDriver.GitVcsDriver;
        let indexDuring: Buffer | undefined;
        let indexAfterUserStage: Buffer | undefined;
        const { manager } = yield* makeManager({
          textGeneration: {
            generateCommitMessage: () =>
              Effect.gen(function* () {
                indexDuring = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
                yield* runGit(repoDir, ["add", "untracked.txt"]).pipe(
                  Effect.provideService(GitVcsDriver.GitVcsDriver, gitDriver),
                  Effect.orDie,
                );
                indexAfterUserStage = NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"));
                return yield* new TextGenerationError({
                  operation: "generateCommitMessage",
                  detail: "Provider rejected generation",
                });
              }),
          },
        });
        const result = yield* runStackedAction(manager, {
          cwd: repoDir,
          action: "commit",
          ...(filePaths ? { filePaths } : {}),
        }).pipe(Effect.result);
        expect(Result.isFailure(result)).toBe(true);
        expect(indexDuring).toEqual(indexBefore);
        expect(NodeFS.readFileSync(NodePath.join(repoDir, ".git/index"))).toEqual(
          indexAfterUserStage,
        );
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout).toBe(headBefore);
        expect((yield* runGit(repoDir, ["diff"])).stdout).toContain("+unstaged");
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

  it.effect.each([
    { branch: "fix/name", existingBranches: ["fix"], expected: "fix-2/name" },
    { branch: "fix/name", existingBranches: ["fix/name/child"], expected: "fix/name-2" },
  ])("commits on $expected when $branch has ref namespace collisions", (scenario) =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const mainSha = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
      for (const branch of scenario.existingBranches) {
        yield* runGit(repoDir, ["branch", branch]);
      }
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "hello\nnamespace-collision\n");

      const { manager } = yield* makeManager({
        textGeneration: {
          generateCommitMessage: () =>
            Effect.succeed({
              subject: "Fix namespace collision",
              body: "",
              branch: scenario.branch,
            }),
        },
      });
      const result = yield* runStackedAction(manager, {
        cwd: repoDir,
        action: "commit",
        featureBranch: true,
      });

      expect(result.branch).toEqual({ status: "created", name: scenario.expected });
      expect(result.commit.status).toBe("created");
      expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe(
        scenario.expected,
      );
      expect((yield* runGit(repoDir, ["status", "--porcelain"])).stdout.trim()).toBe("");
      for (const branch of ["main", ...scenario.existingBranches]) {
        expect((yield* runGit(repoDir, ["rev-parse", branch])).stdout.trim()).toBe(mainSha);
      }
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
        yield* runGit(remoteDir, [
          "--git-dir=.",
          "log",
          "-1",
          "--pretty=%s",
          "feature/push-dirty",
        ]).pipe(Effect.map((output) => output.stdout.trim())),
      ).toBe("Push dirty branch");
    }),
  );

  it.effect("create_pr targets the remote default branch when it is not main", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
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
          { repositoryNameFromRemoteUrl: ForgejoSourceControlProvider.repositoryNameFromRemoteUrl },
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
          { repositoryNameFromRemoteUrl: ForgejoSourceControlProvider.repositoryNameFromRemoteUrl },
        ),
      ).toBe("maria/project");
      expect(
        GitManager.parseRepositoryNameWithOwnerFromRemoteUrl(
          "https://gitlab.example/group/maria/project.git",
          {},
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

  it.effect("create_pr sends bounded checks to the model and omits rolled-back runs", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      yield* runGit(repoDir, ["checkout", "-b", "feature/thread-context"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "thread-context.txt"), "context\n");
      yield* runGit(repoDir, ["add", "thread-context.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Thread context"]);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      const threadId = ThreadId.make("thread:pr-thread-context");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const createdAt = DateTime.makeUnsafe("2026-09-27T00:00:00.000Z");
      const run = (ordinal: number, status: "completed" | "rolled_back") => ({
        id: RunId.make(`run:pr-thread-context:${ordinal}`),
        threadId,
        ordinal,
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message:pr-thread-context:${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: createdAt,
        startedAt: createdAt,
        completedAt: createdAt,
        checkpointId: null,
        contextHandoffId: null,
      });
      const itemBase = (ordinal: number, runId: RunId) => ({
        id: TurnItemId.make(`item:pr-thread-context:${ordinal}`),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal,
        status: "completed" as const,
        title: null,
        startedAt: createdAt,
        completedAt: createdAt,
        updatedAt: createdAt,
      });
      let generatedThreadContext: string | undefined;
      let generatedPrompt = "";
      const writer = fromRunner("test", (request) => {
        generatedPrompt = request.prompt;
        return decodeJsonReply(request, "test", '{"title":"Thread context","body":"Body"}');
      });

      const { manager } = yield* makeManager({
        textGeneration: {
          generatePrContent: (input) => {
            generatedThreadContext = input.threadContext;
            return writer.generatePrContent(input);
          },
        },
        seed: Effect.gen(function* () {
          const store = yield* ProjectionStore.ProjectionStoreV2;
          const completedRun = run(1, "completed");
          const abandonedRun = run(2, "rolled_back");
          yield* store.apply({
            id: EventId.make("event:pr-thread-context:thread"),
            type: "thread.created",
            threadId,
            providerInstanceId,
            occurredAt: createdAt,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId: ProjectId.make("project:pr-thread-context"),
              title: "PR thread context",
              providerInstanceId,
              modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: repoDir,
              activeProviderThreadId: null,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: threadId,
              },
              forkedFrom: null,
              createdAt,
              updatedAt: createdAt,
              archivedAt: null,
              settledOverride: null,
              settledAt: null,
              lastVisitedAt: null,
              deletedAt: null,
            },
          });
          for (const payload of [completedRun, abandonedRun]) {
            yield* store.apply({
              id: EventId.make(`event:pr-thread-context:run:${payload.ordinal}`),
              type: "run.updated",
              threadId,
              runId: payload.id,
              occurredAt: createdAt,
              payload,
            });
          }
          const items = [
            {
              ...itemBase(1, completedRun.id),
              type: "user_message" as const,
              messageId: completedRun.userMessageId,
              createdBy: "user" as const,
              creationSource: "web" as const,
              inputIntent: "turn_start" as const,
              text: "Make the PR writer see the thread",
              attachments: [],
            },
            {
              ...itemBase(3, completedRun.id),
              type: "command_execution" as const,
              input: "vp test run",
              output: `${"collecting tests\n".repeat(4_000)}Tests 12 passed`,
              exitCode: 0,
            },
            {
              ...itemBase(4, completedRun.id),
              type: "command_execution" as const,
              input: "vp lint",
              output: "2 lint errors",
              exitCode: 1,
            },
            {
              ...itemBase(5, abandonedRun.id),
              type: "command_execution" as const,
              input: "vp run abandoned",
              output: "abandoned output",
              exitCode: 0,
            },
          ];
          for (const payload of items) {
            yield* store.apply({
              id: EventId.make(`event:pr-thread-context:${payload.id}`),
              type: "turn-item.updated",
              threadId,
              runId: payload.runId,
              occurredAt: createdAt,
              payload,
            });
          }
        }),
      });

      yield* manager.runStackedAction({
        actionId: "test-action-id",
        cwd: repoDir,
        action: "create_pr",
        threadId,
      });

      expect(generatedPrompt).toContain("Command: vp test run\nExit code: 0");
      expect(generatedPrompt).toContain("Tests 12 passed");
      expect(generatedPrompt).toContain("Make the PR writer see the thread");
      expect(generatedPrompt).toContain("Command: vp lint\nExit code: 1");
      expect(generatedPrompt).toContain("2 lint errors");
      expect(generatedPrompt).not.toContain("vp run abandoned");
      expect(generatedPrompt).not.toContain("abandoned output");
      expect(Buffer.byteLength(generatedThreadContext ?? "")).toBeLessThanOrEqual(16_000);
    }),
  );

  it.effect("ignores unavailable or non-regular GitLab default templates", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const provider = yield* makeGitLabTemplateProvider();
      const readTemplate = (treeish = "HEAD") =>
        provider.readChangeRequestTemplate!({ cwd: repoDir, treeish });
      expect(yield* readTemplate()).toEqual(Option.none());

      const templateDir = NodePath.join(repoDir, ".gitlab", "merge_request_templates");
      const templatePath = ".gitlab/merge_request_templates/Default.md";
      NodeFS.mkdirSync(templateDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(templateDir, "Bugfix.md"), "Not the default");
      yield* runGit(repoDir, ["add", ".gitlab"]);
      yield* runGit(repoDir, ["commit", "-m", "Add a selectable template"]);
      expect(yield* readTemplate()).toEqual(Option.none());

      NodeFS.writeFileSync(NodePath.join(repoDir, templatePath), " \n\n");
      yield* runGit(repoDir, ["add", ".gitlab"]);
      yield* runGit(repoDir, ["commit", "-m", "Add a blank default"]);
      expect(yield* readTemplate()).toEqual(Option.none());

      // Index modes exercise committed symlinks and submodules even on hosts without symlinks.
      const { stdout: blob } = yield* runGit(repoDir, ["rev-parse", "HEAD:README.md"]);
      yield* runGit(repoDir, ["update-index", "--cacheinfo", "120000", blob.trim(), templatePath]);
      yield* runGit(repoDir, ["commit", "-m", "Replace default with a symlink"]);
      expect(yield* readTemplate()).toEqual(Option.none());

      const { stdout: commit } = yield* runGit(repoDir, ["rev-parse", "HEAD"]);
      yield* runGit(repoDir, [
        "update-index",
        "--cacheinfo",
        "160000",
        commit.trim(),
        templatePath,
      ]);
      yield* runGit(repoDir, ["commit", "-m", "Replace default with a submodule"]);
      expect(yield* readTemplate()).toEqual(Option.none());
      expect(yield* readTemplate("missing-base")).toEqual(Option.none());
    }),
  );

  it.effect("bounds GitLab template content and marks truncation", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const templateDir = NodePath.join(repoDir, ".gitlab", "merge_request_templates");
      const prefix = "a".repeat(8_000);
      NodeFS.mkdirSync(templateDir, { recursive: true });
      NodeFS.writeFileSync(NodePath.join(templateDir, "Default.md"), prefix + "EXCLUDED_SUFFIX");
      yield* runGit(repoDir, ["add", ".gitlab"]);
      yield* runGit(repoDir, ["commit", "-m", "Add a large template"]);
      const provider = yield* makeGitLabTemplateProvider();

      expect(yield* provider.readChangeRequestTemplate!({ cwd: repoDir, treeish: "HEAD" })).toEqual(
        Option.some(prefix + "\n\n[truncated]"),
      );
    }),
  );

  it.effect.each(["commit", "short-commit", "tag", "revision"] as const)(
    "creates a PR against the default branch with a legacy %s base setting",
    (kind) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["branch", "-m", "main", "trunk"]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "trunk"]);
        yield* runGit(repoDir, ["checkout", "-b", "feature/legacy-base"]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "feature.txt"), "feature\n");
        yield* runGit(repoDir, ["add", "feature.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "Feature commit"]);
        const commit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["tag", "v1"]);
        const baseRef =
          kind === "commit"
            ? commit
            : kind === "short-commit"
              ? commit.slice(0, 12)
              : kind === "tag"
                ? "v1"
                : "HEAD~0";
        yield* runGit(repoDir, ["config", "branch.feature/legacy-base.gh-merge-base", baseRef]);
        yield* runGit(repoDir, ["push", "-u", "origin", "feature/legacy-base"]);
        let generatedBase = "";
        let generatedSummary = "";
        const { manager, ghCalls } = yield* makeManager({
          ghScenario: { defaultBranch: "trunk", prListSequence: ["[]", "[]"] },
          textGeneration: {
            generatePrContent: (input) => {
              generatedBase = input.baseBranch;
              generatedSummary = input.commitSummary;
              return Effect.succeed({ title: "Feature PR", body: "Feature body" });
            },
          },
        });

        const result = yield* runStackedAction(manager, { cwd: repoDir, action: "create_pr" });

        expect(result.pr.status).toBe("created");
        expect(generatedBase).toBe("trunk");
        expect(generatedSummary).toContain("Feature commit");
        expect(
          ghCalls.some((call) =>
            call.includes("pr create --base trunk --head feature/legacy-base"),
          ),
        ).toBe(true);
      }),
  );

  it.effect("generates PR content from the created worktree's selected remote base", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const originDir = yield* createBareRemote();
      const upstreamDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
      yield* runGit(repoDir, ["remote", "add", "upstream", upstreamDir]);
      yield* runGit(repoDir, ["checkout", "-b", "fork-release"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "fork.txt"), "fork-only work\n");
      NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
      NodeFS.writeFileSync(
        NodePath.join(repoDir, ".github/pull_request_template.md"),
        "Fork template",
      );
      yield* runGit(repoDir, ["add", "."]);
      yield* runGit(repoDir, ["commit", "-m", "Fork release commit"]);
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/heads/release"]);
      yield* runGit(repoDir, ["checkout", "-b", "stable", "main"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "upstream.txt"), "upstream-only work\n");
      NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
      NodeFS.writeFileSync(
        NodePath.join(repoDir, ".github/pull_request_template.md"),
        "Upstream template",
      );
      yield* runGit(repoDir, ["add", "."]);
      yield* runGit(repoDir, ["commit", "-m", "Upstream release commit"]);
      yield* runGit(repoDir, ["push", "-u", "upstream", "stable:release"]);
      yield* runGit(repoDir, ["branch", "upstream/release", "fork-release"]);

      const driver = yield* GitVcsDriver.GitVcsDriver;
      const fetched = yield* driver.fetchWorktreeBaseCommit({ cwd: repoDir, refName: "stable" });
      expect(fetched).not.toBeNull();
      const worktreePath = NodePath.join(yield* makeTempDir("t3code-git-worktrees-"), "feature");
      yield* driver.createWorktree({
        cwd: repoDir,
        path: worktreePath,
        refName: fetched!.commitSha,
        newRefName: "feature/from-upstream",
        baseRefName: `refs/remotes/${fetched!.remoteRefName}`,
      });
      NodeFS.writeFileSync(NodePath.join(worktreePath, "feature.txt"), "feature work\n");
      yield* runGit(worktreePath, ["add", "feature.txt"]);
      yield* runGit(worktreePath, ["commit", "-m", "Feature commit"]);
      yield* runGit(worktreePath, ["push", "-u", "origin", "feature/from-upstream"]);

      const generatedInputs: TextGeneration.PrContentGenerationInput[] = [];
      const { manager, ghCalls } = yield* makeManager({
        ghScenario: { prListSequence: ["[]", "[]"] },
        textGeneration: {
          generatePrContent: (input) => {
            generatedInputs.push(input);
            return Effect.succeed({ title: "Feature PR", body: "Feature body" });
          },
        },
      });
      const result = yield* runStackedAction(manager, { cwd: worktreePath, action: "create_pr" });

      expect(result.pr.status).toBe("created");
      expect(generatedInputs).toHaveLength(1);
      const generated = generatedInputs[0]!;
      expect.soft(generated.commitSummary).toContain("Feature commit");
      expect.soft(generated.commitSummary).not.toContain("Upstream release commit");
      expect.soft(generated.commitSummary).not.toContain("Fork release commit");
      expect.soft(generated.diffSummary).toContain("feature.txt");
      expect.soft(generated.diffSummary).not.toContain("upstream.txt");
      expect.soft(generated.diffSummary).not.toContain("fork.txt");
      expect.soft(generated.diffPatch).toContain("+feature work");
      expect.soft(generated.diffPatch).not.toContain("upstream-only work");
      expect.soft(generated.diffPatch).not.toContain("fork-only work");
      expect.soft(generated.changeRequestTemplate).toBe("Upstream template");
      expect(
        ghCalls.some((call) =>
          call.includes("pr create --base release --head feature/from-upstream"),
        ),
      ).toBe(true);
    }),
  );

  it.effect(
    "preserves a local worktree PR base that shadows a remote ref, including legacy bases",
    () =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const originDir = yield* createBareRemote();
        const upstreamDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", originDir]);
        yield* runGit(repoDir, ["remote", "add", "upstream", upstreamDir]);
        yield* runGit(repoDir, ["checkout", "-b", "release"]);
        NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
        NodeFS.writeFileSync(NodePath.join(repoDir, "remote.txt"), "remote-only work\n");
        NodeFS.writeFileSync(
          NodePath.join(repoDir, ".github/pull_request_template.md"),
          "Remote release template",
        );
        yield* runGit(repoDir, ["add", "."]);
        yield* runGit(repoDir, ["commit", "-m", "Remote release commit"]);
        yield* runGit(repoDir, ["push", "upstream", "release"]);

        yield* runGit(repoDir, ["checkout", "-b", "upstream/release", "main"]);
        NodeFS.mkdirSync(NodePath.join(repoDir, ".github"));
        NodeFS.writeFileSync(NodePath.join(repoDir, "local.txt"), "local-base work\n");
        NodeFS.writeFileSync(
          NodePath.join(repoDir, ".github/pull_request_template.md"),
          "Local branch template",
        );
        yield* runGit(repoDir, ["add", "."]);
        yield* runGit(repoDir, ["commit", "-m", "Local base commit"]);
        yield* runGit(repoDir, ["push", "upstream", "refs/heads/upstream/release"]);
        yield* runGit(repoDir, ["push", "origin", "refs/heads/upstream/release"]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = NodePath.join(yield* makeTempDir("t3code-git-worktrees-"), "feature");
        yield* driver.createWorktree({
          cwd: repoDir,
          path: worktreePath,
          refName: "refs/heads/upstream/release",
          newRefName: "feature/from-local",
          baseRefName: "refs/heads/upstream/release",
        });
        NodeFS.writeFileSync(NodePath.join(worktreePath, "feature.txt"), "feature work\n");
        yield* runGit(worktreePath, ["add", "feature.txt"]);
        yield* runGit(worktreePath, ["commit", "-m", "Feature commit"]);
        yield* runGit(worktreePath, ["push", "-u", "origin", "feature/from-local"]);

        const generatedInputs: TextGeneration.PrContentGenerationInput[] = [];
        const { manager, ghCalls } = yield* makeManager({
          ghScenario: { prListSequence: ["[]", "[]", "[]", "[]"] },
          textGeneration: {
            generatePrContent: (input) => {
              generatedInputs.push(input);
              return Effect.succeed({ title: "Feature PR", body: "Feature body" });
            },
          },
        });
        const result = yield* runStackedAction(manager, { cwd: worktreePath, action: "create_pr" });
        expect(result.pr.status).toBe("created");

        // A branch created outside T3 has only gh's legacy short base setting.
        yield* runGit(worktreePath, ["checkout", "-b", "feature/legacy-local-base"]);
        yield* runGit(worktreePath, [
          "config",
          "branch.feature/legacy-local-base.gh-merge-base",
          "upstream/release",
        ]);
        yield* runGit(worktreePath, ["push", "-u", "origin", "feature/legacy-local-base"]);
        const legacyResult = yield* runStackedAction(manager, {
          cwd: worktreePath,
          action: "create_pr",
        });
        expect(legacyResult.pr.status).toBe("created");
        expect(generatedInputs).toHaveLength(2);
        for (const generated of generatedInputs) {
          expect.soft(generated.baseBranch).toBe("upstream/release");
          expect.soft(generated.commitSummary.trim()).toMatch(/^[a-f0-9]+ Feature commit$/);
          expect.soft(generated.diffSummary).toContain("feature.txt");
          expect.soft(generated.diffSummary).toContain("1 file changed, 1 insertion(+)");
          expect.soft(generated.diffPatch).toContain("+feature work");
          expect.soft(generated.diffPatch).not.toContain("local-base work");
          expect.soft(generated.diffPatch).not.toContain("remote-only work");
          expect.soft(generated.diffPatch).not.toContain("pull_request_template.md");
          expect.soft(generated.changeRequestTemplate).toBe("Local branch template");
        }
        expect
          .soft(ghCalls.filter((call) => call.startsWith("pr create ")))
          .toEqual([
            expect.stringContaining("pr create --base upstream/release --head feature/from-local"),
            expect.stringContaining(
              "pr create --base upstream/release --head feature/legacy-local-base",
            ),
          ]);
      }),
  );

  it.effect.each(["main", "release/1.2"])(
    "generates PR content from branch changes when the remote base advances (%s)",
    (baseBranch) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        yield* runGit(repoDir, ["branch", "-m", baseBranch]);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", baseBranch]);
        yield* runGit(remoteDir, [
          "--git-dir=.",
          "symbolic-ref",
          "HEAD",
          `refs/heads/${baseBranch}`,
        ]);

        const driver = yield* GitVcsDriver.GitVcsDriver;
        const worktreePath = NodePath.join(yield* makeTempDir("t3code-git-worktrees-"), "feature");
        yield* driver.createWorktree({
          cwd: repoDir,
          path: worktreePath,
          refName: baseBranch,
          newRefName: "feature/remote-base",
          baseRefName: baseBranch,
        });
        NodeFS.writeFileSync(NodePath.join(worktreePath, "feature.txt"), "feature\n");
        yield* runGit(worktreePath, ["add", "feature.txt"]);
        yield* runGit(worktreePath, ["commit", "-m", "Feature commit"]);

        const peerDir = yield* makeTempDir("t3code-git-peer-");
        yield* runGit(peerDir, ["clone", remoteDir, "."]);
        yield* runGit(peerDir, ["config", "user.email", "peer@example.com"]);
        yield* runGit(peerDir, ["config", "user.name", "Peer User"]);
        NodeFS.writeFileSync(NodePath.join(peerDir, "remote.txt"), "remote\n");
        NodeFS.mkdirSync(NodePath.join(peerDir, ".github"));
        NodeFS.writeFileSync(
          NodePath.join(peerDir, ".github/pull_request_template.md"),
          "Updated main template",
        );
        yield* runGit(peerDir, ["add", "."]);
        yield* runGit(peerDir, ["commit", "-m", "Remote base commit"]);
        yield* runGit(peerDir, ["push", "origin", baseBranch]);

        NodeFS.writeFileSync(NodePath.join(peerDir, "later-main.txt"), "unrelated\n");
        yield* runGit(peerDir, ["add", "later-main.txt"]);
        yield* runGit(peerDir, ["commit", "-m", "Later main commit"]);
        yield* runGit(peerDir, ["push", "origin", baseBranch]);
        yield* runGit(worktreePath, ["fetch", "origin"]);
        yield* runGit(worktreePath, ["rebase", `origin/${baseBranch}`]);

        const preview = yield* driver.getReviewDiffPreview({ cwd: worktreePath });
        const changes = preview.sources.find((source) => source.kind === "branch-range")!;
        expect
          .soft(changes.files)
          .toEqual([{ path: "feature.txt", previousPath: null, additions: 1, deletions: 0 }]);
        yield* runGit(worktreePath, ["push", "-u", "origin", "feature/remote-base"]);

        const generatedInputs: TextGeneration.PrContentGenerationInput[] = [];
        const { manager, ghCalls } = yield* makeManager({
          ghScenario: {
            prListSequence: ["[]", "[]"],
          },
          textGeneration: {
            generatePrContent: (input) => {
              generatedInputs.push(input);
              return Effect.succeed({ title: "Feature PR", body: "Feature body" });
            },
          },
        });

        const result = yield* runStackedAction(manager, {
          cwd: worktreePath,
          action: "create_pr",
        });

        expect(result.pr.status).toBe("created");
        expect(generatedInputs).toHaveLength(1);
        const generated = generatedInputs[0]!;
        expect.soft(generated.baseBranch).toBe(baseBranch);
        expect.soft(generated.commitSummary.trim()).toMatch(/^[a-f0-9]+ Feature commit$/);
        expect.soft(generated.diffSummary).toContain("feature.txt");
        expect.soft(generated.diffSummary).toContain("1 file changed, 1 insertion(+)");
        expect.soft(generated.diffPatch).toContain("+feature");
        expect.soft(generated.diffPatch).not.toContain("remote.txt");
        expect.soft(generated.diffPatch).not.toContain("later-main.txt");
        expect.soft(generated.diffPatch).not.toContain("pull_request_template.md");
        expect.soft(generated.changeRequestTemplate).toBe("Updated main template");
        expect(
          ghCalls.some((call) =>
            call.includes(`pr create --base ${baseBranch} --head feature/remote-base`),
          ),
        ).toBe(true);
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
      // Origin is the base repository; a lone remote would be the base itself.
      yield* runGit(repoDir, [
        "remote",
        "add",
        "origin",
        "git@github.com:pingdotgg/codething-mvp.git",
      ]);
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
              JSON.stringify([]),
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

  const setUpLocalCheckoutPullRequest = Effect.fnUntraced(function* (
    reportedHead: (pullHead: string) => string | undefined = (pullHead) => pullHead,
    syncCheckoutWithPullHead = true,
    gitSpawnGate?: NonNullable<Parameters<typeof makeManager>[0]>["gitSpawnGate"],
  ) {
    const repoDir = yield* makeTempDir("t3code-git-manager-");
    yield* initRepo(repoDir);
    const remoteDir = yield* createBareRemote();
    yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
    yield* runGit(repoDir, ["checkout", "-b", "feature/pr-safe"]);
    NodeFS.writeFileSync(NodePath.join(repoDir, "pr.txt"), "first\n");
    yield* runGit(repoDir, ["add", "pr.txt"]);
    yield* runGit(repoDir, ["commit", "-m", "PR first"]);
    const firstCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
    NodeFS.writeFileSync(NodePath.join(repoDir, "pr.txt"), "second\n");
    yield* runGit(repoDir, ["commit", "-am", "PR second"]);
    const pullHead = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
    yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/91/head"]);
    yield* runGit(repoDir, ["reset", "--hard", firstCommit]);
    const headSha = reportedHead(pullHead);
    const { manager, ghCalls } = yield* makeManager({
      ...(gitSpawnGate ? { gitSpawnGate } : {}),
      ghScenario: {
        pullRequest: {
          number: 91,
          title: "Safe checkout PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/91",
          baseRefName: "main",
          headRefName: "feature/pr-safe",
          state: "open",
          ...(headSha === undefined ? {} : { headSha }),
        },
        syncCheckoutWithPullHead,
      },
    });
    return { repoDir, manager, ghCalls, firstCommit, pullHead };
  });

  it.effect.each(["switch", "create-and-switch", "feature-branch"] as const)(
    "local PR checkout excludes a concurrent %s from a nested project with an alternate root",
    (operation) =>
      Effect.gen(function* () {
        const gate = {
          matches: (args: ReadonlyArray<string>) =>
            args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "HEAD^{commit}",
          reached: yield* Deferred.make<void>(),
          release: yield* Deferred.make<void>(),
        };
        const { repoDir, manager, pullHead } = yield* setUpLocalCheckoutPullRequest(
          (head) => head,
          false,
          gate,
        );
        const nestedCwd = NodePath.join(repoDir, "nested-project");
        yield* makeDirectory(nestedCwd);
        const mainCommit = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);
        const registry = yield* Layer.build(
          VcsDriverRegistry.layer.pipe(
            Layer.provide(VcsProjectConfig.layer),
            Layer.provide(VcsProcess.layer),
          ),
        );
        const handle = yield* Context.get(registry, VcsDriverRegistry.VcsDriverRegistry).resolve({
          cwd: repoDir,
        });
        const resolvedHandle = {
          ...handle,
          repository: { ...handle.repository, rootPath: `${handle.repository.rootPath}/.` },
        };
        const fileSystem = yield* FileSystem.FileSystem;
        const canonicalRoot = yield* fileSystem.realPath(resolvedHandle.repository.rootPath);
        const git = yield* GitVcsDriver.GitVcsDriver;
        const events: string[] = [];
        const workflows = yield* Effect.forEach([0, 1], () =>
          GitWorkflowService.make.pipe(
            // Cache the real filesystem result so startImmediately reaches lease acquisition.
            Effect.provideService(FileSystem.FileSystem, {
              ...fileSystem,
              realPath: (root) =>
                root === resolvedHandle.repository.rootPath
                  ? Effect.succeed(canonicalRoot)
                  : fileSystem.realPath(root),
            }),
            Effect.provideService(GitManager.GitManager, {
              ...manager,
              runStackedAction: (input, options) =>
                Effect.sync(() => {
                  events.push("feature-branch");
                  NodeFS.writeFileSync(
                    NodePath.join(repoDir, "second-client.txt"),
                    "second client\n",
                  );
                }).pipe(Effect.andThen(manager.runStackedAction(input, options))),
            }),
            Effect.provideService(VcsDriverRegistry.VcsDriverRegistry, {
              ...Context.get(registry, VcsDriverRegistry.VcsDriverRegistry),
              resolve: ({ cwd }) => Effect.succeed(cwd === repoDir ? handle : resolvedHandle),
            }),
            Effect.provideService(GitVcsDriver.GitVcsDriver, {
              ...git,
              switchRef: (input) =>
                Effect.sync(() => events.push("switch")).pipe(Effect.andThen(git.switchRef(input))),
              createRef: (input) =>
                Effect.sync(() => events.push("create-and-switch")).pipe(
                  Effect.andThen(git.createRef(input)),
                ),
            }),
          ),
        );
        const preparing = yield* Effect.forkChild(
          workflows[0]!.preparePullRequestThread({ cwd: repoDir, reference: "91", mode: "local" }),
        );
        yield* Deferred.await(gate.reached);
        const switching = yield* Effect.forkChild(
          operation === "switch"
            ? workflows[1]!.switchRef({ cwd: nestedCwd, refName: "main" })
            : operation === "create-and-switch"
              ? workflows[1]!.createRef({
                  cwd: nestedCwd,
                  refName: "second-client",
                  switchRef: true,
                })
              : workflows[1]!.runStackedAction({
                  cwd: nestedCwd,
                  actionId: "second-client-feature-branch",
                  action: "commit",
                  featureBranch: true,
                  commitMessage: "Second client commit",
                }),
          { startImmediately: true },
        );
        // Both independent server workflows have started, but the second cannot touch Git yet.
        expect(events).toEqual([]);
        yield* Deferred.succeed(gate.release, undefined);
        const prepared = yield* Fiber.join(preparing);
        const switched = yield* Fiber.join(switching);
        expect(events).toEqual([operation]);
        expect(prepared).toMatchObject({ branch: "feature/pr-safe", isOnPullRequestHead: true });
        expect((yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim()).toBe(mainCommit);
        expect((yield* runGit(repoDir, ["rev-parse", "feature/pr-safe"])).stdout.trim()).toBe(
          pullHead,
        );
        expect((yield* runGit(repoDir, ["branch", "--show-current"])).stdout.trim()).toBe(
          operation === "switch"
            ? "main"
            : "branch" in switched
              ? switched.branch.name
              : "second-client",
        );
        if ("commit" in switched) {
          expect(switched.commit.status).toBe("created");
          expect((yield* runGit(repoDir, ["rev-parse", "HEAD^"])).stdout.trim()).toBe(pullHead);
        }
      }),
  );

  it.effect.each([false, true])(
    "local PR checkout refuses and preserves tracked edits (staged: %s)",
    (staged) =>
      Effect.gen(function* () {
        const { repoDir, manager, ghCalls, firstCommit } = yield* setUpLocalCheckoutPullRequest();
        NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "my unsaved edit\n");
        if (staged) {
          yield* runGit(repoDir, ["add", "README.md"]);
        }
        const beforeStatus = (yield* runGit(repoDir, ["status", "--porcelain"])).stdout;

        const error = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "local",
        }).pipe(Effect.flip);

        expect(error.message).toContain("uncommitted changes");
        expect(NodeFS.readFileSync(NodePath.join(repoDir, "README.md"), "utf8")).toBe(
          "my unsaved edit\n",
        );
        expect((yield* runGit(repoDir, ["status", "--porcelain"])).stdout).toBe(beforeStatus);
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(firstCommit);
        expect(ghCalls.some((call) => call.startsWith("pr checkout"))).toBe(false);
      }),
  );

  it.effect("local PR checkout refuses a diverged branch and keeps its extra commit", () =>
    Effect.gen(function* () {
      const { repoDir, manager, ghCalls } = yield* setUpLocalCheckoutPullRequest();
      NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
      yield* runGit(repoDir, ["add", "mine.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "My unpublished commit"]);
      const localCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);

      const error = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "91",
        mode: "local",
      }).pipe(Effect.flip);

      // gh's fast-forward-only update fails rather than resetting the branch.
      expect(error.message).toContain("GitHub request failed");
      expect(ghCalls).toContain("pr checkout 91");
      expect((yield* runGit(repoDir, ["rev-parse", "feature/pr-safe"])).stdout.trim()).toBe(
        localCommit,
      );
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(localCommit);
      expect(NodeFS.readFileSync(NodePath.join(repoDir, "mine.txt"), "utf8")).toBe("mine\n");
    }),
  );

  it.effect.each([false, true])(
    "local PR checkout lands cleanly (existing branch: %s)",
    (existing) =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpLocalCheckoutPullRequest();
        yield* runGit(repoDir, ["checkout", "main"]);
        if (!existing) {
          yield* runGit(repoDir, ["branch", "-D", "feature/pr-safe"]);
        }
        NodeFS.writeFileSync(NodePath.join(repoDir, "untracked.txt"), "keep me\n");

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "local",
        });

        expect(result).toMatchObject({
          branch: "feature/pr-safe",
          worktreePath: null,
          isOnPullRequestHead: true,
        });
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
        expect(NodeFS.readFileSync(NodePath.join(repoDir, "untracked.txt"), "utf8")).toBe(
          "keep me\n",
        );
      }),
  );

  it.effect("local PR checkout fast-forwards a branch the host's checkout only switched to", () =>
    Effect.gen(function* () {
      // Like Bitbucket or Forgejo without `force`: the existing branch is checked out as it was.
      const { repoDir, manager, firstCommit, pullHead } = yield* setUpLocalCheckoutPullRequest(
        (head) => head.slice(0, 12),
        false,
      );
      yield* runGit(repoDir, ["checkout", "main"]);
      expect((yield* runGit(repoDir, ["rev-parse", "feature/pr-safe"])).stdout.trim()).toBe(
        firstCommit,
      );

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "91",
        mode: "local",
      });

      expect(result).toMatchObject({ branch: "feature/pr-safe", isOnPullRequestHead: true });
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
    }),
  );

  it.effect(
    "local PR checkout keeps a branch that is ahead and reports it is not on the head",
    () =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpLocalCheckoutPullRequest();
        yield* runGit(repoDir, ["reset", "--hard", pullHead]);
        NodeFS.writeFileSync(NodePath.join(repoDir, "mine.txt"), "mine\n");
        yield* runGit(repoDir, ["add", "mine.txt"]);
        yield* runGit(repoDir, ["commit", "-m", "My unpublished commit"]);
        const localCommit = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
        yield* runGit(repoDir, ["checkout", "main"]);

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "local",
        });

        expect(result).toMatchObject({ branch: "feature/pr-safe", isOnPullRequestHead: false });
        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(localCommit);
        expect(NodeFS.readFileSync(NodePath.join(repoDir, "mine.txt"), "utf8")).toBe("mine\n");
      }),
  );

  it.effect.each([undefined, "0".repeat(40)])(
    "local PR checkout cannot confirm an unavailable provider head (%s)",
    (reportedHead) =>
      Effect.gen(function* () {
        const { repoDir, manager, pullHead } = yield* setUpLocalCheckoutPullRequest(
          () => reportedHead,
        );
        yield* runGit(repoDir, ["checkout", "main"]);

        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "91",
          mode: "local",
        });

        expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim()).toBe(pullHead);
        expect(result.isOnPullRequestHead).toBe(false);
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

  it.effect("prepares a worktree from the head branch when the host has no pull ref", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
      yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
      yield* runGit(repoDir, ["checkout", "-b", "feature/no-pull-ref"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "head.txt"), "head\n");
      yield* runGit(repoDir, ["add", "head.txt"]);
      yield* runGit(repoDir, ["commit", "-m", "Head without a pull ref"]);
      yield* runGit(repoDir, ["push", "origin", "feature/no-pull-ref"]);
      const headSha = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/no-pull-ref"]);
      const remoteUrl = "https://dev.azure.com/org/project/_git/repo";
      yield* runGit(repoDir, ["remote", "set-url", "origin", remoteUrl]);
      yield* runGit(repoDir, ["config", `url.${remoteDir}.insteadOf`, remoteUrl]);

      const { manager: otherRepositoryManager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 79,
            title: "Another repository's PR",
            url: "https://dev.azure.com/org/project/_git/other/pullrequest/79",
            baseRefName: "main",
            headRefName: "feature/no-pull-ref",
            state: "open",
            isCrossRepository: false,
          },
        },
      });
      yield* Effect.flip(
        preparePullRequestThread(otherRepositoryManager, {
          cwd: repoDir,
          reference: "79",
          mode: "worktree",
        }),
      );
      const { manager: mergedManager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 77,
            title: "Merged PR",
            url: "https://dev.azure.com/org/project/_git/repo/pullrequest/77",
            baseRefName: "main",
            headRefName: "feature/no-pull-ref",
            state: "merged",
            isCrossRepository: false,
          },
        },
      });
      yield* Effect.flip(
        preparePullRequestThread(mergedManager, {
          cwd: repoDir,
          reference: "77",
          mode: "worktree",
        }),
      );
      const localBranches = (yield* runGit(repoDir, ["branch", "--list"])).stdout;
      expect(localBranches).not.toContain("feature/no-pull-ref");

      const { manager } = yield* makeManager({
        ghScenario: {
          pullRequest: {
            number: 78,
            title: "Azure DevOps PR",
            url: "https://dev.azure.com/org/project/_git/repo/pullrequest/78",
            baseRefName: "main",
            headRefName: "feature/no-pull-ref",
            state: "open",
            isCrossRepository: false,
          },
        },
      });

      const result = yield* preparePullRequestThread(manager, {
        cwd: repoDir,
        reference: "78",
        mode: "worktree",
      });

      expect(result.branch).toBe("feature/no-pull-ref");
      const worktreeHead = (yield* runGit(result.worktreePath as string, [
        "rev-parse",
        "HEAD",
      ])).stdout.trim();
      expect(worktreeHead).toBe(headSha);
      const upstream = (yield* runGit(result.worktreePath as string, [
        "rev-parse",
        "--abbrev-ref",
        "@{upstream}",
      ])).stdout.trim();
      expect(upstream).toBe("origin/feature/no-pull-ref");
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

  it.effect("refreshes a reused PR worktree onto the updated pull request head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
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

  it.effect("resets a clean reused PR worktree onto a force-pushed pull request head", () =>
    Effect.gen(function* () {
      const repoDir = yield* makeTempDir("t3code-git-manager-");
      yield* initRepo(repoDir);
      const remoteDir = yield* createBareRemote();
      yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
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
      expect(
        NodeFS.readFileSync(NodePath.join(worktreePath, "force-pushed.txt"), "utf8").replace(
          /\r\n/g,
          "\n",
        ),
      ).toBe("rewritten\n");
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

  it.effect.each([
    { isCrossRepository: false, padding: 0 },
    { isCrossRepository: false, padding: 110 },
    { isCrossRepository: true, padding: 0 },
    { isCrossRepository: true, padding: 110 },
  ])(
    "reuses an existing PR worktree with $padding preceding matching branches (fork: $isCrossRepository)",
    ({ isCrossRepository, padding }) =>
      Effect.gen(function* () {
        const repoDir = yield* makeTempDir("t3code-git-manager-");
        yield* initRepo(repoDir);
        const remoteDir = yield* createBareRemote();
        yield* runGit(repoDir, ["remote", "add", "origin", remoteDir]);
        yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
        const forkDir = isCrossRepository ? yield* createBareRemote() : null;
        if (forkDir) {
          yield* runGit(repoDir, ["remote", "add", "fork-seed", forkDir]);
          yield* runGit(repoDir, ["push", "fork-seed", "main:pr-pagination"]);
        }
        const headBranch = "pr-pagination";
        const localBranch = isCrossRepository ? "t3code/pr-78/pr-pagination" : headBranch;
        yield* runGit(repoDir, ["branch", localBranch]);
        yield* runGit(repoDir, ["push", "origin", `${localBranch}:refs/pull/78/head`]);
        const worktreePath = NodePath.join(repoDir, "existing-pr");
        yield* runGit(repoDir, ["worktree", "add", worktreePath, localBranch]);
        for (let index = 0; index < padding; index++) {
          yield* runGit(repoDir, [
            "branch",
            `a-padding-${String(index).padStart(3, "0")}/${localBranch}`,
          ]);
        }
        const git = yield* GitVcsDriver.GitVcsDriver;
        const page = yield* git.listRefs({
          cwd: repoDir,
          refKind: "local",
          query: localBranch,
          refresh: true,
        });
        expect(page.nextCursor !== null).toBe(padding > 0);
        expect(page.refs.some((ref) => ref.name === localBranch)).toBe(padding === 0);
        const { manager } = yield* makeManager({
          ghScenario: {
            repositoryCloneUrls: forkDir
              ? { "contributor/codething-mvp": { url: forkDir, sshUrl: forkDir } }
              : {},
            pullRequest: {
              number: 78,
              title: "Paginated PR worktree",
              url: "https://github.com/pingdotgg/codething-mvp/pull/78",
              baseRefName: "main",
              headRefName: headBranch,
              state: "open",
              isCrossRepository,
              ...(isCrossRepository
                ? {
                    headRepositoryNameWithOwner: "contributor/codething-mvp",
                    headRepositoryOwnerLogin: "contributor",
                  }
                : {}),
            },
          },
        });

        // Fetching directly into this checked-out branch would fail with git exit 128.
        const result = yield* preparePullRequestThread(manager, {
          cwd: repoDir,
          reference: "78",
          mode: "worktree",
        });
        expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
          NodeFS.realpathSync.native(worktreePath),
        );
        expect(result.branch).toBe(localBranch);
        expect(result.isOnPullRequestHead).toBe(true);
        expect((yield* runGit(worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe(
          localBranch,
        );
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
      yield* runGit(repoDir, ["push", "origin", "HEAD:refs/pull/90/head"]);
      yield* runGit(repoDir, ["checkout", "main"]);
      yield* runGit(repoDir, ["branch", "-D", "feature/pr-ref-only"]);

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

  it.effect("preserves an unrelated local branch and upstream that share the fork head name", () =>
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
      yield* runGit(repoDir, ["checkout", "-b", "feature/root-work", "main"]);
      const mainWorktreePath = NodePath.join(
        repoDir,
        "..",
        `local-main-${NodePath.basename(repoDir)}`,
      );
      yield* runGit(repoDir, ["worktree", "add", mainWorktreePath, "main"]);
      const localMainBefore = (yield* runGit(repoDir, ["rev-parse", "main"])).stdout.trim();
      // Leave the fork tracking ref stale so an unnecessary fetch would change it.
      yield* runGit(repoDir, ["update-ref", "refs/remotes/fork-seed/main", localMainBefore]);
      const trackingRefsBefore = (yield* runGit(repoDir, [
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/remotes",
      ])).stdout;

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
      expect(
        (yield* runGit(mainWorktreePath, [
          "rev-parse",
          "--abbrev-ref",
          "@{upstream}",
        ])).stdout.trim(),
      ).toBe("origin/main");
      expect(result.branch).toBe("t3code/pr-94/main");
      expect(result.worktreePath && NodeFS.realpathSync.native(result.worktreePath)).toBe(
        NodeFS.realpathSync.native(mainWorktreePath),
      );
      expect(
        (yield* runGit(repoDir, [
          "for-each-ref",
          "--format=%(refname) %(objectname)",
          "refs/remotes",
        ])).stdout,
      ).toBe(trackingRefsBefore);
      expect((yield* runGit(mainWorktreePath, ["branch", "--show-current"])).stdout.trim()).toBe(
        "main",
      );
      expect(result.isOnPullRequestHead).toBe(false);
      expect(setupCalls).toHaveLength(0);

      yield* (yield* GitVcsDriver.GitVcsDriver).pullCurrentBranch(mainWorktreePath);
      expect((yield* runGit(mainWorktreePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
        localMainBefore,
      );
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
      yield* runGit(repoDir, [
        "worktree",
        "add",
        "-b",
        "t3code/pr-83/feature/pr-reused-fork",
        worktreePath,
        "feature/pr-reused-fork",
      ]);
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
      expect(result.branch).toBe("t3code/pr-83/feature/pr-reused-fork");
      expect((yield* runGit(worktreePath, ["branch", "--show-current"])).stdout.trim()).toBe(
        result.branch,
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

  it.effect("create_pr preserves dirty work on an already pushed branch", () =>
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
      const headBefore = (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout;
      NodeFS.writeFileSync(NodePath.join(repoDir, "README.md"), "staged readme\n");
      yield* runGit(repoDir, ["add", "README.md"]);
      NodeFS.writeFileSync(NodePath.join(repoDir, "pr-only.txt"), "unstaged feature work\n");
      NodeFS.writeFileSync(NodePath.join(repoDir, "untracked.txt"), "untracked work\n");
      const statusBefore = (yield* runGit(repoDir, ["status", "--porcelain"])).stdout;
      const stagedBefore = (yield* runGit(repoDir, ["diff", "--cached"])).stdout;
      let generatedContent: TextGeneration.PrContentGenerationInput | undefined;

      const { manager } = yield* makeManager({
        textGeneration: {
          generatePrContent: (input) => {
            generatedContent = input;
            return Effect.succeed({ title: "PR only branch", body: "Committed feature work" });
          },
        },
        ghScenario: {
          prListSequence: [
            JSON.stringify([]),
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
      expect(generatedContent?.diffPatch).toContain("+pr only");
      expect(generatedContent?.diffPatch).not.toContain("staged readme");
      expect(generatedContent?.diffPatch).not.toContain("unstaged feature work");
      expect((yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout).toBe(headBefore);
      expect((yield* runGit(repoDir, ["status", "--porcelain"])).stdout).toBe(statusBefore);
      expect((yield* runGit(repoDir, ["diff", "--cached"])).stdout).toBe(stagedBefore);
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
