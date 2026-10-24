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
} from "../sourceControl/threadPullRequests.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
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

import * as GitManager from "../git/GitManager.ts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isTerminalRunStatus } from "./ThreadManagementService.ts";

const SLOW_SYNC_INTERVAL_MS = 15 * 60 * 1_000;
// Every server polls every open linked pull request, and most of them sit untouched for days.
// One nobody has updated for QUIET_AFTER_MS is read on the quiet cadence instead of each sweep;
// requested refreshes, watches and a host CLI's merge command still read it at once.
const QUIET_AFTER_MS = 30 * 60 * 1_000;
const QUIET_SYNC_INTERVAL_MS = 5 * 60 * 1_000;

const isChangeRequestCloseCommand = (command: string) =>
  sourceControlDefinitions.definitions.some(
    (definition) => definition.changeRequestCloseCommand?.test(command) === true,
  );

const isPullRequestProviderError = Schema.is(PullRequestProviderError);

type SnapshotFields = Omit<ThreadPullRequestSnapshot, "syncedAt">;

interface LinkEntry {
  readonly thread: ProjectionStore.ProjectionThreadPullRequests;
  readonly link: ThreadPullRequestLink;
}

/** Another layer of the stack `url` belongs to, in its host's canonical shape. */
function siblingChangeRequestUrl(url: string, number: number): string | null {
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const parsed = sourceControlDefinitions.parseChangeRequestUrl(url);
  if (parsed === null) return null;
  const { definition, link } = parsed;
  return definition.changeRequestUrl({
    host: link.host,
    repository: link.repository,
    number,
    webUrl: link.repositoryUrl,
  });
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

// Hosts compute mergeability lazily and answer unknown while recomputing, so a fresh read must
// not erase a known answer.
function retainKnownMergeability(
  fields: SnapshotFields,
  previous: ThreadPullRequestSnapshot | null,
): SnapshotFields {
  if (fields.mergeability !== "unknown") return fields;
  const known = previous?.mergeability;
  return known === undefined || known === "unknown" ? fields : { ...fields, mergeability: known };
}

// Rotating ghe.com avatar tokens should not make otherwise identical snapshots differ.
function avatarIdentity(avatarUrl: string | null | undefined): string | null {
  if (avatarUrl === null || avatarUrl === undefined) return null;
  const url = URL.parse(avatarUrl);
  if (url === null || (url.hostname !== "ghe.com" && !url.hostname.endsWith(".ghe.com"))) {
    return avatarUrl;
  }
  url.searchParams.delete("token");
  return url.href;
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
    avatarIdentity(left.author?.avatarUrl) === avatarIdentity(right.author?.avatarUrl) &&
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

/** Stack ids are unique only within a repository, e.g. GitHub's fallback to the stack number. */
function nativeStackKeyOf(link: ThreadPullRequestLink, stack: ThreadPullRequestStack): string {
  const key = normalizeThreadPullRequestKey(link);
  return `${key.host}/${key.repository}#stack:${stack.id}`;
}

function sameLayerNumbers(left: ThreadPullRequestStack, right: ThreadPullRequestStack): boolean {
  return (
    left.layers.length === right.layers.length &&
    left.layers.every((layer, index) => layer.number === right.layers[index]!.number)
  );
}

function skipReason(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
}

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
  const git = yield* GitManager.GitManager;
  const crypto = yield* Crypto.Crypto;

  const lastSyncedAt = new Map<string, number>();
  const requested = new Set<string>();
  // Requests arriving during a host read wait for the next sweep.
  const pendingRequests = new Set<string>();
  // PR keys wait in `pendingRequests` for one queued sweep, so a burst of links (an agent
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
    const active = entries.filter((entry) => isUnsettled(entry.thread));
    // A merged snapshot without its merge time cannot settle the thread, so it keeps the slow
    // cadence until the host supplies one (Bitbucket snapshots saved before it was read).
    if (
      active.every(
        (entry) => entry.link.snapshot?.state === "merged" && entry.link.snapshot.mergedAt != null,
      )
    ) {
      return false;
    }
    const last = lastSyncedAt.get(key);
    const sinceLastMs = last === undefined ? Number.POSITIVE_INFINITY : nowMs - last;
    const open = active.filter((entry) => entry.link.snapshot?.state === "open");
    if (open.length > 0) {
      const quiet = open.every((entry) => {
        const updatedAt = entry.link.snapshot?.updatedAt;
        return updatedAt != null && nowMs - Date.parse(updatedAt) >= QUIET_AFTER_MS;
      });
      return !quiet || sinceLastMs >= QUIET_SYNC_INTERVAL_MS;
    }
    return sinceLastMs >= SLOW_SYNC_INTERVAL_MS;
  };

  const logSkipped =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void, E> =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.logWarning(message, fields);

  const sweep = Effect.fn("PullRequestSyncReactor.sweep")(function* (scope: "all" | "requested") {
    const threads = yield* projections.getThreadsWithPullRequests();
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);

    const groups = new Map<string, Array<LinkEntry>>();
    for (const thread of threads) {
      for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
        // Reads depend on the project's checkout and credentials, including their failures.
        const key = `${thread.projectId}\0${threadPullRequestKeyOf(link)}`;
        const entries = groups.get(key) ?? [];
        entries.push({ thread, link });
        groups.set(key, entries);
      }
    }

    // A host-level refresh reaches every project, each retaining its own pending retry.
    for (const [key, entries] of groups) {
      if (pendingRequests.has(threadPullRequestKeyOf(entries[0]!.link))) requested.add(key);
    }
    pendingRequests.clear();

    for (const key of lastSyncedAt.keys()) if (!groups.has(key)) lastSyncedAt.delete(key);
    for (const key of retryStacks) if (!groups.has(key)) retryStacks.delete(key);
    for (const key of requested.keys()) if (!groups.has(key)) requested.delete(key);

    const linkedThisSweep = new Set<string>();
    // Fresh stack reads by group, so a member flagged by a sibling is compared against what the
    // host answered this sweep, not the saved layers that sibling is about to replace.
    const stacksReadThisSweep = new Map<string, ThreadPullRequestStack | null>();
    const persistence = yield* Semaphore.make(1);

    const syncEntry = Effect.fn("PullRequestSyncReactor.syncEntry")(function* (
      entry: LinkEntry,
      readFields: SnapshotFields,
      fetchedStack: { readonly stack: ThreadPullRequestStack | null } | null,
    ) {
      const { thread, link } = entry;
      const fields = retainKnownMergeability(readFields, link.snapshot);
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
        const url = siblingChangeRequestUrl(link.url, layer.number);
        if (url === null) continue;
        const uuid = yield* crypto.randomUUIDv4();
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
        const uuid = yield* crypto.randomUUIDv4();
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
      const refreshRequested = requested.has(key);
      // A held merged summary is served without asking the host, so a snapshot still missing its
      // merge time has to drop it or the slow-cadence re-read would hand back the same gap.
      const missingMergedAt = entries.some(
        (entry) => entry.link.snapshot?.state === "merged" && entry.link.snapshot.mergedAt == null,
      );
      // A stack retry reads past the cache, or it could get back the layer list it is retrying.
      const invalidated = refreshRequested || missingMergedAt || retryStacks.has(key);
      if (invalidated) yield* pullRequests.invalidate({ reference: ref });
      const summary = yield* pullRequests.summary(ref, { recoverTransientFailure: false });
      const fields = snapshotFieldsOf(summary);
      const needsStack =
        refreshRequested ||
        retryStacks.has(key) ||
        entries.some(
          (entry) =>
            entry.link.snapshot === null ||
            !snapshotFieldsEqual(
              entry.link.snapshot,
              retainKnownMergeability(fields, entry.link.snapshot),
            ) ||
            (summary.stack !== undefined &&
              (entry.link.stack?.number ?? null) !== (summary.stack?.number ?? null)),
        );
      const knownUnstacked =
        summary.stack === null && entries.every((entry) => entry.link.stack === null);
      // A sibling can flag this group while its summary read is in flight.
      if (!invalidated && retryStacks.has(key) && !knownUnstacked) {
        yield* pullRequests.invalidate({ reference: ref });
      }
      // The retry this read answers is consumed before the read, not after it: a sibling may
      // flag this group again while the read is in flight, and that flag must survive to the
      // next sweep because the answer below may predate the sibling's layers.
      if (needsStack) retryStacks.delete(key);
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
                    ? Effect.sync(() => retryStacks.add(key)).pipe(
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
        const fetched = fetchedStack.stack;
        stacksReadThisSweep.set(key, fetched);
        // A layer pushed above an older member changes none of that member's own fields, so it
        // would keep its shorter layer list. Members of this stack whose layer list differs read
        // their stack once, in this sweep if still pending or the next; agreeing ones read none.
        // Only groups of the same project: another project reads with its own credential and
        // may see a different layer list, so flagging across projects would never settle.
        if (fetched !== null) {
          const fetchedKey = nativeStackKeyOf(first.link, fetched);
          for (const [siblingKey, siblingEntries] of groups) {
            if (siblingKey === key) continue;
            if (siblingEntries[0]!.thread.projectId !== first.thread.projectId) continue;
            const readThisSweep = stacksReadThisSweep.get(siblingKey);
            const stale = siblingEntries.some(({ link }) => {
              const stack = readThisSweep === undefined ? link.stack : readThisSweep;
              return (
                stack !== null &&
                nativeStackKeyOf(link, stack) === fetchedKey &&
                !sameLayerNumbers(stack, fetched)
              );
            });
            if (stale) retryStacks.add(siblingKey);
          }
        }
      }
      // The host answered, so the cadence clock ticks even if a dispatch below is rejected.
      lastSyncedAt.set(key, nowMs);
      requested.delete(key);
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
    for (const [reason, { count, key }] of skips) {
      yield* Effect.logWarning("pull request sync skipped", { count, key, reason });
    }
  });

  const worker = yield* makeDrainableWorker((scope: "all" | "requested") =>
    Effect.suspend(() => {
      if (scope === "requested") requestedSweepQueued = false;
      return sweep(scope);
    }).pipe(Effect.catchCause(logSkipped("pull request sync sweep failed", {}))),
  );

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
    const stateChanges = Stream.merge(
      yield* pullRequests.subscribeStateChanges,
      yield* git.subscribePullRequestStateChanges,
    );
    yield* forkParked(
      Stream.runForEach(stateChanges, requestSync).pipe(
        Effect.catchCause(logSkipped("pull request state change stream failed", {})),
      ),
    );
    yield* forkParked(
      Stream.runForEach(events, (event) => {
        switch (event.type) {
          case "thread.pull-request-link-updated":
            return event.payload.snapshot === null ? requestSync(event.payload) : Effect.void;
          case "thread.pull-request-synced":
            return Effect.forEach(
              visibleThreadPullRequests(event.payload.pullRequests ?? []).filter(
                (link) => link.snapshot === null,
              ),
              requestSync,
              { discard: true },
            );
          // An agent can merge or close its pull request from a shell with its host's CLI, which
          // sends no merge notification. When a run that ran such a command ends, read the
          // thread's open links fresh, so settlement does not wait for the next sweep and the
          // cached summary. Other runs add no host reads.
          case "turn-item.updated":
            if (
              event.payload.type === "command_execution" &&
              isChangeRequestCloseCommand(event.payload.input)
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
      pendingRequests.add(threadPullRequestKeyOf(key));
      if (requestedSweepQueued) return Effect.void;
      requestedSweepQueued = true;
      return worker.enqueue("requested");
    });

  return { start, drain: worker.drain, requestSync } satisfies PullRequestSyncReactor["Service"];
});

export const layer = Layer.effect(PullRequestSyncReactor, make);
