import {
  canonicalRepositoryKey,
  sourceControlRepositorySelector,
} from "@t3tools/shared/sourceControl";
import {
  CommandId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
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
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
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

/**
 * Read the shell state for a discovery or settlement sweep. A sweep for one
 * thread reads that thread and the projects it names, not every thread.
 */
export const readSweepSnapshot = (
  snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQueryShape,
  threadId: ThreadId | null,
): Effect.Effect<
  Pick<OrchestrationShellSnapshot, "snapshotSequence" | "projects" | "threads">,
  ProjectionRepositoryError
> =>
  threadId === null
    ? snapshots.getShellSnapshot()
    : Effect.gen(function* () {
        // Read the sequence first. The thread is then at least this new, so a
        // command guarded by the sequence is rejected rather than missing a change.
        const { snapshotSequence } = yield* snapshots.getSnapshotSequence();
        const thread = yield* snapshots.getThreadShellById(threadId);
        if (Option.isNone(thread)) return { snapshotSequence, projects: [], threads: [] };
        // Settlement also checks the project a saved pull request names.
        const reference = thread.value.linkedPullRequest ?? thread.value.branchPullRequest;
        const projects = yield* snapshots.getProjectShells(
          reference == null
            ? [thread.value.projectId]
            : [thread.value.projectId, reference.projectId],
        );
        return { snapshotSequence, projects, threads: [thread.value] };
      });

/** @public Service construction is part of the canonical Effect module API. */
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
    const snapshot = yield* readSweepSnapshot(snapshots, request.threadId);
    const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
    if (request.backfill) {
      for (const thread of snapshot.threads) {
        if (
          (thread.settledOverride === "settled" || thread.settledAt !== null) &&
          thread.branchPullRequest == null
        ) {
          pendingBackfill.set(thread.id, BACKFILL_ATTEMPTS);
        }
      }
    }
    // A single-thread read only shows whether its own thread is gone.
    const threadIds = new Set(snapshot.threads.map((thread) => thread.id));
    const checkedIds = request.threadId === null ? pendingBackfill.keys() : [request.threadId];
    for (const threadId of checkedIds) {
      if (!threadIds.has(threadId)) pendingBackfill.delete(threadId);
    }
    const threads = snapshot.threads.filter(
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
          const snapshotProject = projects.get(first.projectId);
          if (snapshotProject === undefined) return finishBackfill(group);
          // A finished turn may have added the remote this PR lives on. A failed
          // refresh resolves to null, so keep the snapshot's identity then.
          const project = request.refresh
            ? {
                ...snapshotProject,
                repositoryIdentity:
                  (yield* repositoryIdentities.resolve(snapshotProject.workspaceRoot, {
                    refresh: true,
                  })) ?? snapshotProject.repositoryIdentity,
              }
            : snapshotProject;
          const repository = sourceControlRepositorySelector(project.repositoryIdentity);
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
                thread.pullRequests.length === 0 &&
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
      { concurrency: 8, discard: true },
    );
  });

  const worker = yield* makeDrainableWorker((request: RefreshRequest) =>
    synchronize(request).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("thread pull request refresh failed", {
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
          // Checkpoint completion forces the post-turn read. Session lifecycle
          // events reuse it regardless of which event reaches this worker first.
          return worker.enqueue({ threadId: event.payload.threadId, refresh: false });
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
