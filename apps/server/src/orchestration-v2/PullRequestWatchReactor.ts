import {
  CommandId,
  MessageId,
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
      : Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) });

function watchesEqual(left: ThreadPullRequestWatch, right: ThreadPullRequestWatch): boolean {
  return (
    left.startedAt === right.startedAt &&
    left.headSha === right.headSha &&
    left.checks === right.checks &&
    left.remarksThrough === right.remarksThrough &&
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
    const stop = crypto.randomUUIDv4.pipe(
      Effect.flatMap((uuid) =>
        engine.dispatch({
          type: "thread.pull-request.watch",
          commandId: CommandId.make(`server:pr-watch-stop:${thread.id}:${uuid}`),
          threadId: thread.id,
          ...pullRequest,
          watching: false,
        }),
      ),
    );
    if (link.snapshot !== null && link.snapshot.state !== "open") return yield* stop;
    if (thread.settledOverride === "settled" || thread.settledAt !== null) return;

    const reference = { projectId: thread.projectId, ...pullRequest };
    const [detail, activity] = yield* Effect.all(
      [pullRequests.detail({ ...reference, allowStale: false }), pullRequests.activity(reference)],
      { concurrency: 2 },
    );
    if (detail.state !== "open") return yield* stop;

    const report = evaluatePullRequestWatch(watch, detail, activity);
    if (report.changes.length > 0) {
      const { text, notification } = pullRequestWatchMessage({
        number: link.number,
        url: link.url,
        baseBranch: detail.baseBranch,
        headSha: report.next.headSha,
        report,
      });
      // Derived from the watch it records, so a pass that repeats after a failed record below
      // replays this command's receipt instead of waking the agent twice. A wake the
      // orchestrator refuses is logged and still recorded, so the watch cannot stall on it.
      const next = report.next;
      const wakeId = [
        thread.id,
        threadPullRequestKeyOf(link),
        Date.parse(next.startedAt),
        next.wakes,
        next.headSha ?? "-",
        next.checks ?? "-",
        Date.parse(next.remarksThrough),
        next.conflicting ? 1 : 0,
      ].join(":");
      yield* engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:pr-watch:${wakeId}`),
          threadId: thread.id,
          messageId: MessageId.make(`message:pr-watch:${wakeId}`),
          text,
          notification,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.catchCause(
            logFailure("pull request watch wake failed", {
              threadId: thread.id,
              pullRequest: threadPullRequestKeyOf(link),
            }),
          ),
        );
    }
    if (report.exhausted) return yield* stop;
    if (watchesEqual(report.next, watch)) return;
    const uuid = yield* crypto.randomUUIDv4;
    yield* engine.dispatch({
      type: "thread.pull-request-watch.sync",
      commandId: CommandId.make(`server:pr-watch-sync:${thread.id}:${uuid}`),
      threadId: thread.id,
      ...pullRequest,
      watch: report.next,
    });
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
