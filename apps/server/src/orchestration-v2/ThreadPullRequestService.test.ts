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
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadPullRequestService from "./ThreadPullRequestService.ts";

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
        // Reproduces #23702: an idle server with one active branch thread kept
        // calling GitHub for that branch every minute with no client connected.
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
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 2,
                snapshotSequence: 1,
                threads: [thread],
                archivedThreads: [],
              }),
            getThreadEventSequence: () => Effect.succeed(1),
            getThreadShell: () => Effect.succeed(thread),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeed(Option.some(project)),
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
                provider: "github" as const,
                owner: "acme",
                name: "project",
              }),
          }),
          // No client holds an activity lease.
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            hasDemand: () => Effect.succeed(false),
            shouldRunScopeWork: () => Effect.succeed(false),
            shouldRunOpportunisticWork: Effect.succeed(false),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);

          // A finished turn still discovers the pull request for its branch.
          yield* Queue.offer(domainEvents, {
            type: "checkpoint.captured",
            threadId: thread.id,
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
              getShellSnapshot: () =>
                Deferred.succeed(sweepStarted, undefined).pipe(
                  Effect.as({
                    schemaVersion: 2,
                    snapshotSequence: 1,
                    threads: [thread],
                    archivedThreads: [],
                  }),
                ),
              dispatch: (command) =>
                Effect.sync(() => {
                  commands.push(command);
                  return { sequence: 2, storedEvents: [] };
                }),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              listShells: () => Effect.succeed([project]),
              getShell: () => Effect.succeed(Option.some(project)),
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
                  provider: "github" as const,
                  owner: "acme",
                  name: "project",
                }),
            }),
            Layer.mock(BackgroundPolicy.BackgroundPolicy)({}),
            Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
            Layer.succeed(
              Crypto.Crypto,
              Crypto.make({
                randomBytes: (size) => new Uint8Array(size).fill(1),
                digest: (_algorithm, data) => Effect.succeed(data),
              }),
            ),
            FileSystem.layerNoop({}),
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
              branchPullRequest: null,
            });
            expect(commands[0]).not.toHaveProperty("linkedPullRequest");
          }
        }),
      ),
  );

  it.effect("a saved merged branch PR rereads no git state on each sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const savedReference = {
          projectId: ProjectId.make("project-1"),
          repository: "acme/project",
          number: 42,
          url: "https://github.com/acme/project/pull/42",
        };
        const thread = {
          ...threadShell("merged-branch-thread"),
          branch: "feature/merged",
          branchPullRequest: savedReference,
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
        const sweeps = yield* Queue.unbounded<void>();
        const commands: Array<OrchestrationV2ServerCommand> = [];
        const lookups: Array<Parameters<GitManager.GitManager["Service"]["branchPullRequest"]>[1]> =
          [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getShellSnapshot: () =>
              Queue.offer(sweeps, undefined).pipe(
                Effect.as({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: [thread],
                  archivedThreads: [],
                }),
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: 2, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeed(Option.some(project)),
          }),
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (_input, options) =>
              Effect.sync(() => {
                lookups.push(options);
                return {
                  number: 42,
                  title: "Merged work",
                  url: savedReference.url,
                  baseRef: "main",
                  headRef: thread.branch,
                  state: "merged" as const,
                  repositoryKey: "github.com/acme/project",
                  updatedAt: "2026-09-19T00:00:00.000Z",
                  closedAt: null,
                  mergedAt: "2026-09-19T00:00:00.000Z",
                };
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
                provider: "github" as const,
                owner: "acme",
                name: "project",
              }),
          }),
          // A connected client keeps the periodic sweep running.
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunOpportunisticWork: Effect.succeed(true),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Queue.take(sweeps);
          yield* service.drain;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          yield* service.drain;
        }).pipe(Effect.provide(dependencies));

        expect(commands).toEqual([]);
        expect(lookups).toHaveLength(2);
        // GitManager rereads git state on request, and by default whenever its
        // remembered answer is merged or closed.
        expect(
          lookups.filter(
            (options) =>
              options?.refresh === true ||
              options?.freshGitState === true ||
              options?.confirmTerminal !== false,
          ),
        ).toEqual([]);
      }),
    ),
  );

  const mergedPullRequest43 = {
    number: 43,
    title: "Replacement work",
    url: "https://github.com/acme/project/pull/43",
    baseRef: "main",
    headRef: "feature/replaced",
    state: "merged" as const,
    repositoryKey: "github.com/acme/project",
    updatedAt: "2026-09-19T00:00:00.000Z",
    closedAt: null,
    mergedAt: "2026-09-19T00:00:00.000Z",
  };

  it.effect.each([
    { name: "reopened", fresh: { ...mergedPullRequest43, state: "open" as const }, writes: false },
    {
      name: "a different PR",
      fresh: { ...mergedPullRequest43, number: 44, url: "https://github.com/acme/project/pull/44" },
      writes: false,
    },
    { name: "no PR", fresh: null, writes: false },
    { name: "the same merged PR", fresh: mergedPullRequest43, writes: true },
  ])("saves a remembered merged PR only when fresh git state finds $name", ({ fresh, writes }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const savedReference = {
          projectId: ProjectId.make("project-1"),
          repository: "acme/project",
          number: 42,
          url: "https://github.com/acme/project/pull/42",
        };
        const thread = {
          ...threadShell("replaced-branch-thread"),
          branch: mergedPullRequest43.headRef,
          branchPullRequest: savedReference,
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
        const sweeps = yield* Queue.unbounded<void>();
        const commands: Array<OrchestrationV2ServerCommand> = [];
        const dependencies = Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            getShellSnapshot: () =>
              Queue.offer(sweeps, undefined).pipe(
                Effect.as({
                  schemaVersion: 2,
                  snapshotSequence: 1,
                  threads: [thread],
                  archivedThreads: [],
                }),
              ),
            dispatch: (command) =>
              Effect.sync(() => {
                commands.push(command);
                return { sequence: 2, storedEvents: [] };
              }),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () => Effect.succeed([project]),
            getShell: () => Effect.succeed(Option.some(project)),
          }),
          // Only the fresh read disagrees with the remembered detection.
          Layer.mock(GitManager.GitManager)({
            branchPullRequest: (_input, options) =>
              Effect.succeed(options?.freshGitState === true ? fresh : mergedPullRequest43),
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
                provider: "github" as const,
                owner: "acme",
                name: "project",
              }),
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunOpportunisticWork: Effect.succeed(true),
          }),
          Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
          FileSystem.layerNoop({}),
        );
        yield* Effect.gen(function* () {
          const service = yield* ThreadPullRequestService.make;
          yield* service.start();
          yield* Deferred.succeed(activation, undefined);
          yield* Queue.take(sweeps);
          yield* service.drain;
        }).pipe(Effect.provide(dependencies));

        expect(
          commands.map((command) =>
            command.type === "thread.pull-request.sync" ? command.branchPullRequest : command.type,
          ),
        ).toEqual(
          writes
            ? [
                {
                  projectId: project.id,
                  repository: "acme/project",
                  number: 43,
                  url: mergedPullRequest43.url,
                },
              ]
            : [],
        );
      }),
    ),
  );
});
