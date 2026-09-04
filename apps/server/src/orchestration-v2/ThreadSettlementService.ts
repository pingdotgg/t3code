import { CommandId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function toMillis(value: DateTime.Utc | null | undefined): number | null {
  return value == null ? null : DateTime.toEpochMillis(value);
}

function latestMillis(values: ReadonlyArray<number | null>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (latest === null || value > latest) latest = value;
  }
  return latest;
}

/**
 * A recent user message stays queued until a run adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. A failed run start
 * clears the block immediately (mirrors the v1 session "error" rule).
 */
export function threadHasQueuedTurnStart(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "latestUserMessageAt"
    | "latestRunRequestedAt"
    | "latestRunStartedAt"
    | "latestRunCompletedAt"
    | "latestRunId"
    | "status"
  >,
  nowMs: number,
): boolean {
  const messageAtMs = toMillis(thread.latestUserMessageAt);
  if (messageAtMs === null || thread.status === "failed") return false;
  const age = nowMs - messageAtMs;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestRunId === null) return true;
  return [
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ].every((value) => value === null || value < messageAtMs);
}

function pullRequestSettles(
  thread: Pick<
    OrchestrationV2ThreadShell,
    "createdAt" | "latestUserMessageAt" | "latestRunRequestedAt"
  >,
  pullRequest: SettlementPullRequest,
  autoSettleOnMerge: boolean,
): boolean {
  if (pullRequest.state !== "closed" && (pullRequest.state !== "merged" || !autoSettleOnMerge)) {
    return false;
  }
  if (pullRequest.updatedAt === null) return false;
  const userAnchorMs = latestMillis([
    toMillis(thread.createdAt),
    toMillis(thread.latestUserMessageAt),
    toMillis(thread.latestRunRequestedAt),
  ]);
  if (userAnchorMs === null) return false;
  const pullRequestAtMs = Date.parse(pullRequest.updatedAt);
  if (Number.isNaN(pullRequestAtMs)) return false;
  return pullRequestAtMs >= userAnchorMs;
}

/** Cheap checks that run before any source control lookup. */
export function isAutoSettlementCandidate(
  thread: OrchestrationV2ThreadShell,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.pinnedAt != null) return false;
  // Blocked-on-you work must never park behind a settled override.
  if (thread.pendingRuntimeRequest !== null) return false;
  // A live run — or post-settlement background work — is not staleness.
  if (thread.activityRunStatus != null) return false;
  if ((thread.pendingBackgroundTasks?.length ?? 0) > 0) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return true;
  // A snoozed thread that woke early (error or completed work) can settle;
  // one still parked on its wake time keeps its stronger statement.
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError = thread.status === "failed";
  const wokeOnCompletion =
    snoozedAtMs !== null && completedAtMs !== null && completedAtMs > snoozedAtMs;
  return wokeOnError || wokeOnCompletion;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: OrchestrationV2ThreadShell;
  readonly pullRequest: SettlementPullRequest | null;
  readonly nowMs: number;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
}): DateTime.Utc | null {
  const { thread, pullRequest } = input;
  if (!isAutoSettlementCandidate(thread, input.nowMs)) return null;
  const activityAtMs = latestMillis([
    toMillis(thread.latestUserMessageAt),
    toMillis(thread.latestRunRequestedAt),
    toMillis(thread.latestRunStartedAt),
    toMillis(thread.latestRunCompletedAt),
  ]);
  if (pullRequest !== null && pullRequestSettles(thread, pullRequest, input.autoSettleOnMerge)) {
    return activityAtMs === null ? thread.createdAt : DateTime.makeUnsafe(activityAtMs);
  }
  if (input.autoSettleAfterDays === null || activityAtMs === null) return null;
  return activityAtMs < input.nowMs - input.autoSettleAfterDays * DAY_MS
    ? DateTime.makeUnsafe(activityAtMs)
    : null;
}

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

