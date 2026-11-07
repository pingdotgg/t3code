import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestRef,
  type PullRequestReviewDecision,
  type PullRequestThreadCommentsResult,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import {
  type ProviderChangeRequestWatchFingerprint,
  PullRequestProviderError,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  agentMergeBlockedMessage,
  agentMergeLeftQueueMessage,
  agentMergeGate,
  agentMergeMessagePrefix,
  agentMergeReadyMessage,
  agentMergeRefusedMessage,
  evaluatePullRequestWatch,
  PULL_REQUEST_WATCH_NO_CHECKS_MS,
  pullRequestWatchMessage,
} from "./pullRequestWatch.ts";

/** Checks take minutes; faster sweeps waste the account's shared host quota. */
const SWEEP_MINUTES = 2;
const READ_FAILURE_LIMIT = 8;
/** Group reads in flight at once, inside the host's own request limit. */
const GROUP_READS = 4;
/** Without fingerprints, reread quiet PRs on snapshot changes or this interval to catch edits. */
const QUIET_REREAD_MS = 10 * 60_000;
/** Reread despite unchanged fingerprints; they miss review-thread comment edits. */
const FINGERPRINT_REREAD_MS = 30 * 60_000;

const isProviderError = Schema.is(PullRequestProviderError);

const providerFailureReason = (cause: Cause.Cause<PullRequestService.PullRequestError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => null,
    onSome: (error) =>
      error._tag === "PullRequestOperationError" && isProviderError(error.cause)
        ? error.cause.reason
        : null,
  });

const refusalDetail = (cause: Cause.Cause<PullRequestService.PullRequestError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "the merge failed.",
    onSome: (error) => error.message,
  });

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

interface WatchTarget {
  readonly thread: ProjectionStore.ProjectionThreadPullRequests;
  readonly link: ThreadPullRequestLink;
  readonly watch: ThreadPullRequestWatch;
}

interface WatchGroup {
  readonly key: string;
  readonly targets: ReadonlyArray<WatchTarget>;
  readonly fingerprint: string;
}

interface LastRead {
  readonly at: number;
  readonly fingerprint: string;
  readonly inFlight: boolean;
  readonly remarksComplete: boolean;
  readonly watches: ReadonlySet<string>;
  readonly status: string | null;
  readonly remarks: string | null;
}

interface ReadPlan {
  readonly detail: boolean;
  readonly activity: boolean;
}

const watchKey = ({ thread, watch }: WatchTarget) => `${thread.id} ${watch.startedAt}`;

type WatchEndReason =
  | "merged"
  | "closed"
  | "unreadable"
  | "comment-limit"
  | "ready"
  | "settled"
  | "subagent"
  | "stopped";

interface WatchLife {
  readonly threadId: string;
  readonly pullRequest: string;
  readonly startedAt: number;
  readonly headSha: string | null;
  readonly pushedAt: number;
  readonly longestQuietMs: number;
  readonly wakes: number;
  readonly reads: number;
}

const lifeKey = ({ thread, link, watch }: WatchTarget) =>
  `${thread.id} ${threadPullRequestKeyOf(link)} ${watch.startedAt}`;

const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));

const snapshotFingerprint = ({ link }: WatchTarget) => {
  const snapshot = link.snapshot;
  return snapshot === null
    ? ""
    : [
        snapshot.state,
        snapshot.updatedAt,
        snapshot.checksState,
        snapshot.mergeability,
        snapshot.reviewDecision,
        snapshot.isDraft,
      ].join(" ");
};

function planRead(
  group: WatchGroup,
  last: LastRead | undefined,
  fingerprint: ProviderChangeRequestWatchFingerprint | null,
  now: number,
): ReadPlan {
  if (last === undefined || group.targets.some((target) => !last.watches.has(watchKey(target)))) {
    return { detail: true, activity: true };
  }
  // Nothing on the host changes when the no-checks deadline passes, so it alone prompts a read.
  const checksDue = group.targets.some(
    ({ watch }) =>
      watch.checksAwaitedSince != null &&
      now - Date.parse(watch.checksAwaitedSince) >= PULL_REQUEST_WATCH_NO_CHECKS_MS,
  );
  if (fingerprint === null) {
    const read =
      last.inFlight ||
      !last.remarksComplete ||
      last.fingerprint !== group.fingerprint ||
      now - last.at >= QUIET_REREAD_MS;
    return { detail: read || checksDue, activity: read };
  }
  const activity =
    last.remarks !== fingerprint.remarks ||
    !last.remarksComplete ||
    now - last.at >= FINGERPRINT_REREAD_MS;
  return {
    detail: activity || checksDue || last.status !== fingerprint.status || last.inFlight,
    activity,
  };
}

