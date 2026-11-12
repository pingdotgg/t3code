import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type PullRequestSummary,
  type ThreadId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as Orchestrator from "./Orchestrator.ts";

class ThreadPullRequestServiceV2 extends Context.Service<
  ThreadPullRequestServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadPullRequestService/ThreadPullRequestServiceV2") {}

function samePullRequest(
  left: ThreadLinkedPullRequest | null | undefined,
  right: ThreadLinkedPullRequest | null,
): boolean {
  if (left == null || right === null) return left == null && right === null;
  return (
    left.projectId === right.projectId &&
    left.repository.toLowerCase() === right.repository.toLowerCase() &&
    left.number === right.number &&
    left.url === right.url
  );
}

function pullRequestPredatesThread(
  pullRequest: Pick<PullRequestSummary, "state" | "closedAt" | "mergedAt">,
  createdAt: DateTime.Utc,
): boolean {
  const terminalAt =
    pullRequest.state === "merged"
      ? pullRequest.mergedAt
      : pullRequest.state === "closed"
        ? pullRequest.closedAt
        : null;
  return terminalAt != null && Date.parse(terminalAt) < DateTime.toEpochMillis(createdAt);
}

function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: OrchestrationProjectShell,
): boolean {
  return (
    pullRequest.repositoryKey !== null &&
    project.repositoryIdentity != null &&
    sourceControlDefinitions.canonicalRepositoryKey(pullRequest.repositoryKey) ===
      sourceControlDefinitions.canonicalRepositoryKey(project.repositoryIdentity.canonicalKey)
  );
}

const resolveProjectForPullRequestDiscovery = Effect.fn(
  "ThreadPullRequestServiceV2.resolveProject",
)(function* (
  project: OrchestrationProjectShell,
  repositoryIdentities: RepositoryIdentityResolver.RepositoryIdentityResolver["Service"],
  options?: { readonly refresh?: boolean },
) {
  // Post-turn discovery refreshes 15-minute identity caches because agents may add remotes.
  const repositoryIdentity = yield* repositoryIdentities.resolve(project.workspaceRoot, {
    refresh: options?.refresh ?? false,
  });
  return {
    project: { ...project, repositoryIdentity },
    repository: sourceControlDefinitions.repositorySelector(repositoryIdentity),
  };
});

export function projectWorkspaceMatchesSnapshot(
  currentProject: Option.Option<Pick<OrchestrationProjectShell, "workspaceRoot">>,
  expectedWorkspaceRoot: string,
): boolean {
  return (
    Option.isSome(currentProject) && currentProject.value.workspaceRoot === expectedWorkspaceRoot
  );
}

const BACKFILL_ATTEMPTS = 5;

interface RefreshRequest {
  readonly threadId: ThreadId | null;
  readonly refresh: boolean;
  readonly backfill?: boolean;
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const random = yield* SecureRandom.SecureRandom;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const pendingBackfill = new Map<ThreadId, number>();

  const finishBackfill = (threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id">>) => {
    for (const thread of threads) pendingBackfill.delete(thread.id);
  };
  const failBackfill = (threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id">>) => {
    for (const thread of threads) {
      const remaining = pendingBackfill.get(thread.id);
      if (remaining === undefined) continue;
      if (remaining <= 1) pendingBackfill.delete(thread.id);
      else pendingBackfill.set(thread.id, remaining - 1);
    }
  };

  const readThreadSnapshot = ({ threadId, backfill }: RefreshRequest) =>
    orchestrator.getPullRequestSnapshot(
      threadId === null ? { unsettledOnly: !(backfill || pendingBackfill.size > 0) } : { threadId },
    );

