import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type ThreadId,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class ThreadPullRequestReactor extends Context.Service<
  ThreadPullRequestReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadPullRequestReactor") {}

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

/** Startup lookups per settled thread before discovery gives up on it. */
export const BACKFILL_ATTEMPTS = 5;

interface RefreshRequest {
  readonly threadId: ThreadId | null;
  readonly refresh: boolean;
  readonly backfill?: boolean;
}

function canonicalRepositoryKey(key: string): string {
  return key
    .replace(
      /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    )
    .replace(
      /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u,
      "dev.azure.com/$1/$2/_git/$3",
    );
}

export function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: OrchestrationProjectShell,
): boolean {
  return (
    pullRequest.repositoryKey !== null &&
    project.repositoryIdentity != null &&
    canonicalRepositoryKey(pullRequest.repositoryKey) ===
      canonicalRepositoryKey(project.repositoryIdentity.canonicalKey)
  );
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  // Settled threads get one link discovery at startup. Failed lookups retry on
  // the periodic pass a few times, then stop until the thread changes or the
  // server restarts, so a missing or logged-out CLI cannot loop forever.
  const pendingBackfill = new Map<ThreadId, number>();
  const finishBackfill = (threads: ReadonlyArray<{ readonly id: ThreadId }>) => {
    for (const thread of threads) pendingBackfill.delete(thread.id);
  };
  const failBackfill = (threads: ReadonlyArray<{ readonly id: ThreadId }>) => {
    for (const thread of threads) {
      const remaining = pendingBackfill.get(thread.id);
      if (remaining === undefined) continue;
      if (remaining <= 1) pendingBackfill.delete(thread.id);
      else pendingBackfill.set(thread.id, remaining - 1);
    }
  };

  const synchronize = Effect.fn("ThreadPullRequestReactor.synchronize")(function* (
    request: RefreshRequest,
  ) {
    const snapshot = yield* snapshots.getShellSnapshot();
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    if (request.backfill) {
      for (const thread of snapshot.threads) {
        if (thread.settledOverride === "settled" && thread.branchPullRequest == null) {
          pendingBackfill.set(thread.id, BACKFILL_ATTEMPTS);
        }
      }
    }
    const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
    for (const threadId of pendingBackfill.keys()) {
      if (!threadIds.has(threadId)) pendingBackfill.delete(threadId);
    }
    const threads = snapshot.threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        (request.threadId === null || thread.id === request.threadId) &&
        (thread.settledOverride !== "settled" ||
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
          const repository = PullRequestService.repositoryIdentityOf(project);
          if (first.branch !== null && repository === null) return finishBackfill(group);
          const worktreeExists =
            first.worktreePath !== null && (yield* fileSystem.exists(first.worktreePath));
          const cwd =
            worktreeExists && first.worktreePath !== null
              ? first.worktreePath
              : project.workspaceRoot;
          const detected =
            first.branch === null
              ? null
              : yield* git.branchPullRequest(
                  { cwd, branch: first.branch },
                  { refresh: request.refresh },
                );
          // A worktree can have different remotes, and the project identity
          // can lag a remote edit. Do not attach its PR to the wrong repository.
          if (detected !== null && !pullRequestMatchesProject(detected, project)) {
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

          const plans = yield* Effect.forEach(group, (thread) =>
            Effect.gen(function* () {
              let branchPullRequest = detectedReference;
              // Shared checkouts often return to the default branch after
              // a merge. Keep that thread's terminal PR across the change.
              if (
                branchPullRequest === null &&
                thread.branch !== null &&
                thread.worktreePath === null &&
                thread.branchPullRequest != null
              ) {
                const previous = yield* pullRequests.summary(thread.branchPullRequest, {
                  recoverTransientFailure: false,
                });
                if (previous.state === "merged" || previous.state === "closed") {
                  branchPullRequest = thread.branchPullRequest;
                }
              }

              let replacement: ThreadLinkedPullRequest | undefined;
              if (
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
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("thread pull request discovery failed", {
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
            // Summary reads can outlast a remote edit. Recheck the branch and
            // the project's primary remote before saving the group's links.
            const current = yield* git.branchPullRequest({ cwd, branch: first.branch });
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
                const uuid = yield* crypto.randomUUIDv4;
                yield* engine.dispatch({
                  type: "thread.pull-request.sync",
                  commandId: CommandId.make(`server:thread-pull-request:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  projectId: project.id,
                  snapshotSequence: snapshot.snapshotSequence,
                  expected: {
                    workspaceRoot: project.workspaceRoot,
                    branch: thread.branch,
                    worktreePath: thread.worktreePath,
                    linkedPullRequest: thread.linkedPullRequest ?? null,
                    branchPullRequest: thread.branchPullRequest ?? null,
                  },
                  branchPullRequest,
                  ...(replacement !== undefined ? { linkedPullRequest: replacement } : {}),
                });
                pendingBackfill.delete(thread.id);
              }).pipe(
                // The thread changed since the lookup. Its own events requeue it.
                Effect.catchTags({
                  OrchestrationCommandInvariantError: () =>
                    Effect.sync(() => finishBackfill([thread])),
                }),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("thread pull request update failed", {
                        threadId: thread.id,
                        cause: Cause.pretty(cause),
                      }).pipe(Effect.tap(() => Effect.sync(() => failBackfill([thread])))),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("thread branch pull request lookup failed", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }).pipe(Effect.tap(() => Effect.sync(() => failBackfill(group)))),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((request: RefreshRequest) =>
    synchronize(request).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("thread pull request refresh failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.created":
      case "thread.unarchived":
        return worker.enqueue({ threadId: event.payload.threadId, refresh: false });
      case "thread.meta-updated":
        if (
          event.payload.branchPullRequest === undefined &&
          (event.payload.branch !== undefined ||
            event.payload.worktreePath !== undefined ||
            event.payload.linkedPullRequest !== undefined)
        ) {
          return worker.enqueue({ threadId: event.payload.threadId, refresh: false });
        }
        break;
      case "thread.session-set":
        if (
          event.payload.session.status !== "running" &&
          event.payload.session.status !== "starting"
        ) {
          return worker.enqueue({ threadId: event.payload.threadId, refresh: true });
        }
        break;
      case "thread.turn-diff-completed":
      case "thread.unsettled":
        return worker.enqueue({ threadId: event.payload.threadId, refresh: true });
      case "project.meta-updated":
        if (event.payload.workspaceRoot !== undefined) {
          return worker.enqueue({ threadId: null, refresh: false });
        }
        break;
    }
    return Effect.void;
  };

  const start = Effect.fn("ThreadPullRequestReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
    // Run without client demand. Saved branch lookups share GitManager's
    // provider cache and retry backoff with status and automatic settlement.
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue({ threadId: null, refresh: false, backfill: true });
        yield* worker.drain;
        yield* Effect.gen(function* () {
          yield* worker.enqueue({ threadId: null, refresh: false });
          yield* worker.drain;
        }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.delay("1 minute"));
      }).pipe(Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies ThreadPullRequestReactor["Service"];
});

export const layer = Layer.effect(ThreadPullRequestReactor, make);
