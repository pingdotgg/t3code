import { siblingPullRequestUrl } from "@t3tools/shared/changeRequestUrl";
import {
  CommandId,
  type PullRequestSummary,
  type ThreadId,
  type ThreadPullRequestKey,
  type ThreadPullRequestLink,
  type ThreadPullRequestSnapshot,
  type ThreadPullRequestStack,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  threadPullRequestKeyOf,
  normalizeThreadPullRequestKey,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { PullRequestProviderError } from "../pullRequest/PullRequestProvider.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isTerminalRunStatus } from "./ThreadManagementService.ts";

const SLOW_SYNC_INTERVAL_MS = 15 * 60 * 1_000;
/** Shell commands that can merge or close a pull request without a merge notification. */
const PULL_REQUEST_CLOSE_COMMAND = /\b(?:gh\s+pr|glab\s+mr)\s+(?:merge|close)\b/u;

const isPullRequestProviderError = Schema.is(PullRequestProviderError);

type SnapshotFields = Omit<ThreadPullRequestSnapshot, "syncedAt">;

interface LinkEntry {
  readonly thread: ProjectionStore.ProjectionThreadPullRequests;
  readonly link: ThreadPullRequestLink;
}

function snapshotFieldsOf(summary: PullRequestSummary): SnapshotFields {
  return {
    state: summary.state,
    title: summary.title,
    headBranch: summary.headBranch,
    baseBranch: summary.baseBranch,
    isDraft: summary.isDraft ?? false,
    updatedAt: summary.updatedAt,
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    ...(summary.author === undefined ? {} : { author: summary.author }),
    ...(summary.additions === undefined ? {} : { additions: summary.additions }),
    ...(summary.deletions === undefined ? {} : { deletions: summary.deletions }),
    ...(summary.changedFiles === undefined ? {} : { changedFiles: summary.changedFiles }),
    ...(summary.reviewDecision === undefined ? {} : { reviewDecision: summary.reviewDecision }),
    ...(summary.checksState === undefined ? {} : { checksState: summary.checksState }),
    ...(summary.mergeability === undefined ? {} : { mergeability: summary.mergeability }),
  };
}

function snapshotFieldsEqual(left: SnapshotFields, right: SnapshotFields): boolean {
  return (
    left.state === right.state &&
    left.title === right.title &&
    left.headBranch === right.headBranch &&
    left.baseBranch === right.baseBranch &&
    left.isDraft === right.isDraft &&
    left.updatedAt === right.updatedAt &&
    (left.closedAt ?? null) === (right.closedAt ?? null) &&
    (left.mergedAt ?? null) === (right.mergedAt ?? null) &&
    (left.author?.login ?? null) === (right.author?.login ?? null) &&
    (left.author?.avatarUrl ?? null) === (right.author?.avatarUrl ?? null) &&
    left.additions === right.additions &&
    left.deletions === right.deletions &&
    left.changedFiles === right.changedFiles &&
    (left.reviewDecision ?? null) === (right.reviewDecision ?? null) &&
    (left.checksState ?? null) === (right.checksState ?? null) &&
    left.mergeability === right.mergeability
  );
}

function stacksEqual(
  left: ThreadPullRequestStack | null,
  right: ThreadPullRequestStack | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.number === right.number &&
    left.url === right.url &&
    left.base === right.base &&
    left.layers.length === right.layers.length &&
    left.layers.every((layer, index) => {
      const other = right.layers[index]!;
      return (
        layer.number === other.number &&
        layer.headBranch === other.headBranch &&
        layer.state === other.state
      );
    })
  );
}

function skipReason(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}

/** When a host read failed because the host is rate limited, the time that pause ends. */
function rateLimitRetryAt(cause: Cause.Cause<unknown>): number | undefined {
  let error: unknown = Cause.squash(cause);
  while (error instanceof Error) {
    if (isPullRequestProviderError(error) && error.reason === "rate-limited") return error.retryAt;
    error = error.cause;
  }
  return undefined;
}

function isUnsettled(thread: ProjectionStore.ProjectionThreadPullRequests): boolean {
  return thread.settledOverride !== "settled" && thread.settledAt === null;
}

