import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type PullRequestActivity,
  type PullRequestComment,
  type PullRequestRef,
  type PullRequestThreadCommentsResult,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
} from "@t3tools/contracts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { evaluatePullRequestWatch, pullRequestWatchMessage } from "./pullRequestWatch.ts";

/**
 * Minutes between passes. Checks take minutes, so a faster pass mostly spends the host's rate
 * limit, which every machine on the same account shares.
 */
const SWEEP_MINUTES = 2;
/** Reads in a row that failed for a reason other than a rate limit before the watch ends. */
const READ_FAILURE_LIMIT = 8;
/**
 * A pull request with nothing in flight is read again only when its sync snapshot moves, or
 * after this long, for news the snapshot cannot show, such as a bot editing its review.
 */
const QUIET_REREAD_MS = 10 * 60_000;

const isProviderError = Schema.is(PullRequestProviderError);

/** A rate limit is the host asking us to wait, not a sign the pull request cannot be read. */
const isRateLimited = (cause: Cause.Cause<PullRequestService.PullRequestError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => false,
    onSome: (error) =>
      error._tag === "PullRequestOperationError" &&
      isProviderError(error.cause) &&
      error.cause.reason === "rate-limited",
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

/** Every thread that watches one pull request, read once per pass. */
interface WatchGroup {
  readonly key: string;
  readonly targets: ReadonlyArray<WatchTarget>;
  /** What sync last saw of the pull request, to skip a read when nothing moved. */
  readonly fingerprint: string;
}

/** The last successful read of a pull request, kept in memory: a restart reads each once. */
interface LastRead {
  readonly at: number;
  readonly fingerprint: string;
  /** Nothing is in flight or unread, so only a moved snapshot or the reread brings news. */
  readonly quiet: boolean;
}

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

function needsRead(group: WatchGroup, last: LastRead | undefined, now: number): boolean {
  return (
    last === undefined ||
    !last.quiet ||
    last.fingerprint !== group.fingerprint ||
    now - last.at >= QUIET_REREAD_MS ||
    // A new watch takes its first look right away.
    group.targets.some((target) => Date.parse(target.watch.startedAt) > last.at)
  );
}

function watchesEqual(left: ThreadPullRequestWatch, right: ThreadPullRequestWatch): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.headSha === right.headSha &&
    left.failedChecks.join("\n") === right.failedChecks.join("\n") &&
    left.passed === right.passed &&
    left.passedChecks.join("\n") === right.passedChecks.join("\n") &&
    left.remarksThrough === right.remarksThrough &&
    left.remarkIds.join("\n") === right.remarkIds.join("\n") &&
    left.conflicting === right.conflicting &&
    left.wakes === right.wakes
  );
}

/**
 * Wakes a thread's agent when a pull request it watches (`watch_pull_request`) needs a look:
 * checks finished on the head commit, someone else commented, or the branch started to
 * conflict. A pass every two minutes reads each watched pull request once for all the threads
 * that watch it, and skips one whose sync snapshot has not moved while nothing is in flight.
 * Settling or archiving a thread ends its watches, and a merged or closed pull request ends
 * its watch.
 */
