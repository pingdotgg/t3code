import { CommandId, MessageId, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  getPullRequestMonitorSnapshot,
  type GitHubPullRequestMonitorError,
  type PullRequestMonitorSnapshot,
} from "../sourceControl/gitHubPullRequestMonitor.ts";
import * as MonitorRegistry from "./MonitorRegistry.ts";
import { diffPullRequestMonitorSnapshot, type PullRequestMonitorCursor } from "./monitorDiff.ts";
import { computeReadiness } from "./readiness.ts";
import { buildWakePrompt, formatBlockersSummary } from "./wakePrompt.ts";

const POLL_INTERVAL = Duration.seconds(30);
const MAX_BACKOFF = Duration.minutes(5);

interface WakeClaim {
  readonly generation: number;
  readonly commandId: CommandId;
  readonly phase: "pending" | "in-flight";
  readonly dispatchedAt?: string;
  readonly previousWakeCount: number;
  // Cursor as it was before this wake acked, so a wake that dies after the
  // ack — provider start failure, superseded by a user turn — can rewind and
  // let the next poll re-diff the same events instead of losing them (I5).
  readonly previousCursor: PullRequestMonitorCursor;
}

export interface PullRequestSnapshotFetcherShape {
  readonly fetch: (input: {
    readonly cwd: string;
    readonly pullRequestNumber: number;
  }) => Effect.Effect<PullRequestMonitorSnapshot, GitHubPullRequestMonitorError>;
}

export class PullRequestSnapshotFetcher extends Context.Service<
  PullRequestSnapshotFetcher,
  PullRequestSnapshotFetcherShape
>()("t3/monitor/PullRequestMonitor/PullRequestSnapshotFetcher") {}

export const PullRequestSnapshotFetcherLive = Layer.effect(
  PullRequestSnapshotFetcher,
  Effect.gen(function* () {
    const githubCli = yield* GitHubCli.GitHubCli;
    return PullRequestSnapshotFetcher.of({
      fetch: (input) =>
        getPullRequestMonitorSnapshot(input).pipe(
          Effect.provideService(GitHubCli.GitHubCli, githubCli),
        ),
    });
  }),
);

export class PullRequestMonitor extends Context.Service<
  PullRequestMonitor,
  {
    readonly start: () => Effect.Effect<void>;
    readonly pollOnce: Effect.Effect<void>;
    readonly handleDomainEvent: (event: OrchestrationEvent) => Effect.Effect<void>;
  }
>()("t3/monitor/PullRequestMonitor") {}

const threadIdOf = (event: OrchestrationEvent): ThreadId | undefined =>
  "threadId" in event.payload ? event.payload.threadId : undefined;