/**
 * Keeps every thread ↔ pull request link's host snapshot current. One sweep a minute reads
 * only the active threads that have links, groups visible links by pull request so the host
 * is asked once per PR no matter how many threads share it, and writes back only what
 * changed. Native stacks the host reports are auto-linked to the thread as `source: "stack"`.
 */
export class PullRequestSyncReactor extends Context.Service<
  PullRequestSyncReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    /**
     * Force the next sweep to re-read this pull request, even when its snapshot is terminal.
     * While its host is rate limited, the read waits for the first sweep after the pause.
     */
    readonly requestSync: (key: ThreadPullRequestKey) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/PullRequestSyncReactor") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;

  const lastSyncedAt = new Map<string, number>();
  const requested = new Map<string, number>();
  let requestGeneration = 0;
  // Requested keys wait in `requested` for one queued sweep, so a burst of links (an agent
  // linking dozens of pull requests) is read together and shares the summary batches.
  let requestedSweepQueued = false;
  const retryStacks = new Set<string>();
  // Rate limit pauses by project and host, since each project reads with its own credential.
  // A paused host refuses every read without asking it, so the sweep leaves its pull requests
  // due until the pause ends rather than failing each of them every minute.
  const pausedUntil = new Map<string, number>();

  const isDue = (key: string, entries: ReadonlyArray<LinkEntry>, nowMs: number): boolean => {
    if (requested.has(key) || retryStacks.has(key)) return true;
    if (entries.some((entry) => entry.link.snapshot === null)) return true;
    // Settled threads stop watching their pull requests. Unsettling one makes its links due on
    // the next sweep, since the cadence clock below kept running while it was settled.
    const active = entries.filter((entry) => isUnsettled(entry.thread));
    if (active.every((entry) => entry.link.snapshot?.state === "merged")) return false;
    if (active.some((entry) => entry.link.snapshot?.state === "open")) return true;
    // Closed requests can reopen on the host.
    const last = lastSyncedAt.get(key);
    return last === undefined || nowMs - last >= SLOW_SYNC_INTERVAL_MS;
  };

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  /** `requested` reads only keys asked for through `requestSync`; `all` is the periodic pass. */
  const sweep = Effect.fn("PullRequestSyncReactor.sweep")(function* (scope: "all" | "requested") {
    const threads = yield* projections.getThreadsWithPullRequests();
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);

    const groups = new Map<string, Array<LinkEntry>>();
    for (const thread of threads) {
      for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
        const key = threadPullRequestKeyOf(link);
        const entries = groups.get(key) ?? [];
        entries.push({ thread, link });
        groups.set(key, entries);
      }
    }

    for (const key of lastSyncedAt.keys()) if (!groups.has(key)) lastSyncedAt.delete(key);
    for (const key of retryStacks) if (!groups.has(key)) retryStacks.delete(key);
    for (const key of requested.keys()) if (!groups.has(key)) requested.delete(key);

    // Layers auto-linked this sweep, so two links of one thread that share a
    // stack do not both try to add the same sibling.
    const linkedThisSweep = new Set<string>();
    const persistence = yield* Semaphore.make(1);

    const syncEntry = Effect.fn("PullRequestSyncReactor.syncEntry")(function* (
      entry: LinkEntry,
      fields: SnapshotFields,
      fetchedStack: { readonly stack: ThreadPullRequestStack | null } | null,
    ) {
      const { thread, link } = entry;
      const nextStack = fetchedStack === null ? link.stack : fetchedStack.stack;
      const changed =
        link.snapshot === null ||
        !snapshotFieldsEqual(link.snapshot, fields) ||
        !stacksEqual(link.stack, nextStack);
      // Persist discovered siblings before a terminal snapshot can trigger settlement. A settled
      // thread that shares this pull request with an active one takes the fresh snapshot, but
      // gains no links.
      for (const layer of isUnsettled(thread) ? (fetchedStack?.stack?.layers ?? []) : []) {
        const layerKey = {
          host: normalizeThreadPullRequestKey(link).host,
          repository: link.repository,
          number: layer.number,
        };
        const dedupeKey = `${thread.id}:${threadPullRequestKeyOf(layerKey)}`;
        if (linkedThisSweep.has(dedupeKey)) continue;
        // Tombstones count as present: a dismissed layer is never re-added.
        if (
          (thread.pullRequests ?? []).some((existing) =>
            threadPullRequestKeysEqual(existing, layerKey),
          )
        ) {
          continue;
        }
        const url = siblingPullRequestUrl(link.url, layer.number);
        if (url === null) continue;
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.pull-request.link",
          commandId: CommandId.make(`server:pr-stack-link:${thread.id}:${uuid}`),
          threadId: thread.id,
          ...layerKey,
          url,
          source: "stack",
        });
        linkedThisSweep.add(dedupeKey);
      }
      if (changed) {
        const uuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.pull-request-link.sync",
          commandId: CommandId.make(`server:pr-sync:${thread.id}:${uuid}`),
          threadId: thread.id,
          host: normalizeThreadPullRequestKey(link).host,
          repository: link.repository,
          number: link.number,
          snapshot: { ...fields, syncedAt: nowIso },
          stack: nextStack,
        });
      }
    });

    const syncGroup = Effect.fn("PullRequestSyncReactor.syncGroup")(function* (
      key: string,
      entries: ReadonlyArray<LinkEntry>,
    ) {
      const first = entries[0]!;
      const ref = {
        projectId: first.thread.projectId,
        host: normalizeThreadPullRequestKey(first.link).host,
        repository: first.link.repository,
        number: first.link.number,
      };
      const generation = requested.get(key);
      if (generation !== undefined) yield* pullRequests.invalidate({ reference: ref });
      const summary = yield* pullRequests.summary(ref, { recoverTransientFailure: false });
      const fields = snapshotFieldsOf(summary);
      const needsStack =
        generation !== undefined ||
        retryStacks.has(key) ||
        entries.some(
          (entry) =>
            entry.link.snapshot === null ||
            !snapshotFieldsEqual(entry.link.snapshot, fields) ||
            (summary.stack !== undefined &&
              (entry.link.stack?.number ?? null) !== (summary.stack?.number ?? null)),
        );
      // A summary that says the pull request is in no stack, for links that hold none, already
      // answers what the stack read would.
      const knownUnstacked =
        summary.stack === null && entries.every((entry) => entry.link.stack === null);
      const fetchedStack = !needsStack
        ? null
        : knownUnstacked
          ? { stack: null }
          : yield* pullRequests.stack(ref, { includeDetails: false }).pipe(
              Effect.map((stack) => ({
                stack: stack === null ? null : ({ kind: "native", ...stack } as const),
              })),
              Effect.catchCauseIf(
                (cause) => !Cause.hasInterruptsOnly(cause),
                (cause) =>
                  rateLimitRetryAt(cause) !== undefined
                    ? // The sweep records the pause and holds the host's other reads until it ends.
                      Effect.sync(() => retryStacks.add(key)).pipe(
                        Effect.andThen(Effect.failCause(cause)),
                      )
                    : Effect.logWarning("pull request stack lookup failed", {
                        key,
                      }).pipe(Effect.as(null)),
              ),
            );
      if (needsStack) {
        if (fetchedStack === null) {
          retryStacks.add(key);
          return;
        }
        retryStacks.delete(key);
      }
      // The host answered, so the cadence clock ticks even if a dispatch below is rejected.
      lastSyncedAt.set(key, nowMs);
      // A refresh requested while the host read was in flight belongs to the next sweep.
      if (requested.get(key) === generation) requested.delete(key);
      yield* Effect.forEach(
        entries,
        (entry) =>
          syncEntry(entry, fields, fetchedStack).pipe(
            persistence.withPermits(1),
            Effect.catchCause((cause) => {
              if (!Cause.hasInterruptsOnly(cause)) retryStacks.add(key);
              return logSkipped("pull request sync skipped", { threadId: entry.thread.id, key })(
                cause,
              );
            }),
          ),
        { discard: true },
      );
    });

    // Failed host reads by reason: how many, and the first key that failed that way.
    const skips = new Map<string, { count: number; readonly key: string }>();
    const readGroup = (key: string, entries: ReadonlyArray<LinkEntry>, pauseKey: string) =>
      syncGroup(key, entries).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          const retryAt = rateLimitRetryAt(cause);
          if (retryAt !== undefined) {
            pausedUntil.set(pauseKey, Math.max(retryAt, pausedUntil.get(pauseKey) ?? 0));
          }
          const reason = skipReason(cause);
          const skip = skips.get(reason);
          if (skip === undefined) skips.set(reason, { count: 1, key });
          else skip.count += 1;
          return Effect.void;
        }),
      );
    yield* Effect.forEach(
      groups,
      ([key, entries]) => {
        if (!((scope === "all" || requested.has(key)) && isDue(key, entries, nowMs))) {
          return Effect.void;
        }
        const first = entries[0]!;
        const pauseKey = `${first.thread.projectId}\0${normalizeThreadPullRequestKey(first.link).host}`;
        // Checked against the clock as each read starts, so a pause found earlier in this sweep
        // holds the rest, and one that ends during the sweep lets the rest through.
        return Clock.currentTimeMillis.pipe(
          Effect.flatMap((startedAtMs) =>
            (pausedUntil.get(pauseKey) ?? 0) > startedAtMs
              ? Effect.void
              : readGroup(key, entries, pauseKey),
          ),
        );
      },
      // As wide as one batched summary read, so the sweep's reads on a host arrive together and
      // GitHub answers them in one request rather than one `gh pr view` apiece.
      { concurrency: 25, discard: true },
    );
    // A host failure such as a signed-out CLI fails every due pull request the same way, so a
    // sweep reports one line per reason rather than one per pull request.
    for (const [reason, { count, key }] of skips) {
      yield* Effect.logWarning("pull request sync skipped", { count, key, reason });
    }
  });

  const worker = yield* makeDrainableWorker((scope: "all" | "requested") =>
    Effect.suspend(() => {
      // Requests from here on queue another sweep; the ones already recorded are read by this.
      if (scope === "requested") requestedSweepQueued = false;
      return sweep(scope);
    }).pipe(Effect.catchCause(logSkipped("pull request sync sweep failed", {}))),
  );

  // Threads whose current run ran a merge or close command, until that run ends.
  const closeCommandThreads = new Set<ThreadId>();
  const refreshOpenLinks = (threadId: ThreadId) =>
    projections.getThreadsWithPullRequests(threadId).pipe(
      Effect.flatMap((threads) =>
        Effect.forEach(
          threads.flatMap((thread) =>
            visibleThreadPullRequests(thread.pullRequests ?? []).filter(
              (link) => link.snapshot?.state === "open",
            ),
          ),
          requestSync,
          { discard: true },
        ),
      ),
      Effect.catchCause(logSkipped("pull request refresh after run skipped", { threadId })),
    );

  const start: PullRequestSyncReactor["Service"]["start"] = Effect.fn(
    "PullRequestSyncReactor.start",
  )(function* () {
    const events = engine.streamDomainEvents;
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        switch (event.type) {
          case "thread.pull-request-synced":
            return Effect.forEach(
              visibleThreadPullRequests(event.payload.pullRequests ?? []).filter(
                (link) => link.snapshot === null,
              ),
              requestSync,
              { discard: true },
            );
          // An agent can merge or close its pull request from a shell (`gh pr merge`), which
          // sends no merge notification. When a run that ran such a command ends, read the
          // thread's open links fresh, so settlement does not wait for the next sweep and the
          // cached summary. Other runs add no host reads.
          case "turn-item.updated":
            if (
              event.payload.type === "command_execution" &&
              PULL_REQUEST_CLOSE_COMMAND.test(event.payload.input)
            ) {
              closeCommandThreads.add(event.threadId);
            }
            return Effect.void;
          case "run.updated":
            return isTerminalRunStatus(event.payload.status) &&
              closeCommandThreads.delete(event.threadId)
              ? refreshOpenLinks(event.threadId)
              : Effect.void;
          default:
            return Effect.void;
        }
      }).pipe(Effect.catchCause(logSkipped("pull request sync event stream failed", {}))),
    );
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue("all");
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  const requestSync: PullRequestSyncReactor["Service"]["requestSync"] = (key) =>
    Effect.suspend(() => {
      requested.set(threadPullRequestKeyOf(key), ++requestGeneration);
      if (requestedSweepQueued) return Effect.void;
      requestedSweepQueued = true;
      return worker.enqueue("requested");
    });

  return { start, drain: worker.drain, requestSync } satisfies PullRequestSyncReactor["Service"];
});

export const layer = Layer.effect(PullRequestSyncReactor, make);