export class PullRequestWatchReactor extends Context.Service<
  PullRequestWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One pass over every watched pull request. */
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestWatchReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;

  // Reads in a row that failed, per pull request. Kept in memory: a restart only delays the stop.
  const readFailures = new Map<string, number>();
  const lastReads = new Map<string, LastRead>();
  // Replies past each long thread's first page, per pull request, so a pass pages a thread
  // again only when the host's count of it moves. A restart pages each thread once more.
  const threadTails = new Map<
    string,
    Map<string, { readonly count: number; readonly comments: ReadonlyArray<PullRequestComment> }>
  >();

  // Host-level identity, with the repository as linked, the way pull request sync reads it.
  const identityOf = (link: ThreadPullRequestLink) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
  });

  /**
   * Records what a pass saw, and wakes the agent with it. The orchestrator applies this only
   * while the same watch is on, so a stop or restart that lands during the host read wins.
   */
  const record = (
    target: WatchTarget,
    next: ThreadPullRequestWatch | null,
    wake?: { readonly text: string; readonly notification: OrchestrationV2Notification },
  ) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      yield* engine.dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make(`server:pr-watch:${target.thread.id}:${uuid}`),
        threadId: target.thread.id,
        ...identityOf(target.link),
        startedAt: target.watch.startedAt,
        watch: next,
        ...(wake === undefined
          ? {}
          : { wake: { ...wake, messageId: MessageId.make(`message:pr-watch:${uuid}`) } }),
      });
    });

  // A watch that cannot read its pull request ends with a wake saying so, rather than showing
  // "Watching" while it learns nothing.
  const giveUp = (target: WatchTarget) =>
    record(target, null, {
      text: `T3 Code stopped watching pull request #${target.link.number} (${target.link.url}) because it failed to read it from the host ${READ_FAILURE_LIMIT} times in a row. Check it yourself, and call watch_pull_request to watch it again.`,
      notification: {
        source: { kind: "monitor" },
        outcome: "failed",
        summary: `#${target.link.number}: stopped watching, could not read it`,
      },
    }).pipe(Effect.catch(() => record(target, null)));

  const readRemarks = Effect.fn("PullRequestWatchReactor.readRemarks")(
    function* (key: string, reference: PullRequestRef, activity: PullRequestActivity) {
      // Comment cursors cannot account for missing threads. Only finish a truncated read
      // when the host confirms that every thread was listed.
      if (activity.commentsTruncated && activity.reviewThreadsTruncated !== false) return null;

      let tails = threadTails.get(key);
      if (tails === undefined) {
        tails = new Map();
        threadTails.set(key, tails);
      }
      const remarks = [...activity.comments];
      for (const thread of activity.reviewThreads) {
        let cursor = thread.nextCommentsCursor ?? null;
        if (cursor === null) continue;
        const count = thread.commentCount ?? 0;
        let tail = tails.get(thread.id);
        if (tail?.count !== count) {
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
          tails.set(thread.id, tail);
        }
        remarks.push(...tail.comments);
      }
      return remarks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    },
    Effect.catch((error) =>
      Effect.logWarning("pull request watch comment pagination failed", { error }).pipe(
        Effect.as(null),
      ),
    ),
  );

  // A closed pull request can reopen, but the watch has nothing to report until then.
  const closed = (target: WatchTarget) =>
    record(target, null, {
      text: `Pull request #${target.link.number} (${target.link.url}) was closed, so T3 Code stopped watching it. Call watch_pull_request if it reopens.`,
      notification: {
        source: { kind: "monitor" },
        outcome: "updated",
        summary: `#${target.link.number}: closed, stopped watching`,
      },
    });

  /** Watches that end without a host read; the rest are read once per pull request. */
  const endsWithoutRead = ({ thread, link }: WatchTarget) =>
    // A merged pull request cannot reopen. Settling and archiving end watches, and a subagent
    // cannot start one; a watch left from before those rules ends here.
    link.snapshot?.state === "merged" ||
    thread.settledOverride === "settled" ||
    thread.settledAt !== null ||
    thread.lineage.relationshipToParent === "subagent";

  /** Runs one thread's step for each thread in a group, so one refusal does not skip the rest. */
  const eachTarget = <E>(
    group: WatchGroup,
    step: (target: WatchTarget) => Effect.Effect<void, E>,
  ) =>
    Effect.forEach(
      group.targets,
      (target) =>
        step(target).pipe(
          Effect.catchCause(
            logFailure("pull request watch update failed", {
              threadId: target.thread.id,
              pullRequest: group.key,
            }),
          ),
        ),
      { discard: true },
    );

  const readGroup = Effect.fn("PullRequestWatchReactor.readGroup")(function* (group: WatchGroup) {
    const now = yield* Clock.currentTimeMillis;
    if (!needsRead(group, lastReads.get(group.key), now)) return;
    const first = group.targets[0]!;
    const reference = { projectId: first.thread.projectId, ...identityOf(first.link) };
    const read = yield* Effect.exit(
      Effect.all(
        [
          pullRequests.detail({ ...reference, allowStale: false }),
          pullRequests.activity(reference),
        ],
        { concurrency: 2 },
      ),
    );
    if (Exit.isFailure(read)) {
      if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.failCause(read.cause);
      lastReads.delete(group.key);
      // The host's pause refuses later reads without a request, so waiting it out is free.
      if (isRateLimited(read.cause)) return;
      const failures = (readFailures.get(group.key) ?? 0) + 1;
      readFailures.set(group.key, failures);
      // The count stays until the stops land, so a failed stop is tried again next pass.
      if (failures >= READ_FAILURE_LIMIT) {
        yield* eachTarget(group, giveUp);
        readFailures.delete(group.key);
      }
      return yield* Effect.failCause(read.cause);
    }
    readFailures.delete(group.key);
    const [detail, activity] = read.value;
    if (detail.state !== "open") {
      lastReads.delete(group.key);
      return yield* eachTarget(group, (target) =>
        detail.state === "closed" ? closed(target) : record(target, null),
      );
    }

    // Never advance the remark watermark past comments an incomplete read could have missed.
    const remarks = yield* readRemarks(group.key, reference, activity);
    lastReads.set(group.key, {
      at: now,
      fingerprint: group.fingerprint,
      // Comments a partial read could not see are read again next pass.
      quiet:
        remarks !== null &&
        detail.mergeability !== "unknown" &&
        detail.checks.every((check) => check.status !== "pending"),
    });
    yield* eachTarget(group, (target) => {
      const report = evaluatePullRequestWatch(target.watch, detail, remarks);
      if (report.changes.length > 0) {
        return record(
          target,
          report.exhausted ? null : report.next,
          pullRequestWatchMessage({
            number: target.link.number,
            url: target.link.url,
            baseBranch: detail.baseBranch,
            headSha: report.next.headSha,
            report,
          }),
        );
      }
      return watchesEqual(report.next, target.watch) ? Effect.void : record(target, report.next);
    });
  });

  const sweep = Effect.gen(function* () {
    const threads = yield* projections.getThreadsWithPullRequests();
    const targets = threads.flatMap((thread) =>
      visibleThreadPullRequests(thread.pullRequests ?? []).flatMap((link) =>
        link.watch === undefined ? [] : [{ thread, link, watch: link.watch }],
      ),
    );
    const byPullRequest = new Map<string, Array<WatchTarget>>();
    const ending: Array<WatchTarget> = [];
    for (const target of targets) {
      if (endsWithoutRead(target)) {
        ending.push(target);
        continue;
      }
      const key = threadPullRequestKeyOf(target.link);
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
      (target) =>
        record(target, null).pipe(
          Effect.catchCause(
            logFailure("pull request watch stop failed", {
              threadId: target.thread.id,
              pullRequest: threadPullRequestKeyOf(target.link),
            }),
          ),
        ),
      { discard: true },
    );
    yield* Effect.forEach(
      groups,
      (group) =>
        readGroup(group).pipe(
          Effect.catchCause(
            logFailure("pull request watch check failed", { pullRequest: group.key }),
          ),
        ),
      { concurrency: 4, discard: true },
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
