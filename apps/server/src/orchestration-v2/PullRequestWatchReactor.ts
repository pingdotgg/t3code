import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type PullRequestComment,
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
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { evaluatePullRequestWatch, pullRequestWatchMessage } from "./pullRequestWatch.ts";

/** Extra comment pages read per review thread; a longer thread leaves the read incomplete. */
const THREAD_PAGES = 5;

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

function watchesEqual(left: ThreadPullRequestWatch, right: ThreadPullRequestWatch): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.headSha === right.headSha &&
    left.checks === right.checks &&
    left.remarksThrough === right.remarksThrough &&
    left.remarkIds.join("\n") === right.remarkIds.join("\n") &&
    left.conflicting === right.conflicting &&
    left.wakes === right.wakes
  );
}

/**
 * Wakes a thread's agent when a pull request it watches (`watch_pull_request`) needs a look:
 * checks finished on the head commit, someone else commented, or the branch started to
 * conflict. One pass a minute reads each watched pull request; settled threads wait until
 * they are active again, and a merged or closed pull request ends its watch.
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

  const check = Effect.fn("PullRequestWatchReactor.check")(function* (
    thread: ProjectionStore.ProjectionThreadPullRequests,
    link: ThreadPullRequestLink,
    watch: ThreadPullRequestWatch,
  ) {
    // Host-level identity, with the repository as linked, the way pull request sync reads it.
    const pullRequest = {
      host: normalizeThreadPullRequestKey(link).host,
      repository: link.repository,
      number: link.number,
    };
    // The orchestrator applies this only while the same watch is on, so a stop or restart that
    // lands during the host read wins.
    const record = (
      next: ThreadPullRequestWatch | null,
      wake?: { readonly text: string; readonly notification: OrchestrationV2Notification },
    ) =>
      Effect.gen(function* () {
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`server:pr-watch:${thread.id}:${uuid}`),
          threadId: thread.id,
          ...pullRequest,
          startedAt: watch.startedAt,
          watch: next,
          ...(wake === undefined
            ? {}
            : { wake: { ...wake, messageId: MessageId.make(`message:pr-watch:${uuid}`) } }),
        });
      });
    // A merged pull request cannot reopen, so its watch ends without a host read, even on a
    // settled thread. A closed one can, so the host decides below.
    if (link.snapshot?.state === "merged") return yield* record(null);
    if (thread.settledOverride === "settled" || thread.settledAt !== null) return;

    const reference = { projectId: thread.projectId, ...pullRequest };
    const [detail, activity] = yield* Effect.all(
      [pullRequests.detail({ ...reference, allowStale: false }), pullRequests.activity(reference)],
      { concurrency: 2 },
    );
    if (detail.state !== "open") return yield* record(null);

    // GitHub sends the first comments of each review thread; the rest are read here so a late
    // reply in a long thread still counts.
    const longThreads = activity.reviewThreads.filter(
      (reviewThread) => reviewThread.nextCommentsCursor !== undefined,
    );
    const rest = yield* Effect.forEach(
      longThreads,
      (reviewThread) =>
        Effect.gen(function* () {
          const comments: Array<PullRequestComment> = [];
          let cursor: string | null | undefined = reviewThread.nextCommentsCursor;
          for (let page = 0; cursor != null && page < THREAD_PAGES; page += 1) {
            const result: PullRequestThreadCommentsResult = yield* pullRequests.threadComments({
              ...reference,
              threadId: reviewThread.id,
              cursor,
            });
            for (const comment of result.comments) {
              comments.push({
                ...comment,
                kind: "review-comment",
                path: reviewThread.path,
                reviewState: null,
              });
            }
            cursor = result.nextCursor;
          }
          return { comments, whole: cursor == null };
        }).pipe(
          // A failed page only leaves the remarks for a later pass; checks still count now.
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            () => Effect.succeed({ comments: [], whole: false }),
          ),
        ),
      { concurrency: 2 },
    );
    // A truncated conversation with no long thread to explain it is a degraded read.
    const whole =
      (!activity.commentsTruncated || longThreads.length > 0) && rest.every((read) => read.whole);
    const remarks = whole ? [...activity.comments, ...rest.flatMap((read) => read.comments)] : null;

    // GitHub names the head commit; elsewhere the newest commit stands in, so a push still reads
    // as one. Azure DevOps reports neither, and relies on checks starting over.
    const newest = activity.commits.reduce<(typeof activity.commits)[number] | undefined>(
      (latest, commit) =>
        latest === undefined || Date.parse(commit.committedDate) > Date.parse(latest.committedDate)
          ? commit
          : latest,
      undefined,
    );
    const headSha = detail.headSha ?? newest?.oid;
    const report = evaluatePullRequestWatch(
      watch,
      { ...detail, ...(headSha === undefined ? {} : { headSha }) },
      remarks,
    );
    if (report.changes.length > 0) {
      return yield* record(
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
    if (!watchesEqual(report.next, watch)) yield* record(report.next);
  });

  const sweep = Effect.gen(function* () {
    const threads = yield* projections.getThreadsWatchingPullRequests();
    yield* Effect.forEach(
      threads.flatMap((thread) =>
        visibleThreadPullRequests(thread.pullRequests ?? []).flatMap((link) =>
          link.watch === undefined ? [] : [{ thread, link, watch: link.watch }],
        ),
      ),
      ({ thread, link, watch }) =>
        check(thread, link, watch).pipe(
          Effect.catchCause(
            logFailure("pull request watch check failed", {
              threadId: thread.id,
              pullRequest: threadPullRequestKeyOf(link),
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
