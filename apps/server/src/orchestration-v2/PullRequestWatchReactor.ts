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
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { evaluatePullRequestWatch, pullRequestWatchMessage } from "./pullRequestWatch.ts";

/** Passes in a row that could not read a pull request before its watch ends (one a minute). */
const READ_FAILURE_LIMIT = 15;

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

const failureKey = ({ thread, link, watch }: WatchTarget) =>
  `${thread.id} ${threadPullRequestKeyOf(link)} ${watch.startedAt}`;

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
 * conflict. One pass a minute reads each watched pull request; settling a thread ends its
 * watches, and a merged or closed pull request ends its watch.
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

  // Passes in a row that failed, per watch. Kept in memory: a restart only delays the stop.
  const readFailures = new Map<string, number>();
  // Replies past each long thread's first page, per watch, so a pass pages a thread again only
  // when the host's count of it moves. Kept in memory: a restart pages each thread once more.
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
      text: `T3 Code stopped watching pull request #${target.link.number} (${target.link.url}) because it could not read it from the host for ${READ_FAILURE_LIMIT} minutes. Check it yourself, and call watch_pull_request to watch it again.`,
      notification: {
        source: { kind: "monitor" },
        outcome: "failed",
        summary: `#${target.link.number}: stopped watching, could not read it`,
      },
    }).pipe(Effect.catch(() => record(target, null)));

  const readRemarks = Effect.fn("PullRequestWatchReactor.readRemarks")(
    function* (target: WatchTarget, reference: PullRequestRef, activity: PullRequestActivity) {
      // Comment cursors cannot account for missing threads. Only finish a truncated read
      // when the host confirms that every thread was listed.
      if (activity.commentsTruncated && activity.reviewThreadsTruncated !== false) return null;

      const key = failureKey(target);
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

  const check = Effect.fn("PullRequestWatchReactor.check")(function* (target: WatchTarget) {
    const { thread, link, watch } = target;
    const pullRequest = identityOf(link);
    // A merged pull request cannot reopen, so its watch ends without a host read, even on a
    // settled thread. A closed one can, so the host decides below.
    if (link.snapshot?.state === "merged") return yield* record(target, null);
    if (thread.settledOverride === "settled" || thread.settledAt !== null) return;

    const reference = { projectId: thread.projectId, ...pullRequest };
    const read = yield* Effect.exit(
      Effect.all(
        [
          pullRequests.detail({ ...reference, allowStale: false }),
          pullRequests.activity(reference),
        ],
        { concurrency: 2 },
      ),
    );
    // Only host reads count towards giving up; a refused wake is not the host's fault.
    const key = failureKey(target);
    if (Exit.isFailure(read)) {
      if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.failCause(read.cause);
      const failures = (readFailures.get(key) ?? 0) + 1;
      readFailures.set(key, failures);
      // The count stays until the stop lands, so a failed stop is tried again next pass.
      if (failures >= READ_FAILURE_LIMIT) {
        yield* giveUp(target);
        readFailures.delete(key);
      }
      return yield* Effect.failCause(read.cause);
    }
    readFailures.delete(key);
    const [detail, activity] = read.value;
    if (detail.state !== "open") return yield* record(target, null);

    // Never advance the remark watermark past comments an incomplete read could have missed.
    const remarks = yield* readRemarks(target, reference, activity);
    const report = evaluatePullRequestWatch(watch, detail, remarks);
    if (report.changes.length > 0) {
      return yield* record(
        target,
        report.exhausted ? null : report.next,
        pullRequestWatchMessage({
          number: link.number,
          url: link.url,
          baseBranch: detail.baseBranch,
          headSha: report.next.headSha,
          report,
        }),
      );
    }
    if (!watchesEqual(report.next, watch)) yield* record(target, report.next);
  });

  const sweep = Effect.gen(function* () {
    const threads = yield* projections.getThreadsWithPullRequests();
    const targets = threads.flatMap((thread) =>
      visibleThreadPullRequests(thread.pullRequests ?? []).flatMap((link) =>
        link.watch === undefined ? [] : [{ thread, link, watch: link.watch }],
      ),
    );
    const keys = new Set(targets.map(failureKey));
    for (const key of readFailures.keys()) if (!keys.has(key)) readFailures.delete(key);
    for (const key of threadTails.keys()) if (!keys.has(key)) threadTails.delete(key);
    yield* Effect.forEach(
      targets,
      (target) =>
        check(target).pipe(
          Effect.catchCause(
            logFailure("pull request watch check failed", {
              threadId: target.thread.id,
              pullRequest: threadPullRequestKeyOf(target.link),
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(
    Effect.catchCause(logFailure("pull request watch sweep failed", {})),
    Effect.withSpan("PullRequestWatchReactor.sweep"),
  );

  const start: PullRequestWatchReactor["Service"]["start"] = () =>
    forkParked(sweep.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid));

  return { start, sweep } satisfies PullRequestWatchReactor["Service"];
});

export const layer = Layer.effect(PullRequestWatchReactor, make);
