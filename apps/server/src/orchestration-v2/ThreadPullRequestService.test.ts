import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { EventId } from "@t3tools/contracts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

const GITHUB_REMOTE = "https://github.com/pingdotgg/t3code.git";

// The real GitManager and GitHub driver over a local repository whose origin names GitHub but
// pushes to a bare remote. Only the network and the gh CLI are fakes: GitHub answers each
// GraphQL request from memory and records it, and gh hands out a token.
const makeGitHubBackedGitManager = (
  branch: string,
  pullRequest: { readonly number: number; readonly title: string; readonly url: string },
) =>
  Effect.gen(function* () {
    const hostRequests: Array<string> = [];
    const openPullRequest = {
      ...pullRequest,
      baseRefName: "main",
      headRefName: branch,
      headRefOid: "f".repeat(40),
      state: "OPEN",
      isDraft: false,
      mergedAt: null,
      closedAt: null,
      isCrossRepository: false,
      updatedAt: "2026-08-01T00:00:00Z",
      headRepository: { name: "t3code", nameWithOwner: "pingdotgg/t3code" },
      headRepositoryOwner: { __typename: "Organization", login: "pingdotgg" },
    };
    const gitHub = HttpClient.make((request) =>
      Effect.sync(() => {
        const sent: { readonly variables?: Readonly<Record<string, unknown>> } =
          request.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : {};
        const variables = sent.variables ?? {};
        // A batched document aliases each lookup's variables and result as `_<n>_`.
        const aliases = [
          ...new Set(Object.keys(variables).flatMap((key) => /^_\d+_/.exec(key) ?? [])),
        ];
        const lookups = aliases.length === 0 ? [""] : aliases;
        const heads = lookups.map((alias) => String(variables[`${alias}head`]));
        hostRequests.push(`${request.method} ${request.url} ${heads.join(",")}`);
        const data = Object.fromEntries(
          lookups.map((alias, index) => [
            `${alias}repository`,
            { pullRequests: { nodes: heads[index] === branch ? [openPullRequest] : [] } },
          ]),
        );
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ data }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );
    const platform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
    const stores = yield* Layer.build(
      Layer.merge(ProjectionStore.layer, ProjectStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        Layer.mock(TextGeneration.TextGeneration)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
        ServerSettings.ServerSettingsService.layerTest(),
        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
      ).pipe(
        Layer.provideMerge(
          GitVcsDriver.layer.pipe(
            Layer.provideMerge(VcsProcess.layer),
            Layer.provideMerge(platform),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-pr-test-" }),
            ),
          ),
        ),
        Layer.provideMerge(platform),
      ),
    );
    const vcsProcess = Context.get(services, VcsProcess.VcsProcess);
    const sourceControlHost = TestSourceControlHost.layer({
      process: {
        run: (input) =>
          input.command === "gh"
            ? Effect.succeed(
                TestSourceControlHost.processOutput(input.args[0] === "auth" ? "token\n" : ""),
              )
            : vcsProcess.run(input),
      },
    });
    const driver = yield* GitHubDriver.driver.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          sourceControlHost,
          SourceControlRateLimit.layer,
          Layer.succeed(HttpClient.HttpClient, gitHub),
          platform,
        ),
      ),
      // GH_HOST, GH_REPO or a token in the test's own environment must not steer the lookup.
      Effect.provideService(HostProcess.Environment, {}),
    );
    const registry = yield* SourceControlProviderRegistry.makeWithProviders([
      {
        kind: GitHubDriver.driver.kind,
        provider: driver.sourceControl,
        discovery: driver.discovery,
      },
    ]).pipe(Effect.provide(sourceControlHost), Effect.provideContext(services));
    const workspaceRoot = yield* Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const vcs = yield* GitVcsDriver.GitVcsDriver;
      const git = (cwd: string, args: ReadonlyArray<string>) =>
        vcs.execute({ operation: "ThreadPullRequestService.test.git", cwd, args });
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-pr-" });
      const repository = path.join(root, "project");
      const remote = path.join(root, "remote.git");
      yield* fileSystem.makeDirectory(repository);
      yield* git(root, ["init", "--bare", remote]);
      yield* git(repository, ["init", "--initial-branch=main"]);
      yield* git(repository, ["config", "user.email", "test@example.com"]);
      yield* git(repository, ["config", "user.name", "Test User"]);
      yield* git(repository, ["commit", "--allow-empty", "-m", "initial"]);
      yield* git(repository, ["checkout", "-b", branch]);
      yield* git(repository, ["remote", "add", "origin", GITHUB_REMOTE]);
      yield* git(repository, ["remote", "set-url", "--push", "origin", remote]);
      yield* git(repository, ["push", "-u", "origin", branch]);
      return repository;
    }).pipe(Effect.provideContext(services));
    const manager = yield* GitManager.make.pipe(
      Effect.provideContext(
        Context.merge(services, stores).pipe(
          Context.add(SourceControlProviderRegistry.SourceControlProviderRegistry, registry),
        ),
      ),
    );
    return { workspaceRoot, git: manager, hostRequests };
  });

