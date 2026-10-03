import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
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

    // A degraded read (GitHub's review thread query failed) is truncated with no long thread to
    // explain it, and would skip review comments, so remarks wait for a later pass. Replies past
    // the first ten of a long review thread are not read.
    const degraded =
      activity.commentsTruncated &&
      !activity.reviewThreads.some((reviewThread) => reviewThread.nextCommentsCursor !== undefined);
    const report = evaluatePullRequestWatch(watch, detail, degraded ? null : activity.comments);
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
    const threads = yield* projections.getThreadsWithPullRequests();
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