function watchesEqual(left: ThreadPullRequestWatch, right: ThreadPullRequestWatch): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.headSha === right.headSha &&
    left.failedChecks.join("\n") === right.failedChecks.join("\n") &&
    left.passed === right.passed &&
    left.passedChecks.join("\n") === right.passedChecks.join("\n") &&
    (left.owedChecks ?? []).join("\n") === (right.owedChecks ?? []).join("\n") &&
    left.remarksThrough === right.remarksThrough &&
    left.remarkIds.join("\n") === right.remarkIds.join("\n") &&
    left.conflicting === right.conflicting &&
    left.wakes === right.wakes &&
    left.checksAwaitedSince === right.checksAwaitedSince &&
    left.blockedHead === right.blockedHead &&
    left.mergeHead === right.mergeHead &&
    left.queuedHead === right.queuedHead
  );
}

export class PullRequestWatchReactor extends Context.Service<
  PullRequestWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestWatchReactor") {}

/** @public */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const random = yield* SecureRandom.SecureRandom;
  const bootedAt = yield* Clock.currentTimeMillis;
  const lives = new Map<string, WatchLife>();

  const lifeOf = (target: WatchTarget): WatchLife => {
    const existing = lives.get(lifeKey(target));
    if (existing !== undefined) return existing;
    const startedAt = Date.parse(target.watch.startedAt);
    const life: WatchLife = {
      threadId: target.thread.id,
      pullRequest: threadPullRequestKeyOf(target.link),
      startedAt,
      headSha: target.watch.headSha,
      pushedAt: startedAt,
      longestQuietMs: 0,
      wakes: 0,
      reads: 0,
    };
    lives.set(lifeKey(target), life);
    return life;
  };
  const woke = (target: WatchTarget) =>
    Effect.sync(() => {
      const life = lifeOf(target);
      lives.set(lifeKey(target), { ...life, wakes: life.wakes + 1 });
    });

  const reportEnd = Effect.fn("PullRequestWatchReactor.reportEnd")(function* (
    key: string,
    life: WatchLife,
    reason: WatchEndReason,
  ) {
    lives.delete(key);
    const now = yield* Clock.currentTimeMillis;
    const quietMs = now - life.pushedAt;
    yield* Effect.logInfo("pull request watch ended", {
      threadId: life.threadId,
      pullRequest: life.pullRequest,
      reason,
      minutes: minutes(now - life.startedAt),
      quietMinutes: minutes(quietMs),
      longestQuietMinutes: minutes(Math.max(life.longestQuietMs, quietMs)),
      wakes: life.wakes,
      reads: life.reads,
      partial: life.startedAt < bootedAt,
    });
  });
  const ended = (target: WatchTarget, reason: WatchEndReason) =>
    Effect.suspend(() => reportEnd(lifeKey(target), lifeOf(target), reason));

  const readFailures = new Map<string, number>();
  const lastReads = new Map<string, LastRead>();
  const threadTails = new Map<
    string,
    {
      readonly fetchedAt: number;
      readonly visibleThrough: number;
      readonly tails: ReadonlyMap<
        string,
        { readonly count: number; readonly comments: ReadonlyArray<PullRequestComment> }
      >;
    }
  >();

  const identityOf = (link: ThreadPullRequestLink) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
  });

  /**
   * The orchestrator applies this only while the same watch is on, so a stop or restart
   * that lands during the host read wins.
   */
  const record = Effect.fn("PullRequestWatchReactor.record")(function* (
    target: WatchTarget,
    next: ThreadPullRequestWatch | null,
    wake?: { readonly text: string; readonly notification: OrchestrationV2Notification },
    endedWatch?: ThreadPullRequestWatch,
  ) {
    const uuid = yield* random.uuidV4();
    yield* engine.dispatch({
      type: "thread.pull-request-watch.sync",
      commandId: CommandId.make(`server:pr-watch:${target.thread.id}:${uuid}`),
      threadId: target.thread.id,
      ...identityOf(target.link),
      startedAt: target.watch.startedAt,
      watch: next,
      ...(endedWatch === undefined ? {} : { endedWatch }),
      ...(wake === undefined
        ? {}
        : {
            wake: {
              ...wake,
              messageId: MessageId.make(
                target.watch.agentMerge === undefined
                  ? `message:pr-watch:${uuid}`
                  : `${agentMergeMessagePrefix(threadPullRequestKeyOf(target.link))}${uuid}`,
              ),
            },
          }),
    });
  });

  const giveUp = (target: WatchTarget) =>
    record(target, null, {
      text: `T3 Code stopped watching pull request #${target.link.number} (${target.link.url}) because it failed to read it from the host ${READ_FAILURE_LIMIT} times in a row. ${target.watch.agentMerge === undefined ? "Check it yourself, and call watch_pull_request to watch it again." : "Tell the user, who can start agent merge again."}`,
      notification: {
        source: { kind: "monitor" },
        outcome: "failed",
        summary: `#${target.link.number}: stopped watching, could not read it`,
      },
    }).pipe(
      Effect.tap(() => woke(target)),
      Effect.catch(() => record(target, null)),
      Effect.tap(() => ended(target, "unreadable")),
    );

  const threadBusy = (target: WatchTarget) =>
    engine
      .getThreadRecords(target.thread.id, ["runs"])
      .pipe(
        Effect.map(({ runs }) =>
          runs.some((run) =>
            ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
          ),
        ),
      );

  const readRemarks = Effect.fn("PullRequestWatchReactor.readRemarks")(
    function* (
      key: string,
      reference: PullRequestRef,
      activity: PullRequestActivity,
      now: number,
      rereadMs: number,
    ) {
      // Comment cursors cannot account for missing threads. Only finish a truncated read
      // when the host confirms that every thread was listed.
      if (activity.commentsTruncated && activity.reviewThreadsTruncated !== false) return null;

      const visibleThrough = activity.comments.reduce(
        (latest, comment) => Math.max(latest, Date.parse(comment.editedAt ?? comment.createdAt)),
        0,
      );
      const paginated = activity.reviewThreads.filter(
        (thread) => thread.nextCommentsCursor != null,
      );
      const cached = threadTails.get(key);
      // All tails share one watermark, so newer visible remarks or a changed thread must
      // refresh the entire group before any remarks can advance it.
      const reuse =
        cached !== undefined &&
        now - cached.fetchedAt < rereadMs &&
        cached.visibleThrough === visibleThrough &&
        cached.tails.size === paginated.length &&
        paginated.every(
          (thread) => cached.tails.get(thread.id)?.count === (thread.commentCount ?? 0),
        );
      const tails = new Map<
        string,
        { count: number; comments: ReadonlyArray<PullRequestComment> }
      >();
      const remarks = [...activity.comments];
      for (const thread of paginated) {
        let cursor = thread.nextCommentsCursor ?? null;
        const count = thread.commentCount ?? 0;
        let tail = reuse ? cached.tails.get(thread.id) : undefined;
        if (tail === undefined) {
          const comments = new Map<string, PullRequestComment>();
          const cursors = new Set<string>();
          while (cursor !== null) {
            if (cursors.has(cursor)) return null;
            cursors.add(cursor);
            const page: PullRequestThreadCommentsResult = yield* pullRequests.threadComments({
              ...reference,
              threadId: thread.id,
              cursor,
            });
            for (const comment of page.comments) {
              comments.set(comment.id, {
                ...comment,
                kind: "review-comment",
                path: thread.path,
                reviewState: null,
              });
            }
            cursor = page.nextCursor;
          }
          if (thread.comments.length + comments.size < count) return null;
          tail = { count, comments: [...comments.values()] };
        }
        tails.set(thread.id, tail);
        remarks.push(...tail.comments);
      }
      threadTails.set(key, {
        fetchedAt: reuse ? cached.fetchedAt : now,
        visibleThrough,
        tails,
      });
      return remarks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    Effect.catch((error) =>
      Effect.logWarning("pull request watch comment pagination failed", { error }).pipe(
        Effect.as(null),
      ),
    ),
    (effect, key) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            // A retry must refresh every tail before advancing the shared remark watermark.
            if (Exit.isFailure(exit) || exit.value === null) threadTails.delete(key);
          }),
        ),
      ),
  );

  const closed = (target: WatchTarget) =>
    record(target, null, {
      text: `Pull request #${target.link.number} (${target.link.url}) was closed, so T3 Code stopped watching it. ${target.watch.agentMerge === undefined ? "Call watch_pull_request if it reopens." : "Tell the user."}`,
      notification: {
        source: { kind: "monitor" },
        outcome: "updated",
        summary: `#${target.link.number}: closed, stopped watching`,
      },
    }).pipe(
      Effect.tap(() => woke(target)),
      Effect.tap(() => ended(target, "closed")),
    );

  const endsWithoutRead = ({ thread, link }: WatchTarget): WatchEndReason | undefined =>
    link.snapshot?.state === "merged"
      ? "merged"
      : thread.settledOverride === "settled" || thread.settledAt !== null
        ? "settled"
        : thread.lineage.relationshipToParent === "subagent"
          ? "subagent"
          : undefined;

  const eachTarget = <E>(
    group: WatchGroup,
    step: (target: WatchTarget) => Effect.Effect<void, E>,
  ) =>
    Effect.forEach(group.targets, (target) =>
      step(target).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => {
          lastReads.delete(group.key);
          return logFailure("pull request watch update failed", {
            threadId: target.thread.id,
            pullRequest: group.key,
          })(cause).pipe(Effect.as(false));
        }),
      ),
    ).pipe(Effect.map((landed) => landed.every(Boolean)));

  const referenceOf = (group: WatchGroup) => {
    const first = group.targets[0]!;
    return { projectId: first.thread.projectId, ...identityOf(first.link) };
  };

  const fingerprintOf = (group: WatchGroup) =>
    pullRequests.watchFingerprint(referenceOf(group)).pipe(
      Effect.catchCause(
        (cause): Effect.Effect<ProviderChangeRequestWatchFingerprint | null | "paused"> =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : providerFailureReason(cause) === "rate-limited"
              ? Effect.succeed("paused")
              : Effect.logDebug("pull request watch fingerprint failed", {
                  pullRequest: group.key,
                  cause,
                }).pipe(Effect.as(null)),
      ),
    );

  // Landing a layer lands every open layer below it, so each must pass the same gate. Null means
  // a layer is undecided or the read failed, and the next sweep looks again.
  const judgeStack = Effect.fn("PullRequestWatchReactor.judgeStack")(
    function* (reference: PullRequestRef, head: string) {
      const stack = yield* pullRequests.stack(reference);
      const index = stack?.layers.findIndex((layer) => layer.number === reference.number) ?? -1;
      if (stack == null || index < 0 || stack.layers[index]?.headSha !== head) return null;
      const open = stack.layers.slice(0, index + 1).filter((layer) => layer.state !== "merged");
      const lower = open.slice(0, -1);
      const gates = yield* Effect.forEach(lower, (layer) =>
        Effect.gen(function* () {
          const ref = { ...reference, number: layer.number };
          yield* pullRequests.invalidate({ reference: ref });
          const [layerDetail, layerActivity, summary] = yield* Effect.all(
            [
              pullRequests.detail({ ...ref, allowStale: false }),
              pullRequests.activity(ref),
              pullRequests.summary(ref),
            ],
            { concurrency: "unbounded" },
          );
          const gate = agentMergeGate(
            "merge",
            layerDetail,
            layerActivity.reviewThreads,
            summary.reviewDecision,
          );
          return gate === null
            ? null
            : gate.blockers.map((blocker) => `#${layer.number}: ${blocker}`);
        }),
      );
      const heads = open.flatMap(({ number, headSha }) =>
        headSha === undefined ? [] : [{ number, headSha }],
      );
      if (gates.includes(null) || heads.length !== open.length) return null;
      return { number: stack.number, heads, blockers: gates.flatMap((gate) => gate ?? []) };
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logDebug("pull request stack read failed", { cause }).pipe(Effect.as(null)),
    ),
  );

  const readGroup = Effect.fn("PullRequestWatchReactor.readGroup")(function* (
    group: WatchGroup,
    fingerprint: ProviderChangeRequestWatchFingerprint | null,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const last = lastReads.get(group.key);
    const planned = planRead(group, last, fingerprint, now);
    if (!planned.detail) return;
    // The gate counts open review threads, so it needs activity on every read.
    const plan = {
      ...planned,
      activity:
        planned.activity || group.targets.some(({ watch }) => watch.agentMerge !== undefined),
    };
    if (
      last === undefined ||
      group.targets.some((target) => !last.watches.has(watchKey(target))) ||
      (fingerprint !== null && last.remarks !== fingerprint.remarks)
    ) {
      // A new watch or changed host remarks needs a fresh view of every tail.
      threadTails.delete(group.key);
    }
    const reference = referenceOf(group);
    // Invalidate cached reads before using the newer fingerprint; clients receive no notification.
    if (fingerprint !== null) yield* pullRequests.invalidate({ reference });
    const [detailRead, activityRead] = yield* Effect.all(
      [
        Effect.exit(pullRequests.detail({ ...reference, allowStale: false })),
        Effect.exit(
          plan.activity
            ? pullRequests.activity(reference).pipe(Effect.asSome)
            : Effect.succeed(Option.none<PullRequestActivity>()),
        ),
      ],
      { concurrency: 2 },
    );
    // Activity failures must not cancel or hide a permanent detail failure.
    const read = Exit.isFailure(detailRead)
      ? Exit.failCause(detailRead.cause)
      : Exit.isFailure(activityRead)
        ? Exit.failCause(activityRead.cause)
        : Exit.succeed([detailRead.value, activityRead.value] as const);
    if (Exit.isFailure(read)) {
      if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.failCause(read.cause);
      lastReads.delete(group.key);
      const reason = providerFailureReason(read.cause);
      if (reason === "rate-limited") return;
      // Transport and host failures can outlast the failure limit; keep the watch for recovery.
      if (reason === "failed") {
        readFailures.delete(group.key);
        return yield* Effect.failCause(read.cause);
      }
      const failures = (readFailures.get(group.key) ?? 0) + 1;
      readFailures.set(group.key, failures);
      if (failures >= READ_FAILURE_LIMIT && (yield* eachTarget(group, giveUp))) {
        readFailures.delete(group.key);
      }
      return yield* Effect.failCause(read.cause);
    }
    readFailures.delete(group.key);
    const [detail, activity] = read.value;
    for (const target of group.targets) {
      const life = lifeOf(target);
      const headSha = detail.headSha ?? life.headSha;
      const pushed = life.headSha !== null && headSha !== life.headSha;
      lives.set(lifeKey(target), {
        ...life,
        headSha,
        reads: life.reads + 1,
        ...(pushed
          ? { pushedAt: now, longestQuietMs: Math.max(life.longestQuietMs, now - life.pushedAt) }
          : {}),
      });
    }
    if (detail.state !== "open") {
      lastReads.delete(group.key);
      return yield* eachTarget(group, (target) =>
        detail.state === "closed"
          ? closed(target)
          : record(target, null).pipe(Effect.tap(() => ended(target, "merged"))),
      );
    }

    // Never advance the remark watermark past comments an incomplete read could have missed.
    const remarks = Option.isSome(activity)
      ? yield* readRemarks(
          group.key,
          reference,
          activity.value,
          now,
          fingerprint === null ? QUIET_REREAD_MS : FINGERPRINT_REREAD_MS,
        )
      : null;
    lastReads.set(group.key, {
      at:
        plan.activity || last === undefined
          ? (threadTails.get(group.key)?.fetchedAt ?? now)
          : last.at,
      fingerprint: group.fingerprint,
      inFlight:
        detail.mergeability === "unknown" ||
        detail.checks.some((check) => check.status === "pending"),
      remarksComplete: plan.activity ? remarks !== null : (last?.remarksComplete ?? false),
      watches: new Set(group.targets.map(watchKey)),
      status: fingerprint?.status ?? null,
      remarks: fingerprint?.remarks ?? null,
    });
    yield* eachTarget(group, (target) =>
      Effect.gen(function* () {
        const report = evaluatePullRequestWatch(target.watch, detail, remarks, now);
        const mode = target.watch.agentMerge;
        if (report.changes.length > 0) {
          const wake = pullRequestWatchMessage({
            number: target.link.number,
            url: target.link.url,
            baseBranch: detail.baseBranch,
            headSha: report.next.headSha,
            agentMerge: mode,
            report,
          });
          // An ending watch keeps what this pass saw, so watching again starts from it.
          yield* (
            report.exhausted
              ? record(target, null, wake, report.next)
              : record(target, report.next, wake)
          ).pipe(
            Effect.tap(() => woke(target)),
            Effect.tap(() => (report.exhausted ? ended(target, "comment-limit") : Effect.void)),
          );
          return;
        }
        const head = report.next.headSha;
        // While the host holds the merge there is nothing to decide, and a retry would be refused.
        if (mode === "merge" && head !== null) {
          if (detail.isInMergeQueue === true || detail.autoMergeEnabled === true) {
            const next = { ...report.next, queuedHead: head };
            if (!watchesEqual(next, target.watch)) yield* record(target, next);
            return;
          }
          if (target.watch.queuedHead === head) {
            const { queuedHead: _queuedHead, ...next } = report.next;
            yield* record(
              target,
              next,
              agentMergeLeftQueueMessage({ number: target.link.number }),
            ).pipe(Effect.tap(() => woke(target)));
            return;
          }
        }
        const judge = (reviewDecision: PullRequestReviewDecision | null | undefined) =>
          mode === undefined || remarks === null || !Option.isSome(activity)
            ? null
            : agentMergeGate(mode, detail, activity.value.reviewThreads, reviewDecision);
        const snapshotGate = judge(target.link.snapshot?.reviewDecision);
        if (snapshotGate === null) {
          if (!watchesEqual(report.next, target.watch)) yield* record(target, report.next);
          return;
        }
        // The agent may be about to push, so nothing is decided until the thread is quiet.
        if (yield* threadBusy(target)) {
          if (!watchesEqual(report.next, target.watch)) yield* record(target, report.next);
          return;
        }
        // The snapshot can predate a review, so a pass that would act on it reads the host first.
        const gate =
          snapshotGate.blockers.length > 0 || mode === "checks" || target.watch.mergeHead === head
            ? snapshotGate
            : yield* pullRequests.invalidate({ reference }).pipe(
                Effect.andThen(Effect.exit(pullRequests.summary(reference))),
                Effect.flatMap((summary) =>
                  Exit.isSuccess(summary)
                    ? Effect.succeed(judge(summary.value.reviewDecision))
                    : Cause.hasInterruptsOnly(summary.cause)
                      ? Effect.failCause(summary.cause)
                      : Effect.succeed(null),
                ),
              );
        if (gate === null) {
          if (!watchesEqual(report.next, target.watch)) yield* record(target, report.next);
          return;
        }
        const hold = (blockers: ReadonlyArray<string>) =>
          head === null || target.watch.blockedHead === head
            ? watchesEqual(report.next, target.watch)
              ? Effect.void
              : record(target, report.next)
            : record(
                target,
                { ...report.next, blockedHead: head },
                agentMergeBlockedMessage({ number: target.link.number, blockers }),
              ).pipe(Effect.tap(() => woke(target)));
        if (gate.blockers.length > 0) return yield* hold(gate.blockers);
        const merges =
          mode === "merge" &&
          head !== null &&
          (target.link.stack === null || detail.capabilities.stackActions === true) &&
          detail.capabilities.mergePinsHead === true &&
          detail.viewerPermissions.actions.includes("merge");
        if (!merges) {
          yield* record(
            target,
            null,
            agentMergeReadyMessage({ number: target.link.number, url: target.link.url }),
            report.next,
          ).pipe(
            Effect.tap(() => woke(target)),
            Effect.tap(() => ended(target, "ready")),
          );
          return;
        }
        if (target.watch.mergeHead === head) {
          if (!watchesEqual(report.next, target.watch)) yield* record(target, report.next);
          return;
        }
        const stack = target.link.stack === null ? null : yield* judgeStack(reference, head);
        if (target.link.stack !== null && stack === null) {
          if (!watchesEqual(report.next, target.watch)) yield* record(target, report.next);
          return;
        }
        if (stack !== null && stack.blockers.length > 0) return yield* hold(stack.blockers);
        // Recording first fails if the user stopped the watch during this read.
        yield* record(target, { ...report.next, mergeHead: head });
        const merged = yield* Effect.exit(
          pullRequests.mergeHead({
            ...reference,
            headSha: head,
            mergeCapabilities: detail.mergeCapabilities,
            ...(stack === null ? {} : { stack: { number: stack.number, heads: stack.heads } }),
          }),
        );
        lastReads.delete(group.key);
        if (Exit.isSuccess(merged)) {
          // A withdrawal during the call looked before this landed, so it could not take it back.
          const kept = yield* Effect.exit(record(target, { ...report.next, mergeHead: head }));
          if (Exit.isFailure(kept)) {
            if (Cause.hasInterruptsOnly(kept.cause)) return yield* Effect.failCause(kept.cause);
            yield* pullRequests.withdrawMerge({ ...reference, stacked: stack !== null });
          }
          return;
        }
        if (Cause.hasInterruptsOnly(merged.cause)) return yield* Effect.failCause(merged.cause);
        // Dropping mergeHead lets a later sweep try again, once the rate limit lifts.
        if (providerFailureReason(merged.cause) === "rate-limited") {
          yield* record(target, report.next);
          return;
        }
        yield* record(
          target,
          { ...report.next, mergeHead: head },
          agentMergeRefusedMessage({
            number: target.link.number,
            detail: refusalDetail(merged.cause),
          }),
        ).pipe(Effect.tap(() => woke(target)));
      }),
    );
    // Neither a quiet agent nor a resolved thread changes what the host reports, so reread.
    const latest = lastReads.get(group.key);
    if (latest !== undefined && group.targets.some(({ watch }) => watch.agentMerge !== undefined)) {
      lastReads.set(group.key, { ...latest, inFlight: true });
    }
  });

  const sweep = Effect.gen(function* () {
    const threads = yield* projections.getThreadsWithPullRequests();
    const targets = threads.flatMap((thread) =>
      visibleThreadPullRequests(thread.pullRequests ?? []).flatMap((link) =>
        link.watch === undefined ? [] : [{ thread, link, watch: link.watch }],
      ),
    );
    const present = new Set(targets.map(lifeKey));
    yield* Effect.forEach(
      [...lives].filter(([key]) => !present.has(key)),
      ([key, life]) => reportEnd(key, life, "stopped"),
      { discard: true },
    );
    for (const target of targets) lifeOf(target);
    const byPullRequest = new Map<string, Array<WatchTarget>>();
    const ending: Array<readonly [WatchTarget, WatchEndReason]> = [];
    for (const target of targets) {
      const reason = endsWithoutRead(target);
      if (reason !== undefined) {
        ending.push([target, reason]);
        continue;
      }
      // Group by project because checkout access differs; one failure must not end another project's watches.
      const key = `${target.thread.projectId} ${threadPullRequestKeyOf(target.link)}`;
      byPullRequest.set(key, [...(byPullRequest.get(key) ?? []), target]);
    }
    const groups = [...byPullRequest].map(([key, members]): WatchGroup => ({
      key,
      targets: members,
      fingerprint: [...new Set(members.map(snapshotFingerprint))].toSorted().join("\n"),
    }));
    for (const cache of [readFailures, lastReads, threadTails]) {
      for (const key of cache.keys()) if (!byPullRequest.has(key)) cache.delete(key);
    }
    yield* Effect.forEach(
      ending,
      ([target, reason]) =>
        record(target, null).pipe(
          Effect.tap(() => ended(target, reason)),
          Effect.catchCause(
            logFailure("pull request watch stop failed", {
              threadId: target.thread.id,
              pullRequest: threadPullRequestKeyOf(target.link),
            }),
          ),
        ),
      { discard: true },
    );
    // Every fingerprint is asked for at once so the host can batch them, and each group reads
    // as soon as its own answer lands rather than waiting on the slowest host.
    const reads = yield* Semaphore.make(GROUP_READS);
    yield* Effect.forEach(
      groups,
      (group) =>
        fingerprintOf(group).pipe(
          Effect.flatMap((fingerprint) =>
            fingerprint === "paused"
              ? Effect.void
              : reads.withPermit(
                  readGroup(group, fingerprint).pipe(
                    Effect.catchCause(
                      logFailure("pull request watch check failed", { pullRequest: group.key }),
                    ),
                  ),
                ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  }).pipe(
    Effect.catchCause(logFailure("pull request watch sweep failed", {})),
    Effect.withSpan("PullRequestWatchReactor.sweep"),
  );

  const start: PullRequestWatchReactor["Service"]["start"] = () =>
    forkParked(
      sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
    );

  return { start, sweep } satisfies PullRequestWatchReactor["Service"];
});

export const layer = Layer.effect(PullRequestWatchReactor, make);
