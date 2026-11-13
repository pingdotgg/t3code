// @effect-diagnostics nodeBuiltinImport:off -- fixtures and tests use Node builtins
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { SourceControlProviderKind } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
import type { FakeChangeRequest, FakeProviderScenario } from "./GitManager-fixtures.testkit.ts";

export type FakeProviderCall =
  | {
      readonly operation: "listChangeRequests";
      readonly headSelector: string;
      readonly state: string;
      readonly limit: number | undefined;
    }
  | {
      readonly operation: "createChangeRequest";
      readonly baseRefName: string;
      readonly headSelector: string;
      readonly title: string;
    }
  | { readonly operation: "getChangeRequest"; readonly reference: string }
  | {
      readonly operation: "checkoutChangeRequest";
      readonly reference: string;
      readonly force: boolean;
    }
  | { readonly operation: "getRepositoryCloneUrls"; readonly repository: string }
  | { readonly operation: "getDefaultBranch" };

export const listed = (calls: ReadonlyArray<FakeProviderCall>) =>
  calls.flatMap((call) => (call.operation === "listChangeRequests" ? [call] : []));

export const listedSelectors = (calls: ReadonlyArray<FakeProviderCall>) =>
  listed(calls).map((call) => call.headSelector);

export const created = (calls: ReadonlyArray<FakeProviderCall>) =>
  calls.flatMap((call) =>
    call.operation === "createChangeRequest"
      ? [{ baseRefName: call.baseRefName, headSelector: call.headSelector }]
      : [],
  );

export type FakeGitTextGeneration = TextGeneration.TextGeneration["Service"];

export function runGitSyncForFakeCheckout(cwd: string, args: readonly string[]): void {
  const result = NodeChildProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0) {
    return;
  }
  throw new Error(
    `Failed to simulate a host checkout with git ${args.join(" ")}: ${result.stderr?.trim() || "unknown error"}`,
  );
}

export function makeTempDir(
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });
}

export function removePath(
  targetPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.remove(targetPath, { recursive: true, force: true });
  });
}

export function makeDirectory(
  dirPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(dirPath, { recursive: true });
  });
}

export function runGit(
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

export function initRepo(
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
    // Override global autocrlf on Windows for LF assertions, including linked worktrees.
    yield* runGit(cwd, ["config", "core.autocrlf", "false"]);
    yield* fs.writeFileString(NodePath.join(cwd, "README.md"), "hello\n");
    yield* runGit(cwd, ["add", "README.md"]);
    yield* runGit(cwd, ["commit", "-m", "Initial commit"]);
  });
}

export function createBareRemote(): Effect.Effect<
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

