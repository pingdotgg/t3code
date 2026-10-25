import {
  backgroundWorkHoldsCompletion,
  turnItemUpdateCanEndBackgroundWork,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import {
  CommandId,
  isOrchestrationV2WorkActive,
  type ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as GitManager from "../git/GitManager.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

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

function pullRequestMatchesProject(
  pullRequest: GitManager.GitBranchPullRequest,
  project: {
    readonly repositoryIdentity?: { readonly canonicalKey: string } | null | undefined;
  },
): boolean {
  return (
    pullRequest.repositoryKey !== null &&
    project.repositoryIdentity != null &&
    sourceControlDefinitions.canonicalRepositoryKey(pullRequest.repositoryKey) ===
      sourceControlDefinitions.canonicalRepositoryKey(project.repositoryIdentity.canonicalKey)
  );
}

type SettlementPullRequestLink = NonNullable<
  ProjectionStore.ProjectionSettlementCandidate["pullRequests"]
>[number];

/** When the linked pull request merged or closed, or -Infinity if it has not. */
function linkTerminalAtMs(link: SettlementPullRequestLink): number {
  const snapshot = link.snapshot;
  const value = snapshot?.state === "merged" ? snapshot.mergedAt : snapshot?.closedAt;
  const timestamp = Date.parse(value ?? "");
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

/** Exclude links added after merge or close; they record completed work rather than outcomes this thread awaits. */
function settlementPullRequestLinks(
  links: ReadonlyArray<SettlementPullRequestLink>,
): ReadonlyArray<SettlementPullRequestLink> {
  return visibleThreadPullRequests(links).filter((link) => {
    if (link.snapshot === null || link.snapshot.state === "open") return true;
    const linkedAtMs = Date.parse(link.linkedAt);
    return Number.isNaN(linkedAtMs) || linkTerminalAtMs(link) >= linkedAtMs;
  });
}

/** Absolute age bounds clock skew in both directions and expires stale pre-adoption data. */
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
    ProjectionStore.ProjectionSettlementCandidate,
    "createdAt" | "latestUserAuthoredMessageAt"
  >,
  pullRequest: SettlementPullRequest,
  autoSettleOnMerge: boolean,
): boolean {
  if (pullRequest.state !== "closed" && (pullRequest.state !== "merged" || !autoSettleOnMerge)) {
    return false;
  }
  const terminalAt = pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt;
  if (terminalAt == null) return false;
  const userAnchorMs = latestMillis([
    toMillis(thread.createdAt),
    toMillis(thread.latestUserAuthoredMessageAt),
  ]);
  if (userAnchorMs === null) return false;
  const pullRequestAtMs = Date.parse(terminalAt);
  if (Number.isNaN(pullRequestAtMs)) return false;
  return pullRequestAtMs >= userAnchorMs;
}

export function isAutoSettlementCandidate(
  thread: Omit<ProjectionStore.ProjectionSettlementCandidate, "latestUserAuthoredMessageAt">,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.pinnedAt != null || thread.autoSettleDisabledAt != null) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  // A guest is waiting on the owner; settling would hide the Request.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  if (thread.activityRunStatus != null) return false;
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return false;
  if (threadHasQueuedTurnStart(thread, nowMs)) return false;
  // Interrupted runs must keep the same snooze protection the sidebar shows.
  return !isSnoozed(thread, nowMs);
}

/** Match client effectiveSnoozed so agents and sidebar agree. */
export function isSnoozed(
  thread: Pick<
    ProjectionStore.ProjectionSettlementCandidate,
    | "snoozedUntil"
    | "snoozedAt"
    | "latestRunCompletedAt"
    | "status"
    | "pendingRuntimeRequest"
    | "pendingGuestMessageCount"
  >,
  nowMs: number,
): boolean {
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  if (snoozedUntilMs === null || snoozedUntilMs <= nowMs) return false;
  if (thread.pendingRuntimeRequest !== null) return false;
  // Same as the client: a waiting guest message wakes the thread, and the snooze stays stored.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  const snoozedAtMs = toMillis(thread.snoozedAt);
  const completedAtMs = toMillis(thread.latestRunCompletedAt);
  const wokeOnError =
    thread.status === "failed" &&
    (snoozedAtMs === null || (completedAtMs !== null && completedAtMs > snoozedAtMs));
  return !wokeOnError;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: ProjectionStore.ProjectionSettlementCandidate;
  readonly pullRequest: SettlementPullRequest | null;
  readonly nowMs: number;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
  readonly autoSettleKeepPullRequests?: boolean;
}): DateTime.Utc | null {
  const { thread } = input;
  let pullRequest = input.pullRequest;
  const links = settlementPullRequestLinks(thread.pullRequests ?? []);
  if (links.some((link) => link.snapshot === null)) return null;
  // An open link means the pull request has not finished, so only inactivity
  // can settle the thread, never a merged or closed lookup.
  const hasOpenLink = links.some((link) => link.snapshot?.state === "open");
  if (hasOpenLink) {
    pullRequest = null;
  } else if (links.length > 0) {
    const latest = links.reduce((current, candidate) =>
      linkTerminalAtMs(candidate) > linkTerminalAtMs(current) ? candidate : current,
    );
    pullRequest =
      latest.snapshot === null
        ? null
        : {
            state: latest.snapshot.state,
            mergedAt: latest.snapshot.mergedAt ?? null,
            closedAt: latest.snapshot.closedAt ?? null,
          };
  }
  if (!isAutoSettlementCandidate(thread, input.nowMs)) return null;
  const activityAtMs =
    latestMillis([
      toMillis(thread.latestUserMessageAt),
      toMillis(thread.latestRunRequestedAt),
      toMillis(thread.latestRunStartedAt),
      toMillis(thread.latestRunCompletedAt),
    ]) ?? DateTime.toEpochMillis(thread.createdAt);
  if (pullRequest !== null && pullRequestSettles(thread, pullRequest, input.autoSettleOnMerge)) {
    return DateTime.makeUnsafe(activityAtMs);
  }
  const hasPullRequest =
    hasOpenLink ||
    pullRequest !== null ||
    thread.linkedPullRequest != null ||
    thread.branchPullRequest != null;
  if (input.autoSettleKeepPullRequests === true && hasPullRequest) return null;
  if (input.autoSettleAfterDays === null) return null;
  const snoozedUntilMs = toMillis(thread.snoozedUntil);
  const timerWakeAtMs =
    snoozedUntilMs !== null && snoozedUntilMs <= input.nowMs ? snoozedUntilMs : null;
  const inactivityAtMs =
    latestMillis([activityAtMs, toMillis(thread.lastSnoozeWakeAt), timerWakeAtMs]) ?? activityAtMs;
  return inactivityAtMs < input.nowMs - input.autoSettleAfterDays * DAY_MS
    ? DateTime.makeUnsafe(inactivityAtMs)
    : null;
}