export const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;

  const sweep = Effect.fn("ThreadSettlementServiceV2.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
  ) {
    const snapshot = yield* orchestrator.getShellSnapshot();
    const projectShells = yield* snapshots.getProjectShellsWithoutEnrichment();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const projects = new Map(projectShells.map((project) => [project.id, project]));
    // A merge event re-sweeps every candidate, not just the threads linked to
    // the merged pull request: most threads carry no link and settle from
    // their branch lookup, which would otherwise wait for the next minute's
    // sweep on a possibly stale cached answer.
    const candidates = snapshot.threads.filter((thread) =>
      isAutoSettlementCandidate(thread, nowMs),
    );
    // Use the same cwd as the sidebar so both paths share GitManager's PR cache.
    const lookupCwdByThreadId = new Map<string, string>();
    yield* Effect.forEach(
      candidates,
      (thread) =>
        Effect.gen(function* () {
          const project = projects.get(thread.projectId);
          if (project === undefined || thread.linkedPullRequest != null) return;
          const worktreeExists =
            thread.worktreePath !== null &&
            (yield* fileSystem.exists(thread.worktreePath).pipe(Effect.orElseSucceed(() => false)));
          lookupCwdByThreadId.set(
            thread.id,
            worktreeExists && thread.worktreePath !== null
              ? thread.worktreePath
              : project.workspaceRoot,
          );
        }),
      { concurrency: 8, discard: true },
    );
    if (mergedPullRequest !== null) {
      // The merge just confirmed a terminal state the lookup caches can still
      // call open (branch answers live two minutes, the sweep runs every
      // minute). Drop the swept checkouts' cached answers so the merge settles
      // its branch threads now instead of on a later sweep. Threads linked to
      // the merged pull request settle from the event itself below and need no
      // lookup, so they are absent from this map by construction.
      const cwds = [...new Set(lookupCwdByThreadId.values())];
      yield* Effect.forEach(cwds, (cwd) => git.invalidateStatus(cwd), {
        concurrency: 8,
        discard: true,
      });
    }
    const lookupKey = (thread: (typeof candidates)[number]) => {
      if (thread.linkedPullRequest != null) {
        return JSON.stringify([
          "linked",
          thread.linkedPullRequest.projectId,
          thread.linkedPullRequest.repository,
          thread.linkedPullRequest.number,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const cwd = lookupCwdByThreadId.get(thread.id);
      return JSON.stringify(
        cwd === undefined ? ["missing-project", thread.id] : ["branch", cwd, thread.branch],
      );
    };
    const groups = Map.groupBy(candidates, lookupKey);

    const pullRequestFor = Effect.fn("ThreadSettlementServiceV2.pullRequestFor")(function* (
      thread: (typeof candidates)[number],
    ) {
      if (thread.linkedPullRequest != null) {
        // The event carries the merged state, so only the threads linked to
        // that exact pull request settle from it. Every other linked thread
        // falls through to a fresh summary lookup below: the merge sweep
        // covers all candidates, and an unrelated merge must never settle
        // them.
        if (
          mergedPullRequest !== null &&
          thread.linkedPullRequest.projectId === mergedPullRequest.projectId &&
          thread.linkedPullRequest.repository.toLowerCase() ===
            mergedPullRequest.repository.toLowerCase() &&
          thread.linkedPullRequest.number === mergedPullRequest.number
        ) {
          return {
            state: "merged",
            updatedAt: mergedPullRequest.mergedAt,
          } satisfies SettlementPullRequest;
        }
        if (!projects.has(thread.linkedPullRequest.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const summary = yield* pullRequests.summary(
          {
            projectId: thread.linkedPullRequest.projectId,
            repository: thread.linkedPullRequest.repository,
            number: thread.linkedPullRequest.number,
          },
          { recoverTransientFailure: false },
        );
        return {
          state: summary.state,
          updatedAt: summary.updatedAt,
        } satisfies SettlementPullRequest;
      }
      if (thread.branch === null) return null;
      const cwd = lookupCwdByThreadId.get(thread.id);
      if (cwd === undefined) {
        return yield* Effect.die(new Error("thread project not found"));
      }
      return yield* git.branchPullRequest({ cwd, branch: thread.branch });
    });

    yield* Effect.forEach(
      groups.values(),
      (group) =>
        Effect.gen(function* () {
          const pullRequest = yield* pullRequestFor(group[0]!);
          yield* Effect.forEach(
            group,
            (thread) =>
              Effect.gen(function* () {
                const settings = yield* settingsService.getSettings;
                const decisionNow = yield* DateTime.now;
                const settledAt = resolveAutoSettlementAt({
                  thread,
                  pullRequest,
                  nowMs: DateTime.toEpochMillis(decisionNow),
                  autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
                  autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
                });
                if (settledAt === null) {
                  return;
                }
                const uuid = yield* crypto.randomUUIDv4;
                yield* orchestrator.dispatch({
                  type: "thread.auto-settle",
                  commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
                  threadId: thread.id,
                  // An in-flight user action wins over a stale sweep.
                  snapshotAt: thread.updatedAt,
                  settledAt,
                });
              }).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("automatic thread settlement skipped", {
                        threadId: thread.id,
                        cause: Cause.pretty(cause),
                      }),
                ),
              ),
            { discard: true },
          );
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadIds: group.map((thread) => thread.id),
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
  });

  const runSweep = (mergedPullRequest: PullRequestService.PullRequestMergeEvent | null) =>
    sweep(mergedPullRequest).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(() => runSweep(null));

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastAfterDays = initialSettings.sidebarAutoSettleAfterDays;
    let lastOnMerge = initialSettings.sidebarAutoSettleOnMerge;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        if (
          settings.sidebarAutoSettleAfterDays === lastAfterDays &&
          settings.sidebarAutoSettleOnMerge === lastOnMerge
        ) {
          return Effect.void;
        }
        lastAfterDays = settings.sidebarAutoSettleAfterDays;
        lastOnMerge = settings.sidebarAutoSettleOnMerge;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, runSweep));
  });

  return { start, drain: worker.drain } satisfies ThreadSettlementServiceV2["Service"];
});

export const layer = Layer.effect(ThreadSettlementServiceV2, make);