  const synchronize = Effect.fn("ThreadPullRequestServiceV2.synchronize")(function* (
    request: RefreshRequest,
  ) {
    const [threadSnapshot, projectShells] = yield* Effect.all([
      readThreadSnapshot(request),
      projectStore.listShells(),
    ]);
    // Subagent children refresh after their own runs; sweeping them costs a lookup each per minute.
    const snapshotThreads =
      request.threadId === null
        ? threadSnapshot.threads.filter(
            (thread) => thread.lineage.relationshipToParent !== "subagent",
          )
        : threadSnapshot.threads;
    const projects = new Map(projectShells.map((project) => [project.id, project]));
    if (request.backfill) {
      for (const thread of snapshotThreads) {
        if (
          (thread.settledOverride === "settled" || thread.settledAt !== null) &&
          thread.branchPullRequest == null
        ) {
          pendingBackfill.set(thread.id, BACKFILL_ATTEMPTS);
        }
      }
    }
    const visibleThreadIds = new Set(
      snapshotThreads.filter((thread) => thread.branch !== null).map((thread) => thread.id),
    );
    const checkedIds = request.threadId === null ? [...pendingBackfill.keys()] : [request.threadId];
    for (const threadId of checkedIds) {
      if (!visibleThreadIds.has(threadId)) pendingBackfill.delete(threadId);
    }
    const threads = snapshotThreads.filter(
      (thread) =>
        thread.archivedAt === null &&
        ((thread.settledOverride !== "settled" && thread.settledAt === null) ||
          request.threadId !== null ||
          pendingBackfill.has(thread.id)) &&
        (thread.branch !== null || thread.branchPullRequest != null),
    );
    const groups = Map.groupBy(threads, (thread) =>
      JSON.stringify([thread.projectId, thread.worktreePath, thread.branch]),
    );

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const first = group[0]!;
          const project = projects.get(first.projectId);
          if (project === undefined) return finishBackfill(group);
          const { project: resolvedProject, repository } =
            yield* resolveProjectForPullRequestDiscovery(project, repositoryIdentities, {
              refresh: request.refresh,
            });
          if (first.branch !== null && repository === null) return finishBackfill(group);
          // A worktree folder can outlive its .git, and git there fails with not_a_repository.
          // An unreadable .git keeps the worktree rather than failing the whole group.
          const cwd =
            first.worktreePath !== null &&
            (yield* fileSystem
              .exists(path.join(first.worktreePath, ".git"))
              .pipe(Effect.orElseSucceed(() => true)))
              ? first.worktreePath
              : project.workspaceRoot;
          // A detected PR is confirmed against fresh git state before it is saved.
          const detected =
            first.branch === null
              ? null
              : yield* git.branchPullRequest(
                  { cwd, branch: first.branch },
                  { refresh: request.refresh, confirmTerminal: false },
                );
          if (detected !== null && !pullRequestMatchesProject(detected, resolvedProject)) {
            return finishBackfill(group);
          }
          const detectedReference =
            detected !== null && repository !== null
              ? {
                  projectId: project.id,
                  repository,
                  number: detected.number,
                  url: detected.url,
                }
              : null;

          // Only a new association is refused: a thread keeps a PR it already saved, and a PR the
          // user checked out stays with the threads made for it, however long ago it closed.
          const isHistoricalFor = (thread: (typeof group)[number]) =>
            detected !== null &&
            pullRequestPredatesThread(detected, thread.createdAt) &&
            !samePullRequest(thread.branchPullRequest, detectedReference);
          const dropsHistorical =
            detected !== null &&
            first.branch !== null &&
            group.some(isHistoricalFor) &&
            !(yield* git.checkedOutPullRequest({ cwd, branch: first.branch, url: detected.url }));

          const plans = yield* Effect.forEach(group, (thread) =>
            Effect.gen(function* () {
              let branchPullRequest =
                dropsHistorical && isHistoricalFor(thread) ? null : detectedReference;
              if (
                branchPullRequest === null &&
                thread.branch !== null &&
                thread.worktreePath === null &&
                thread.branchPullRequest != null
              ) {
                const previous = yield* pullRequests.summary(thread.branchPullRequest, {
                  recoverTransientFailure: false,
                });
                if (
                  previous.headBranch === thread.branch &&
                  (previous.state === "merged" || previous.state === "closed")
                ) {
                  branchPullRequest = thread.branchPullRequest;
                }
              }

              let replacement: ThreadLinkedPullRequest | undefined;
              if (
                (thread.pullRequests ?? []).length === 0 &&
                thread.linkedPullRequest != null &&
                detected?.state === "open" &&
                detectedReference !== null &&
                !samePullRequest(thread.linkedPullRequest, detectedReference)
              ) {
                const linked = yield* pullRequests.summary(thread.linkedPullRequest, {
                  recoverTransientFailure: false,
                });
                if (linked.state === "merged" || linked.state === "closed") {
                  replacement = detectedReference;
                }
              }
              if (
                samePullRequest(thread.branchPullRequest, branchPullRequest) &&
                replacement === undefined
              ) {
                pendingBackfill.delete(thread.id);
                return null;
              }
              return { thread, branchPullRequest, replacement };
            }).pipe(
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  Effect.logWarning("thread pull request discovery failed", {
                    threadId: thread.id,
                    cause: Cause.pretty(cause),
                  }).pipe(
                    Effect.tap(() => Effect.sync(() => failBackfill([thread]))),
                    Effect.as(null),
                  ),
              ),
            ),
          );
          const updates = plans.filter((plan) => plan !== null);
          if (updates.length === 0) return;

          if (detected !== null && first.branch !== null) {
            const current = yield* git.branchPullRequest(
              { cwd, branch: first.branch },
              { freshGitState: true },
            );
            const currentIdentity = yield* repositoryIdentities.resolve(project.workspaceRoot, {
              refresh: true,
            });
            if (
              current === null ||
              current.number !== detected.number ||
              current.url !== detected.url ||
              current.state !== detected.state ||
              current.repositoryKey !== detected.repositoryKey ||
              !pullRequestMatchesProject(current, {
                ...project,
                repositoryIdentity: currentIdentity,
              })
            ) {
              return failBackfill(updates.map((update) => update.thread));
            }
          }

          yield* Effect.forEach(
            updates,
            ({ thread, branchPullRequest, replacement }) =>
              Effect.gen(function* () {
                // Discovery yields to network I/O; recheck the project at commit to reject deleted projects or changed checkouts.
                const currentProject = yield* projectStore.getShell(project.id);
                if (!projectWorkspaceMatchesSnapshot(currentProject, project.workspaceRoot)) {
                  return failBackfill([thread]);
                }
                const uuid = yield* random.uuidV4();
                yield* orchestrator.dispatch({
                  type: "thread.pull-request.sync",
                  commandId: CommandId.make(`server:thread-pull-request:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  projectId: project.id,
                  snapshotSequence: threadSnapshot.snapshotSequence,
                  expected: {
                    workspaceRoot: project.workspaceRoot,
                    branch: thread.branch,
                    worktreePath: thread.worktreePath,
                    linkedPullRequest: thread.linkedPullRequest ?? null,
                    branchPullRequest: thread.branchPullRequest ?? null,
                  },
                  branchPullRequest,
                  ...(replacement === undefined ? {} : { linkedPullRequest: replacement }),
                });
                pendingBackfill.delete(thread.id);
              }).pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning("thread pull request update failed", {
                      threadId: thread.id,
                      cause: Cause.pretty(cause),
                    }).pipe(Effect.tap(() => Effect.sync(() => failBackfill([thread])))),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("thread branch pull request lookup failed", {
                threadIds: group.map((thread) => thread.id),
                cause: Cause.pretty(cause),
              }).pipe(Effect.tap(() => Effect.sync(() => failBackfill(group)))),
          ),
        ),
      // Batch concurrent branch lookups into one GitHub GraphQL document.
      { concurrency: 32, discard: true },
    );
  });

  // At most one queued request per thread, so a turn end's events share one lookup.
  // A request after that lookup starts queues another, so later host changes are still read.
  const queuedThreadRequests = new Map<ThreadId, { threadId: ThreadId; refresh: boolean }>();

  const worker = yield* makeDrainableWorker((request: RefreshRequest) =>
    Effect.suspend(() => {
      if (request.threadId !== null) queuedThreadRequests.delete(request.threadId);
      return synchronize(request);
    }).pipe(
      Effect.provideService(GitVcsDriver.BackgroundGitWork, true),
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("thread pull request refresh failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const enqueueThread = (threadId: ThreadId, refresh: boolean) =>
    Effect.suspend(() => {
      const queued = queuedThreadRequests.get(threadId);
      if (queued !== undefined) {
        queued.refresh ||= refresh;
        return Effect.void;
      }
      const request = { threadId, refresh };
      queuedThreadRequests.set(threadId, request);
      return worker.enqueue(request);
    });

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.created":
      case "thread.unarchived":
      case "thread.metadata-updated":
        return enqueueThread(event.threadId, false);
      case "thread.unsettled":
      case "checkpoint.captured":
        return enqueueThread(event.threadId, true);
      case "run.updated":
        if (
          event.payload.status === "completed" ||
          event.payload.status === "failed" ||
          event.payload.status === "cancelled" ||
          event.payload.status === "interrupted"
        ) {
          return enqueueThread(event.threadId, true);
        }
        break;
    }
    return Effect.void;
  };

  const start: ThreadPullRequestServiceV2["Service"]["start"] = Effect.fn(
    "ThreadPullRequestServiceV2.start",
  )(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, processEvent));
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue({ threadId: null, refresh: false, backfill: true });
        yield* worker.drain;
        yield* Effect.gen(function* () {
          // The sweep only catches pull requests opened outside a turn, which
          // nobody sees without a client. Thread events still refresh headless work.
          if (!(yield* backgroundPolicy.shouldRunOpportunisticWork)) return;
          yield* worker.enqueue({ threadId: null, refresh: false });
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.delay("1 minute"));
      }).pipe(Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadPullRequestServiceV2["Service"];
});