export class ThreadSettlementServiceV2 extends Context.Service<
  ThreadSettlementServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadSettlementService/ThreadSettlementServiceV2") {}

function autoSettlementConfigured(settings: import("@t3tools/contracts").ServerSettings): boolean {
  if (settings.sidebarAutoSettleOnMerge || settings.sidebarAutoSettleAfterDays !== null) {
    return true;
  }
  return Object.values(settings.projectSettingsOverrides).some(
    (entry) =>
      entry.sidebarAutoSettleOnMerge === true ||
      (entry.sidebarAutoSettleAfterDays !== undefined && entry.sidebarAutoSettleAfterDays !== null),
  );
}

/** @internal Exported for tests. */
export function autoSettlementSettingsKey(
  settings: import("@t3tools/contracts").ServerSettings,
): string {
  return JSON.stringify([
    settings.sidebarAutoSettleOnMerge,
    settings.sidebarAutoSettleAfterDays,
    settings.sidebarAutoSettleKeepPullRequests,
    Object.entries(settings.projectSettingsOverrides)
      .filter(
        ([, entry]) =>
          entry.sidebarAutoSettleOnMerge !== undefined ||
          entry.sidebarAutoSettleAfterDays !== undefined ||
          entry.sidebarAutoSettleKeepPullRequests !== undefined,
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([projectId, entry]) => [
        projectId,
        entry.sidebarAutoSettleOnMerge ?? "inherit",
        entry.sidebarAutoSettleAfterDays === undefined
          ? "inherit"
          : entry.sidebarAutoSettleAfterDays,
        entry.sidebarAutoSettleKeepPullRequests ?? "inherit",
      ]),
  ]);
}

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitManager.GitManager;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const terminals = yield* TerminalManager.TerminalManager;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  // Repeated thread.settled retains settledAt; run the action only once per settlement.
  const settleActionRunAt = new Map<ThreadId, number>();

  const sweep = Effect.fn("ThreadSettlementServiceV2.sweep")(function* (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) {
    const settings = yield* settingsService.getSettings;
    if (!autoSettlementConfigured(settings)) {
      return;
    }
    const threads = yield* projections.getSettlementCandidates(threadId);
    if (threads.length === 0) return;
    const projectShells = yield* projectStore.listShells();
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const projects = new Map(projectShells.map((project) => [project.id, project]));
    // Merge events resweep all candidates because unlinked threads settle through branch lookup.
    const candidates = threads.filter((thread) => isAutoSettlementCandidate(thread, nowMs));

    const settleThread = Effect.fn("ThreadSettlementServiceV2.settleThread")(
      function* (thread: (typeof candidates)[number], pullRequest: SettlementPullRequest | null) {
        const currentSettings = resolveProjectSettings(
          yield* settingsService.getSettings,
          thread.projectId,
        ).settings;
        const decisionNow = yield* DateTime.now;
        const settledAt = resolveAutoSettlementAt({
          thread,
          pullRequest,
          nowMs: DateTime.toEpochMillis(decisionNow),
          autoSettleAfterDays: currentSettings.sidebarAutoSettleAfterDays,
          autoSettleOnMerge: currentSettings.sidebarAutoSettleOnMerge,
          autoSettleKeepPullRequests: currentSettings.sidebarAutoSettleKeepPullRequests,
        });
        if (settledAt === null) return thread;
        const uuid = yield* crypto.randomUUIDv4();
        yield* orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make(`server:auto-settle:${thread.id}:${uuid}`),
          threadId: thread.id,
          snapshotAt: thread.updatedAt,
          settledAt,
        });
        return null;
      },
      (effect, thread) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("automatic thread settlement skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }).pipe(Effect.as(null)),
          ),
        ),
    );

    const lookupCandidates = (yield* Effect.forEach(
      candidates,
      (thread) => settleThread(thread, null),
      { concurrency: 8 },
    ))
      .filter((thread) => thread !== null)
      .filter((thread) => visibleThreadPullRequests(thread.pullRequests ?? []).length === 0);
    const lookupCwdByThreadId = new Map<string, string>();
    yield* Effect.forEach(
      lookupCandidates,
      (thread) =>
        Effect.gen(function* () {
          const project = projects.get(thread.projectId);
          if (project === undefined || thread.branch === null) return;
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
      // Invalidate checkout caches on merge; cached open branches would delay settlement beyond this sweep.
      const cwds = [...new Set(lookupCwdByThreadId.values())];
      yield* Effect.forEach(cwds, (cwd) => git.invalidateStatus(cwd), {
        concurrency: 8,
        discard: true,
      });
    }
    const lookupKey = (thread: (typeof lookupCandidates)[number]) => {
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        return JSON.stringify([
          "linked",
          reference.projectId,
          reference.repository,
          reference.number,
          lookupCwdByThreadId.get(thread.id),
          thread.branch,
        ]);
      }
      if (thread.branch === null) return JSON.stringify(["none", thread.id]);
      const cwd = lookupCwdByThreadId.get(thread.id);
      return JSON.stringify(
        cwd === undefined ? ["missing-project", thread.id] : ["branch", cwd, thread.branch],
      );
    };
    const groups = Map.groupBy(lookupCandidates, lookupKey);

    const wouldSettle = Effect.fn("ThreadSettlementServiceV2.wouldSettle")(function* (
      group: ReadonlyArray<(typeof lookupCandidates)[number]>,
      pullRequest: SettlementPullRequest,
    ) {
      const currentSettings = yield* settingsService.getSettings;
      const decisionNow = yield* DateTime.now;
      return group.some((thread) => {
        const { settings } = resolveProjectSettings(currentSettings, thread.projectId);
        return (
          resolveAutoSettlementAt({
            thread,
            pullRequest,
            nowMs: DateTime.toEpochMillis(decisionNow),
            autoSettleAfterDays: settings.sidebarAutoSettleAfterDays,
            autoSettleOnMerge: settings.sidebarAutoSettleOnMerge,
            autoSettleKeepPullRequests: settings.sidebarAutoSettleKeepPullRequests,
          }) !== null
        );
      });
    });

    const pullRequestFor = Effect.fn("ThreadSettlementServiceV2.pullRequestFor")(function* (
      group: ReadonlyArray<(typeof lookupCandidates)[number]>,
    ) {
      const thread = group[0]!;
      const reference = thread.linkedPullRequest ?? thread.branchPullRequest;
      if (reference != null) {
        // Only matching PR links settle from this merge event; unrelated links require fresh lookup.
        const matchesMerge =
          mergedPullRequest !== null &&
          reference.projectId === mergedPullRequest.projectId &&
          reference.repository.toLowerCase() === mergedPullRequest.repository.toLowerCase() &&
          reference.number === mergedPullRequest.number;
        if (!matchesMerge && !projects.has(reference.projectId)) {
          return yield* Effect.die(new Error("linked pull request project not found"));
        }
        const summary = matchesMerge
          ? ({
              state: "merged",
              closedAt: null,
              mergedAt: mergedPullRequest.mergedAt,
            } satisfies SettlementPullRequest)
          : yield* pullRequests.summary(
              {
                projectId: reference.projectId,
                repository: reference.repository,
                number: reference.number,
              },
              { recoverTransientFailure: false },
            );
        const terminal = {
          state: summary.state,
          closedAt: summary.closedAt ?? null,
          mergedAt: summary.mergedAt ?? null,
        } satisfies SettlementPullRequest;
        const cwd = lookupCwdByThreadId.get(thread.id);
        if (summary.state !== "open" && thread.branch !== null && cwd !== undefined) {
          if (!(yield* wouldSettle(group, terminal))) return undefined;
          const current = yield* git.branchPullRequest(
            { cwd, branch: thread.branch },
            { refresh: true },
          );
          const project = projects.get(thread.projectId);
          if (
            current?.state === "open" &&
            project !== undefined &&
            pullRequestMatchesProject(current, project)
          ) {
            return current;
          }
        }
        return terminal;
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
          const pullRequest = yield* pullRequestFor(group);
          if (pullRequest === undefined) return;
          yield* Effect.forEach(group, (thread) => settleThread(thread, pullRequest), {
            discard: true,
          });
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

  const runSweep = (
    mergedPullRequest: PullRequestService.PullRequestMergeEvent | null,
    threadId?: ThreadId,
  ) =>
    sweep(mergedPullRequest, threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("automatic thread settlement sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  // A thread that just stopped must not wait behind a full sweep or another thread's host
  // reads: clients hold it in Working only briefly, so a late settle makes it appear and then vanish.
  const fullSweeps = yield* makeDrainableWorker(() => runSweep(null));
  const threadSweeps = yield* FiberSet.make<void>();
  const threadSweepSlots = yield* Semaphore.make(8);
  // One sweep per thread at a time; events during a running sweep coalesce into one more pass.
  const threadSweepStates = new Map<ThreadId, "queued" | "running" | "rerun">();
  const sweepThread = (
    threadId: ThreadId,
  ): Effect.Effect<void, Effect.Error<ReturnType<typeof runSweep>>> =>
    Effect.sync(() => threadSweepStates.set(threadId, "running")).pipe(
      Effect.andThen(runSweep(null, threadId)),
      threadSweepSlots.withPermits(1),
      Effect.andThen(
        Effect.suspend(() => {
          if (threadSweepStates.get(threadId) === "rerun") return sweepThread(threadId);
          threadSweepStates.delete(threadId);
          return Effect.void;
        }),
      ),
    );
  const enqueueThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const state = threadSweepStates.get(threadId);
      if (state === "running") threadSweepStates.set(threadId, "rerun");
      if (state !== undefined) return Effect.void;
      threadSweepStates.set(threadId, "queued");
      return sweepThread(threadId).pipe(FiberSet.run(threadSweeps), Effect.asVoid);
    });

  // Skip settle scripts in shared checkouts where other threads may still work.
  const cleanUpSettledThread = Effect.fn("ThreadSettlementServiceV2.cleanUpSettledThread")(
    function* (threadId: ThreadId) {
      const settled = yield* projections.getThread(threadId);
      if (settled.settledOverride !== "settled") return;
      yield* terminals.closeIdle({ threadId });
      const worktreePath = settled.worktreePath;
      if (worktreePath === null || !(yield* fileSystem.exists(worktreePath))) return;
      // Recheck after closing and worktree I/O; re-engaged threads must not be cleaned up.
      const thread = yield* projections.getThread(threadId);
      if (thread.settledOverride !== "settled") return;
      const settledAtMs = toMillis(thread.settledAt);
      if (settledAtMs === null || settleActionRunAt.get(threadId) === settledAtMs) return;
      const run = yield* projectScripts.runForThread({
        threadId,
        projectId: thread.projectId,
        worktreePath,
        trigger: "settle",
        observeCompletion: {},
      });
      settleActionRunAt.set(threadId, settledAtMs);
      if (run.status === "started" && run.completion) {
        yield* run.completion.pipe(Effect.forkDetach);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("cleaning up a settled thread failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.settled":
        return cleanUpSettledThread(event.threadId);
      case "thread.pull-request-link-updated":
      case "thread.pull-request-synced":
      case "provider-session.detached":
      case "run.background-work-cancelled":
        return enqueueThread(event.threadId);
      // Sweep only when the work can have ended: progress updates cannot settle anything.
      case "subagent.updated":
        return isOrchestrationV2WorkActive(event.payload.status)
          ? Effect.void
          : enqueueThread(event.threadId);
      case "provider-thread.updated":
        return backgroundWorkHoldsCompletion(event.payload.pendingBackgroundTasks ?? [])
          ? Effect.void
          : enqueueThread(event.threadId);
      case "turn-item.updated":
        return turnItemUpdateCanEndBackgroundWork(event.payload)
          ? enqueueThread(event.threadId)
          : Effect.void;
      case "provider-session.updated":
        return event.payload.status !== "starting" && event.payload.status !== "running"
          ? enqueueThread(event.threadId)
          : Effect.void;
      case "run.updated":
        return ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
          event.payload.status,
        )
          ? enqueueThread(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const start: ThreadSettlementServiceV2["Service"]["start"] = Effect.fn(
    "ThreadSettlementServiceV2.start",
  )(function* () {
    const settingsChanges = yield* settingsService.subscribeChanges;
    const mergedPullRequests = yield* pullRequests.subscribeMerges;
    const events = orchestrator.streamDomainEvents;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastSettlementSettings = autoSettlementSettingsKey(initialSettings);
    yield* forkParked(
      Effect.gen(function* () {
        yield* fullSweeps.enqueue(undefined);
        yield* fullSweeps.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) => {
        const key = autoSettlementSettingsKey(settings);
        if (key === lastSettlementSettings) {
          return Effect.void;
        }
        lastSettlementSettings = key;
        return fullSweeps.enqueue(undefined);
      }),
    );
    yield* forkParked(Stream.runForEach(mergedPullRequests, (event) => runSweep(event)));
    yield* forkParked(
      Stream.runForEach(events, processEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Thread settlement event stream failed", { cause }),
        ),
      ),
    );
  });

  return {
    start,
    drain: Effect.andThen(fullSweeps.drain, FiberSet.awaitEmpty(threadSweeps)),
  } satisfies ThreadSettlementServiceV2["Service"];
});

export const layer = Layer.effect(ThreadSettlementServiceV2, make);