export const make = Effect.gen(function* () {
  const registry = yield* MonitorRegistry.MonitorRegistry;
  const fetcher = yield* PullRequestSnapshotFetcher;
  const engine = yield* OrchestrationEngineService;
  // Give session-teardown paths (which run outside this service's context) a
  // way to dispatch thread.monitor.end through the real engine.
  MonitorRegistry.bindEngine(engine);
  const snapshots = yield* ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const claims = yield* Ref.make<ReadonlyMap<ThreadId, WakeClaim>>(new Map());
  const lastPollFailed = yield* Ref.make(false);

  const mutateClaim = (
    threadId: ThreadId,
    f: (claim: WakeClaim | undefined) => WakeClaim | undefined,
  ) =>
    Ref.update(claims, (current) => {
      const next = new Map(current);
      const claim = f(next.get(threadId));
      if (claim === undefined) next.delete(threadId);
      else next.set(threadId, claim);
      return next;
    });

  // Drop a claim matching `shouldRelease`; if its wake had already advanced
  // the cursor, rewind to the pre-wake cursor so those events re-diff (I5).
  const releaseClaim = (threadId: ThreadId, shouldRelease: (claim: WakeClaim) => boolean) =>
    Ref.modify(claims, (current) => {
      const claim = current.get(threadId);
      if (claim === undefined || !shouldRelease(claim)) {
        return [undefined, current] as const;
      }
      const next = new Map(current);
      next.delete(threadId);
      return [claim, next] as const;
    }).pipe(
      Effect.flatMap((released) =>
        released === undefined || released.phase !== "in-flight"
          ? Effect.void
          : Effect.all([
              registry.updateCursor(threadId, released.previousCursor, released.generation),
              registry.setWakeCount(threadId, released.previousWakeCount, released.generation),
            ]).pipe(Effect.asVoid),
      ),
    );

  const dispatchUpdate = Effect.fn("PullRequestMonitor.dispatchUpdate")(function* (
    threadId: ThreadId,
    blockersSummary: string,
    headSha: string,
    wakeCount: number,
  ) {
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.monitor.update",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      blockersSummary,
      headSha,
      wakeCount,
      updatedAt,
    });
  });

  const end = Effect.fn("PullRequestMonitor.end")(function* (
    threadId: ThreadId,
    reason: "ready" | "terminal" | "needs-attention" | "stopped",
    blockersSummary: string,
    expectedGeneration: number,
  ) {
    const current = yield* registry.get(threadId);
    if (Option.isNone(current) || current.value.generation !== expectedGeneration) return;
    // Dispatch before removing: if the end event fails to persist, the
    // registration survives and the next poll retries the same terminal /
    // ready / breaker verdict, instead of leaving the projection stuck on
    // "monitoring" with nothing polling it.
    const endedAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.monitor.end",
      commandId: CommandId.make(yield* crypto.randomUUIDv4),
      threadId,
      reason,
      blockersSummary,
      endedAt,
    });
    yield* registry.remove(threadId, expectedGeneration);
    yield* mutateClaim(threadId, () => undefined);
  });

  const dispatchWake = Effect.fn("PullRequestMonitor.dispatchWake")(function* (
    registration: MonitorRegistry.MonitorRegistration,
    snapshot: PullRequestMonitorSnapshot,
    nextCursor: PullRequestMonitorCursor,
    prompt: string,
  ) {
    const commandId = CommandId.make(yield* crypto.randomUUIDv4);
    let claimed = false;
    yield* Ref.update(claims, (current) => {
      if (current.has(registration.threadId)) return current;
      claimed = true;
      return new Map(current).set(registration.threadId, {
        generation: registration.generation,
        commandId,
        phase: "pending",
        previousCursor: registration.cursor,
        previousWakeCount: registration.wakeCount,
      });
    });
    if (!claimed) return;

    const current = yield* registry.get(registration.threadId);
    // Fresh terminal read at the send boundary (I1): the poll's snapshot is
    // seconds stale by now, and a merge in that window must veto the wake —
    // the cached `latestStates` alone cannot see it.
    const freshState = yield* fetcher
      .fetch({ cwd: registration.repoCwd, pullRequestNumber: registration.prNumber })
      .pipe(
        Effect.map((fresh) => Option.some(fresh.state)),
        Effect.orElseSucceed(() => Option.none<PullRequestMonitorSnapshot["state"]>()),
      );
    if (Option.isNone(freshState)) {
      yield* mutateClaim(registration.threadId, (claim) =>
        claim?.commandId === commandId ? undefined : claim,
      );
      return;
    }
    const state = freshState.value;
    const thread = yield* snapshots.getThreadDetailById(registration.threadId);
    const validRegistration =
      Option.isSome(current) && current.value.generation === registration.generation;
    const busy =
      Option.isNone(thread) ||
      thread.value.latestTurn?.state === "running" ||
      (thread.value.session?.activeTurnId !== null &&
        thread.value.session?.activeTurnId !== undefined) ||
      thread.value.session?.status === "starting" ||
      thread.value.session?.status === "running";
    const stillClaimed =
      (yield* Ref.get(claims)).get(registration.threadId)?.commandId === commandId;
    if (!validRegistration || state === "closed" || state === "merged" || busy || !stillClaimed) {
      yield* mutateClaim(registration.threadId, (claim) =>
        claim?.commandId === commandId ? undefined : claim,
      );
      return;
    }

    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: registration.threadId,
        message: {
          messageId: MessageId.make(yield* crypto.randomUUIDv4),
          role: "user",
          text: prompt,
          attachments: [],
        },
        runtimeMode: thread.value.runtimeMode,
        interactionMode: thread.value.interactionMode,
        createdAt,
      })
      .pipe(
        Effect.tap(() =>
          DateTime.now.pipe(
            Effect.map(DateTime.formatIso),
            Effect.flatMap((dispatchedAt) =>
              mutateClaim(registration.threadId, (claim) =>
                claim?.commandId === commandId
                  ? { ...claim, phase: "in-flight", dispatchedAt }
                  : claim,
              ),
            ),
          ),
        ),
        Effect.tap(() =>
          registry.updateCursor(registration.threadId, nextCursor, registration.generation),
        ),
        Effect.tapError(() =>
          mutateClaim(registration.threadId, (claim) =>
            claim?.commandId === commandId ? undefined : claim,
          ),
        ),
      );
    const wakeCount = yield* registry.incrementWake(registration.threadId, registration.generation);
    yield* dispatchUpdate(
      registration.threadId,
      formatBlockersSummary(computeReadiness(snapshot)),
      snapshot.headSha,
      wakeCount,
    );
  });

  const pollRegistration = Effect.fn("PullRequestMonitor.pollRegistration")(function* (
    registration: MonitorRegistry.MonitorRegistration,
  ) {
    const fetchedSnapshot = yield* fetcher.fetch({
      cwd: registration.repoCwd,
      pullRequestNumber: registration.prNumber,
    });
    const snapshot = {
      ...fetchedSnapshot,
      monitoringStartedAt: registration.startedAt,
    };
    const readiness = computeReadiness(snapshot);
    const summary = formatBlockersSummary(readiness);

    if (snapshot.state !== "open") {
      yield* end(registration.threadId, "terminal", summary, registration.generation);
      return;
    }
    if (readiness.ready) {
      yield* dispatchUpdate(
        registration.threadId,
        summary,
        snapshot.headSha,
        registration.wakeCount,
      );
      yield* end(registration.threadId, "ready", summary, registration.generation);
      return;
    }

    const diff = diffPullRequestMonitorSnapshot(registration.cursor, snapshot);
    yield* dispatchUpdate(registration.threadId, summary, snapshot.headSha, registration.wakeCount);
    if (diff.actionableEvents.length === 0) return;
    if (registration.wakeCount >= 10) {
      yield* end(registration.threadId, "needs-attention", summary, registration.generation);
      return;
    }
    yield* dispatchWake(
      registration,
      snapshot,
      diff.nextCursor,
      buildWakePrompt({
        prNumber: registration.prNumber,
        wakeCount: registration.wakeCount + 1,
        events: diff.actionableEvents,
        snapshot,
        readiness,
      }),
    );
  });

  const pollOnce = Ref.set(lastPollFailed, false).pipe(
    Effect.andThen(registry.listActive),
    Effect.flatMap((registrations) =>
      Effect.forEach(
        registrations,
        (registration) =>
          pollRegistration(registration).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("pull request monitor poll failed", {
                threadId: registration.threadId,
                cause,
              }).pipe(Effect.andThen(Ref.set(lastPollFailed, true))),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      ),
    ),
  );

  const onEvent = (event: OrchestrationEvent) => {
    const threadId = threadIdOf(event);
    if (threadId === undefined) return Effect.void;
    if (event.type === "thread.archived") {
      return registry.get(threadId).pipe(
        Effect.flatMap((registration) =>
          Option.isNone(registration)
            ? Effect.void
            : end(threadId, "stopped", "", registration.value.generation),
        ),
        Effect.catch((error) =>
          Effect.logWarning("pull request monitor archive teardown failed", {
            threadId,
            error,
          }),
        ),
      );
    }
    if (
      event.type === "thread.deleted" ||
      event.type === "thread.settled" ||
      event.type === "thread.monitor-ended"
    ) {
      return registry
        .remove(threadId)
        .pipe(Effect.andThen(mutateClaim(threadId, () => undefined)), Effect.asVoid);
    }
    if (event.type === "thread.turn-start-requested") {
      // A turn we didn't start won the thread. Drop our claim — and if our
      // wake had already acked the cursor (in-flight), rewind it so the
      // superseded events re-diff next poll instead of being lost (I5).
      return releaseClaim(threadId, (claim) => claim.commandId !== event.commandId);
    }
    if (
      event.type === "thread.activity-appended" &&
      event.payload.activity.kind === "provider.turn.start.failed"
    ) {
      // engine.dispatch succeeded but the provider reactor failed the turn
      // asynchronously — the acked events never reached an agent (I5).
      return releaseClaim(
        threadId,
        (claim) =>
          claim.phase === "in-flight" &&
          claim.dispatchedAt !== undefined &&
          claim.dispatchedAt <= event.payload.activity.createdAt,
      );
    }
    if (event.type === "thread.session-set") {
      const status = event.payload.session.status;
      if (status !== "starting" && status !== "running") {
        return mutateClaim(threadId, (claim) => (claim?.phase === "in-flight" ? undefined : claim));
      }
    }
    return Effect.void;
  };

  const start = Effect.fn("PullRequestMonitor.start")(function* () {
    const shell = yield* snapshots
      .getShellSnapshot()
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("pull request monitor boot reconcile query failed", { error }).pipe(
            Effect.as({ threads: [] as const }),
          ),
        ),
      );
    yield* Effect.forEach(
      shell.threads.filter((thread) => thread.monitor?.status === "monitoring"),
      (thread) =>
        registry.get(thread.id).pipe(
          Effect.flatMap((registration) => {
            if (Option.isSome(registration)) return Effect.void;
            return Effect.gen(function* () {
              const endedAt = DateTime.formatIso(yield* DateTime.now);
              yield* engine.dispatch({
                type: "thread.monitor.end",
                commandId: CommandId.make(`monitor-boot-reconcile:${thread.id}:${endedAt}`),
                threadId: thread.id,
                reason: "session-ended",
                blockersSummary: "",
                endedAt,
              });
            });
          }),
          Effect.catch((error) =>
            Effect.logWarning("pull request monitor boot reconcile failed", {
              threadId: thread.id,
              error,
            }),
          ),
        ),
      { discard: true },
    );
    yield* Effect.forkDetach(Stream.runForEach(engine.streamDomainEvents, onEvent));
    yield* Effect.forkDetach(
      Effect.forever(
        pollOnce.pipe(
          Effect.andThen(Ref.get(lastPollFailed)),
          Effect.flatMap((failed) => Effect.sleep(failed ? MAX_BACKOFF : POLL_INTERVAL)),
        ),
      ),
    );
  });

  return PullRequestMonitor.of({ start, pollOnce, handleDomainEvent: onEvent });
});

export const layer = Layer.effect(PullRequestMonitor, make);