describe("ThreadPullRequestServiceV2 project guard", () => {
  it("rejects a pull-request result when the project root changes before dispatch", () => {
    const currentProject = Option.some({
      workspaceRoot: "/workspace/replaced",
    } satisfies Pick<OrchestrationProjectShell, "workspaceRoot">);

    expect(
      ThreadPullRequestService.projectWorkspaceMatchesSnapshot(
        currentProject,
        "/workspace/original",
      ),
    ).toBe(false);
  });
});

describe("ThreadPullRequestServiceV2 reads", () => {
  const NOW = DateTime.makeUnsafe("2026-09-20T00:00:00.000Z");
  const threadShell = (id: string): OrchestrationV2ThreadShell => {
    const threadId = ThreadId.make(id);
    return {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: id,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      activeRunId: null,
      latestRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
  };

  it.effect("does not sweep branch pull requests while no client is connected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Polling active branches without a connected client wastes GitHub requests.
        const thread = { ...threadShell("idle-branch-thread"), branch: "feature/idle" };
        const project: OrchestrationProjectShell = {
          id: thread.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const turnLookup = yield* Deferred.make<void>();
        const lookups: Array<{ readonly refresh: boolean }> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(domainEvents),
            getPullRequestSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads: [thread],
                archivedThreads: [],
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (_input, options) =>
              Effect.gen(function* () {
                const refresh = options?.refresh ?? false;
                lookups.push({ refresh });
                if (refresh) yield* Deferred.succeed(turnLookup, undefined);
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          // No client holds an activity lease.
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
            shouldRunOpportunisticWork: Effect.succeed(false),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);

          // A finished turn still discovers the pull request for its branch.
          yield* Queue.offer(domainEvents, {
            type: "run.updated",
            threadId: thread.id,
            payload: { status: "completed" },
          } as OrchestrationV2DomainEvent);
          yield* Deferred.await(turnLookup);
          yield* service.drain;
          const lookupsBeforeIdle = lookups.length;

          yield* TestClock.adjust("10 minutes");
          yield* service.drain;

          expect(lookups.slice(lookupsBeforeIdle)).toEqual([]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );

  // Live clock: real git subprocesses, and the GitHub driver batches lookups over a short window.
  it.live.each([
    {
      commit: "a finished turn",
      // Checkpoint capture commits the thread-start and baseline checkpoints, the run's own
      // checkpoint and the run's end together.
      events: [
        { type: "checkpoint.captured" },
        { type: "checkpoint.captured" },
        { type: "checkpoint.captured" },
        { type: "run.updated", payload: { status: "completed" } },
      ],
    },
    {
      commit: "rolling back one turn",
      // Rollback marks the turn's checkpoints stale and ends with one update per rolled-back run.
      events: [
        { type: "checkpoint.captured", payload: { status: "stale" } },
        { type: "checkpoint.captured", payload: { status: "stale" } },
        { type: "run.updated", payload: { status: "rolled_back" } },
      ],
    },
  ])("reads the branch pull request from the host once for $commit", ({ events }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { workspaceRoot, git, hostRequests } = yield* makeGitHubBackedGitManager(
          "feature/turn",
          {
            number: 7,
            title: "Turn work",
            url: "https://github.com/pingdotgg/t3code/pull/7",
          },
        );
        let thread: OrchestrationV2ThreadShell = {
          ...threadShell("turn-thread"),
          branch: "feature/turn",
        };
        const project: OrchestrationProjectShell = {
          id: thread.projectId,
          title: "Project",
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const startupLinked = yield* Deferred.make<void>();
        const startupDrained = yield* Deferred.make<void>();
        const commitDelivered = yield* Deferred.make<void>();
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.unwrap(
              Deferred.await(startupDrained).pipe(
                Effect.as(
                  Stream.fromIterable(
                    events.map(
                      (event) => ({ ...event, threadId: thread.id }) as OrchestrationV2DomainEvent,
                    ),
                  ),
                ),
              ),
            ).pipe(
              Stream.concat(
                Stream.unwrap(
                  Deferred.succeed(commitDelivered, undefined).pipe(Effect.as(Stream.never)),
                ),
              ),
            ),
            getPullRequestSnapshot: () =>
              Effect.sync(() => ({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads: [thread],
                archivedThreads: [],
              })),
            dispatch: (command) =>
              Effect.gen(function* () {
                if (command.type === "thread.pull-request.sync") {
                  thread = { ...thread, branchPullRequest: command.branchPullRequest };
                  yield* Deferred.succeed(startupLinked, undefined);
                }
                return { sequence: 2, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.succeed(GitManager.GitManager, git),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/pingdotgg/t3code",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: GITHUB_REMOTE,
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "pingdotgg",
                name: "t3code",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
            shouldRunOpportunisticWork: Effect.succeed(false),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          // The startup sweep finds the pull request with one cold lookup and links it.
          yield* Deferred.await(startupLinked);
          yield* service.drain;
          const oneLookup = hostRequests.splice(0);
          expect(oneLookup.length).toBeGreaterThan(0);

          yield* Deferred.succeed(startupDrained, undefined);
          yield* Deferred.await(commitDelivered);
          yield* service.drain;

          expect(hostRequests).toEqual(oneLookup);
          expect(thread.branchPullRequest).toMatchObject({
            number: 7,
            url: "https://github.com/pingdotgg/t3code/pull/7",
          });
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );

  it.effect.each([
    {
      worktree: "a linked worktree",
      existingPaths: ["/workspace/worktree", "/workspace/worktree/.git"],
      unreadablePaths: [],
      cwd: "/workspace/worktree",
    },
    // A folder that outlived its .git makes git fail with not_a_repository.
    {
      worktree: "a folder without .git",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: [],
      cwd: "/workspace/project",
    },
    {
      worktree: "a folder whose .git cannot be checked",
      existingPaths: ["/workspace/worktree"],
      unreadablePaths: ["/workspace/worktree/.git"],
      cwd: "/workspace/worktree",
    },
    {
      worktree: "a missing folder",
      existingPaths: [],
      unreadablePaths: [],
      cwd: "/workspace/project",
    },
  ] as const)(
    "looks up a branch whose worktree is $worktree in $cwd",
    ({ existingPaths, unreadablePaths, cwd }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const thread = {
            ...threadShell("worktree-thread"),
            settledOverride: "settled" as const,
            settledAt: NOW,
            branch: "feature/worktree",
            worktreePath: "/workspace/worktree",
          };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const lookupCwds: Array<string> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [thread],
                    archivedThreads: [],
                  }),
                ),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: (input) =>
                Effect.sync(() => {
                  lookupCwds.push(input.cwd);
                  return null;
                }),
            }),
            Layer.mock(PullRequestService.PullRequestService)({}),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({
              exists: (path) =>
                unreadablePaths.some((entry) => entry === path)
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "exists",
                        pathOrDescriptor: path,
                      }),
                    )
                  : Effect.succeed(existingPaths.some((entry) => entry === path)),
            }),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(Effect.provide(dependencies));

          expect(lookupCwds).toEqual([cwd]);
        }),
      ),
  );

  it.effect("leaves delegated child threads to their own refresh instead of the sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const parent = {
          ...threadShell("parent-thread"),
          branch: "feature/parent",
          worktreePath: "/workspace/parent",
        };
        const child: OrchestrationV2ThreadShell = {
          ...threadShell("child-thread"),
          branch: "t3/reply-ok",
          worktreePath: "/workspace/child",
          lineage: {
            rootThreadId: parent.id,
            parentThreadId: parent.id,
            relationshipToParent: "subagent",
          },
        };
        const project: OrchestrationProjectShell = {
          id: parent.projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        };
        const activation = yield* Deferred.make<void>();
        const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
        const sweeps = yield* Queue.unbounded<void>();
        const childLookup = yield* Deferred.make<void>();
        const lookups: Array<{ readonly branch: string; readonly refresh: boolean }> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(domainEvents),
            getPullRequestSnapshot: ({ threadId }) =>
              threadId !== undefined
                ? Effect.succeed({ snapshotSequence: 1, threads: [child] })
                : Queue.offer(sweeps, undefined).pipe(
                    Effect.as({
                      schemaVersion: 2,
                      snapshotSequence: 1,
                      threads: [parent, child],
                      archivedThreads: [],
                    }),
                  ),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeedSome(project),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (input, options) =>
              Effect.gen(function* () {
                const refresh = options?.refresh ?? false;
                lookups.push({ branch: input.branch, refresh });
                if (input.branch === child.branch && refresh) {
                  yield* Deferred.succeed(childLookup, undefined);
                }
                return null;
              }),
          }),
          Layer.mock(PullRequestService.PullRequestService)({}),
          Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
            resolve: () =>
              Effect.succeed({
                canonicalKey: "github.com/acme/project",
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: "git@github.com:acme/project.git",
                },
                provider: SourceControlProviderKind.make("github"),
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(true),
            shouldRunOpportunisticWork: Effect.succeed(true),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(1)),
          ),
          FileSystem.layerNoop({}),
          Path.layer,
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);

          // Startup backfill sweep, then one periodic sweep.
          yield* Queue.take(sweeps);
          yield* service.drain;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          yield* service.drain;
          const sweepLookups = lookups.map((lookup) => lookup.branch).toSorted();

          // The child's own turn still discovers its pull request.
          yield* Queue.offer(domainEvents, {
            type: "run.updated",
            threadId: child.id,
            payload: { status: "completed" },
          } as OrchestrationV2DomainEvent);
          yield* Deferred.await(childLookup);
          yield* service.drain;

          expect(sweepLookups).toEqual([parent.branch, parent.branch]);
          expect(lookups.slice(sweepLookups.length)).toEqual([
            { branch: child.branch, refresh: true },
          ]);
        }).pipe(Effect.provide(dependencies));
      }),
    ),
  );

  it.effect.each([
    { state: "closed", sameBranch: false },
    { state: "merged", sameBranch: false },
    { state: "closed", sameBranch: true },
    { state: "merged", sameBranch: true },
  ] as const)(
    "restores a $state automatic PR only for its own branch (sameBranch=$sameBranch)",
    ({ state, sameBranch }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const savedReference = {
            projectId: ProjectId.make("project-1"),
            repository: "acme/project",
            number: 42,
            url: "https://github.com/acme/project/pull/42",
          };
          const thread = {
            ...threadShell("branch-pr-thread"),
            branch: "main",
            branchPullRequest: savedReference,
            linkedPullRequest: savedReference,
          };
          const project: OrchestrationProjectShell = {
            id: thread.projectId,
            title: "Project",
            workspaceRoot: "/workspace/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
          };
          const activation = yield* Deferred.make<void>();
          const sweepStarted = yield* Deferred.make<void>();
          const commands: Array<OrchestrationV2ServerCommand> = [];
          const dependencies = Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              getPullRequestSnapshot: (options) =>
                Effect.gen(function* () {
                  const store = yield* ProjectionStore.ProjectionStoreV2;
                  yield* store.apply({
                    id: EventId.make(`event:${thread.id}:created`),
                    type: "thread.created",
                    threadId: thread.id,
                    occurredAt: NOW,
                    payload: { ...thread, lastVisitedAt: thread.lastVisitedAt ?? null },
                  });
                  const sql = yield* SqlClient.SqlClient;
                  yield* sql`INSERT INTO orchestration_events (
                    sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
                    occurred_at, actor_kind, payload_json, metadata_json, application_event_version
                  ) VALUES (7, 'pr-discovery', 'thread', ${thread.id}, 1, 'thread.created',
                    '2026-09-20T00:00:00.000Z', 'system', '{}', '{}', 2)`;
                  for (const table of [
                    "orchestration_v2_projection_turn_items",
                    "orchestration_v2_projection_messages",
                    "orchestration_v2_projection_provider_threads",
                    "orchestration_v2_projection_runs",
                  ])
                    yield* sql.unsafe(`DROP TABLE ${table}`);
                  const snapshot = yield* store.getPullRequestSnapshot(options);
                  yield* Deferred.succeed(sweepStarted, undefined);
                  return snapshot;
                }).pipe(
                  Effect.provide(
                    ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
                  ),
                  Effect.orDie,
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 2, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeedSome(project),
            }),
            Layer.mock(GitManager.GitManager)({
              branchPullRequest: () => Effect.succeed(null),
            }),
            Layer.mock(PullRequestService.PullRequestService)({
              summary: () =>
                Effect.succeed({
                  ...savedReference,
                  provider: SourceControlProviderKind.make("github"),
                  title: "Previous branch work",
                  state,
                  headBranch: sameBranch ? thread.branch : "feature/previous-work",
                  baseBranch: "release",
                  updatedAt: "2026-09-19T00:00:00.000Z",
                }),
            }),
            Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
              resolve: () =>
                Effect.succeed({
                  canonicalKey: "github.com/acme/project",
                  locator: {
                    source: "git-remote" as const,
                    remoteName: "origin",
                    remoteUrl: "git@github.com:acme/project.git",
                  },
                  provider: SourceControlProviderKind.make("github"),
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              SecureRandom.SecureRandom,
              SecureRandom.make((size) => new Uint8Array(size).fill(1)),
            ),
            FileSystem.layerNoop({}),
            Path.layer,
          );
          yield* Effect.gen(function* () {
            const service = yield* ThreadPullRequestService.make;
            yield* service.start();
            yield* Deferred.succeed(activation, undefined);
            yield* Deferred.await(sweepStarted);
            yield* service.drain;
          }).pipe(Effect.provide(dependencies));

          if (sameBranch) {
            expect(commands).toEqual([]);
          } else {
            expect(commands).toHaveLength(1);
            expect(commands[0]).toMatchObject({
              type: "thread.pull-request.sync",
              threadId: thread.id,
              snapshotSequence: 7,
              expected: {
                workspaceRoot: project.workspaceRoot,
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                linkedPullRequest: savedReference,
                branchPullRequest: savedReference,
              },
              branchPullRequest: null,
            });
            expect(commands[0]).not.toHaveProperty("linkedPullRequest");
          }
        }),
      ),
  );
});