export function configureRemote(
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

export function configureVisibleRemoteUrlWithLocalRewrite(
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

export function createTextGeneration(
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

/**
 * A host that answers from the scenario and records what it was asked, so tests assert on the
 * selectors GitManager chose rather than on any host's wire format.
 */

export function createFakeSourceControlProvider(scenario: FakeProviderScenario = {}): {
  service: SourceControlProvider["Service"];
  calls: FakeProviderCall[];
} {
  const kind = SourceControlProviderKind.make(scenario.kind ?? "github");
  const prListQueue = [...(scenario.prListSequence ?? [])];
  const prListQueueByHeadSelector = new Map(
    Object.entries(scenario.prListSequenceByHeadSelector ?? {}).map(([headSelector, values]) => [
      headSelector,
      [...values],
    ]),
  );
  const calls: FakeProviderCall[] = [];

  const record = (cwd: string, call: FakeProviderCall) =>
    Effect.suspend(() => {
      calls.push(call);
      return scenario.failWith && calls.length > (scenario.failAfterCalls ?? 0)
        ? Effect.fail(
            new SourceControlProviderFailure({
              provider: kind,
              operation: call.operation,
              cwd,
              detail: scenario.failWith,
              cause: scenario.failCause,
            }),
          )
        : Effect.void;
    });

  const toChangeRequest = (summary: FakeChangeRequest): ChangeRequest => ({
    ...summary,
    provider: kind,
    state: summary.state ?? "open",
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt:
      summary.updatedAt === undefined
        ? Option.none()
        : Option.some(DateTime.makeUnsafe(summary.updatedAt)),
  });

  const pullRequest = (): FakeChangeRequest =>
    scenario.pullRequest ?? {
      number: 101,
      title: "Pull request",
      url: "https://github.com/pingdotgg/codething-mvp/pull/101",
      baseRefName: "main",
      headRefName: "feature/pull-request",
      state: "open",
    };

  const checkout = (cwd: string, force: boolean) => {
    const headBranch = scenario.pullRequest?.headRefName;
    if (!headBranch) return;
    const existingBranch = NodeChildProcess.spawnSync(
      "git",
      ["show-ref", "--verify", "--quiet", `refs/heads/${headBranch}`],
      { cwd },
    );
    if (scenario.syncCheckoutWithPullHead) {
      runGitSyncForFakeCheckout(cwd, [
        "fetch",
        "origin",
        `refs/pull/${scenario.pullRequest?.number}/head`,
      ]);
      if (existingBranch.status === 0) {
        runGitSyncForFakeCheckout(cwd, ["checkout", headBranch]);
        runGitSyncForFakeCheckout(
          cwd,
          force ? ["reset", "--hard", "FETCH_HEAD"] : ["merge", "--ff-only", "FETCH_HEAD"],
        );
      } else {
        runGitSyncForFakeCheckout(cwd, ["checkout", "-b", headBranch, "FETCH_HEAD"]);
      }
    } else if (existingBranch.status === 0) {
      runGitSyncForFakeCheckout(cwd, ["checkout", headBranch]);
    } else {
      runGitSyncForFakeCheckout(cwd, ["checkout", "-b", headBranch]);
    }
  };

  const headBranchProbe =
    scenario.headBranchProbe === null
      ? {}
      : {
          headBranchProbe:
            scenario.headBranchProbe ??
            (({ headSelectors }: { readonly headSelectors: ReadonlyArray<string> }) => ({
              headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
              limit: 100,
            })),
        };

  return {
    service: {
      kind,
      ...headBranchProbe,
      listChangeRequests: (input) =>
        record(input.cwd, {
          operation: "listChangeRequests",
          headSelector: input.headSelector,
          state: input.state,
          limit: input.limit,
        }).pipe(
          Effect.map(() =>
            (
              prListQueueByHeadSelector.get(input.headSelector)?.shift() ??
              scenario.prListByHeadSelector?.[input.headSelector] ??
              prListQueue.shift() ??
              scenario.prListOtherwise ??
              []
            ).map(toChangeRequest),
          ),
          Effect.tap(() =>
            scenario.prListGate
              ? Deferred.succeed(scenario.prListGate.started, undefined).pipe(
                  Effect.andThen(Deferred.await(scenario.prListGate.release)),
                )
              : Effect.void,
          ),
        ),
      createChangeRequest: (input) =>
        record(input.cwd, {
          operation: "createChangeRequest",
          baseRefName: input.baseRefName,
          headSelector: input.headSelector,
          title: input.title,
        }),
      getDefaultBranch: (input) =>
        record(input.cwd, { operation: "getDefaultBranch" }).pipe(
          Effect.map(() => {
            const value = (scenario.defaultBranch ?? "main").trim();
            return value.length > 0 ? value : null;
          }),
        ),
      getChangeRequest: (input) =>
        record(input.cwd, { operation: "getChangeRequest", reference: input.reference }).pipe(
          Effect.map(() => toChangeRequest(pullRequest())),
        ),
      getRepositoryCloneUrls: (input) =>
        record(input.cwd, {
          operation: "getRepositoryCloneUrls",
          repository: input.repository,
        }).pipe(
          Effect.flatMap(() => {
            const repository = input.host ? `${input.host}/${input.repository}` : input.repository;
            const cloneUrls =
              scenario.repositoryCloneUrls?.[repository] ??
              (input.host === "github.com"
                ? scenario.repositoryCloneUrls?.[input.repository]
                : undefined);
            return cloneUrls
              ? Effect.succeed({ nameWithOwner: input.repository, ...cloneUrls })
              : Effect.fail(
                  new SourceControlProviderFailure({
                    provider: kind,
                    operation: "getRepositoryCloneUrls",
                    cwd: input.cwd,
                    detail: `Unexpected repository lookup: ${input.repository}`,
                  }),
                );
          }),
        ),
      createRepository: (input) =>
        Effect.fail(
          new SourceControlProviderFailure({
            provider: kind,
            operation: "createRepository",
            cwd: input.cwd,
            detail: `Unexpected repository create: ${input.repository}`,
          }),
        ),
      checkoutChangeRequest: (input) =>
        record(input.cwd, {
          operation: "checkoutChangeRequest",
          reference: input.reference,
          force: input.force ?? false,
        }).pipe(
          Effect.flatMap(() =>
            Effect.try({
              try: () => checkout(input.cwd, input.force ?? false),
              catch: (cause) =>
                new SourceControlProviderFailure({
                  provider: kind,
                  operation: "checkoutChangeRequest",
                  cwd: input.cwd,
                  detail: "Host checkout failed.",
                  cause,
                }),
            }),
          ),
        ),
    },
    calls,
  };
}

/**
 * Reads a template from the base tree the way a host would, without any host's own lookup
 * rules, so tests see which tree GitManager reads it from.
 */

export const readFakeChangeRequestTemplate = Effect.fnUntraced(function* (input: {
  readonly cwd: string;
  readonly treeish: string;
}) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const result = yield* git
    .execute({
      operation: "GitManager.test.readTemplate",
      cwd: input.cwd,
      args: ["show", `${input.treeish}:.github/pull_request_template.md`],
      allowNonZeroExit: true,
    })
    .pipe(Effect.orDie);
  const template = result.stdout.trim();
  return result.exitCode === 0 && template.length > 0 ? Option.some(template) : Option.none();
});

export function runStackedAction(
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

export function preparePullRequestThread(
  manager: GitManager.GitManager["Service"],
  input: GitPreparePullRequestThreadInput,
) {
  return manager.preparePullRequestThread(input);
}

export function makeManager(input?: {
  providerScenario?: FakeProviderScenario;
  sourceControlProvider?: SourceControlProvider["Service"];
  textGeneration?: Partial<FakeGitTextGeneration>;
  serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  setupScriptRunner?: ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"];
  gitConfigReads?: string[];
  gitCommands?: string[];
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
  const { service: fakeProvider, calls: providerCalls } = createFakeSourceControlProvider(
    input?.providerScenario,
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
                ? command.args.map(String)
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
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))
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
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(layerServerConfig),
  );
  const layerSourceControlRegistry = Layer.effect(
    SourceControlProviderRegistry.SourceControlProviderRegistry,
    Effect.gen(function* () {
      const context = yield* Effect.context<GitVcsDriver.GitVcsDriver>();
      return (
        input?.sourceControlProvider ?? {
          ...fakeProvider,
          readChangeRequestTemplate: (template: { cwd: string; treeish: string }) =>
            readFakeChangeRequestTemplate(template).pipe(Effect.provideContext(context)),
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
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
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
      Effect.provide(layerManager),
      Effect.provideContext(stores),
    );
    return { manager, providerCalls };
  });
}

export const asThreadId = (threadId: string) => threadId as ThreadId;

export const layerGitManagerTest = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-manager-test-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

export function squashMergeIntoRemoteMain(repoDir: string, branch: string) {
  return Effect.gen(function* () {
    yield* runGit(repoDir, ["push", "-u", "origin", "main"]);
    yield* runGit(repoDir, ["checkout", "-b", branch]);
    NodeFS.writeFileSync(NodePath.join(repoDir, "squash.txt"), "one\ntwo\n");
    yield* runGit(repoDir, ["add", "squash.txt"]);
    yield* runGit(repoDir, ["commit", "-m", "Feature work"]);
    yield* runGit(repoDir, ["push", "-u", "origin", branch]);
    // The host squash-merges: a new commit on main with the branch's tree, not the branch's commit.
    const squash = yield* runGit(repoDir, [
      "commit-tree",
      "HEAD^{tree}",
      "-p",
      "origin/main",
      "-m",
      "Feature work (#217)",
    ]);
    yield* runGit(repoDir, ["push", "origin", `${squash.stdout.trim()}:refs/heads/main`]);
    return (yield* runGit(repoDir, ["rev-parse", "HEAD"])).stdout.trim();
  });
}

export const squashMergedPr = (branch: string, headSha: string): FakeChangeRequest => ({
  number: 217,
  title: "Feature work",
  url: "https://github.com/pingdotgg/t3code/pull/217",
  baseRefName: "main",
  headRefName: branch,
  headSha,
  state: "merged",
  mergedAt: "2026-04-02T15:00:00Z",
  updatedAt: "2026-04-02T15:00:00Z",
});

export const setUpLocalCheckoutPullRequest = Effect.fnUntraced(function* (
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
  const { manager, providerCalls } = yield* makeManager({
    ...(gitSpawnGate ? { gitSpawnGate } : {}),
    providerScenario: {
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
  return { repoDir, manager, providerCalls, firstCommit, pullHead };
});

