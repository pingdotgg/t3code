import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import type { DeferredShellSnapshot } from "./shellPullRequests.ts";
import {
  applyShellStreamEvents,
  type ShellStreamEvent,
  mergeShellSnapshotProjects,
  reuseUnchangedThreadShells,
  sameThreadPullRequests,
} from "./shellReducer.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationV2ShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly error: Option.Option<string>;
  /**
   * Changes with each authoritative snapshot (not enrichment refreshes); 0 until the first one.
   * Thread families read for an older generation may miss changes from before the latest snapshot,
   * so they are read again.
   */
  readonly generation: number;
  /** Sequences of the thread removals applied since the latest authoritative snapshot. */
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}

const EMPTY_REMOVALS: ReadonlyMap<ThreadId, number> = new Map();
// Shared by every shell state, so a rebuilt one never reuses a generation another already used.
let lastShellGeneration = 0;

export const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
  generation: 0,
  removedAt: EMPTY_REMOVALS,
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationV2ShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

function withoutDeferredPullRequests(value: DeferredShellSnapshot): OrchestrationV2ShellSnapshot {
  if (value.loadPullRequests === undefined) return value;
  const { loadPullRequests: _deferred, ...snapshot } = value;
  return snapshot;
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

/**
 * Replay does not refresh the older-settled cut and counts, rows that left the newest window, or
 * projections a server rebuilt, so the drift they leave grows with the time since the last server
 * snapshot. Half a day keeps a daily cold start on one HTTP snapshot and a same-day one on replay.
 */
const CACHE_RESUME_MAX_AGE_MILLIS = 12 * 60 * 60 * 1000;

function canResumeFromCache(
  vouch: Persistence.ShellCacheVouch,
  subscription: { readonly omissionKey: string; readonly serverVersion: string | null },
  now: number,
): boolean {
  const age = now - vouch.authoritativeAt;
  return (
    vouch.omissionKey === subscription.omissionKey &&
    vouch.serverVersion === subscription.serverVersion &&
    age >= 0 &&
    age < CACHE_RESUME_MAX_AGE_MILLIS
  );
}

interface LiveShell {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  // Read together with the snapshot so a save never pairs rows with another snapshot's vouch.
  readonly vouch: Persistence.ShellCacheVouch | undefined;
}

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader.ShellSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadShell(environmentId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached environment shell.").pipe(
        Effect.annotateLogs({
          environmentId,
          ...safeErrorLogAttributes(error),
        }),
        Effect.as(Option.none<Persistence.CachedShellSnapshot>()),
      ),
    ),
  );
  const cachedVouch = Option.getOrUndefined(
    Option.flatMap(cached, (value) => Option.fromNullishOr(value.vouch)),
  );
  const cachedShell = Option.map(cached, ({ vouch: _vouch, ...rows }) => rows);
  const cachedSnapshot = Option.map(cachedShell, withoutDeferredPullRequests);
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
  });
  const awaitingCompletion = yield* Ref.make(false);
  // The omission options of the subscription whose snapshot the in-memory
  // shell last came from, or that a cache resume has completed for; null otherwise.
  const authoritativeOmission = yield* Ref.make<string | null>(null);
  const activeSubscription = yield* Ref.make<{
    readonly omissionKey: string;
    readonly serverVersion: string | null;
  } | null>(null);
  // What the in-memory rows descend from: a server snapshot, or a vouched cache plus replay.
  // Resuming from the cache does not renew it; only a server snapshot does.
  const lineageVouch = yield* Ref.make(cachedVouch);
  // The cache's vouch, usable by the first subscription only: a failed or retried resume
  // reloads the HTTP snapshot instead.
  const cacheResumeVouch = yield* Ref.make(cachedVouch);
  // Set while a resume from the cache has not yet reached its completion marker.
  const pendingCacheResume = yield* Ref.make<string | null>(null);
  const latestLive = yield* Ref.make<Option.Option<LiveShell>>(Option.none());
  const persistence = yield* Queue.sliding<OrchestrationV2ShellSnapshot>(1);

  const persistenceLock = yield* Semaphore.make(1);
  let lastPersisted: OrchestrationV2ShellSnapshot | undefined;
  let lastPersistedVouch = cachedVouch;
  // Rows still waiting for their deferred pull request links, which must not be saved:
  // the cache would keep them without links until the next server refresh.
  let pendingLinkRows: ReadonlySet<OrchestrationV2ThreadShell> = new Set();
  const persistLatest = Effect.fn("EnvironmentShellState.persistLatest")(function* (
    flush: boolean,
  ) {
    while (true) {
      const latest = yield* Ref.get(latestLive);
      if (Option.isNone(latest)) return;
      const { snapshot, vouch } = latest.value;
      if (snapshot === lastPersisted && vouch === lastPersistedVouch) return;
      if (snapshot.threads.some((thread) => pendingLinkRows.has(thread))) return;
      if (
        lastPersisted !== undefined &&
        vouch === lastPersistedVouch &&
        snapshot.snapshotSequence >= lastPersisted.snapshotSequence &&
        snapshot.schemaVersion === lastPersisted.schemaVersion &&
        snapshot.projects === lastPersisted.projects &&
        snapshot.threads === lastPersisted.threads &&
        snapshot.archivedThreads === lastPersisted.archivedThreads
      ) {
        // Keep the live cursor without rewriting the rows. Remember it here too so a
        // later authoritative reset to a lower sequence still reaches the cache.
        lastPersisted = snapshot;
        return;
      }
      const saved = yield* cache.saveShell(environmentId, snapshot, vouch).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist environment shell cache.").pipe(
            Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            Effect.as(false),
          ),
        ),
      );
      if (!saved) return;
      lastPersisted = snapshot;
      lastPersistedVouch = vouch;
      if (!flush) return;
    }
  }, persistenceLock.withPermit);
  const persist = () => persistLatest(false);
  const flushLiveShellSnapshot = persistLatest(true);

  // Register before scoped worker fibers so reverse finalizer order interrupts
  // those fibers first and this flush sees a stable latestLiveSnapshot.
  yield* Effect.addFinalizer(() => flushLiveShellSnapshot);

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setDisconnected = Ref.set(awaitingCompletion, false).pipe(
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: shellStatusForSnapshot(current.snapshot),
      })),
    ),
    Effect.andThen(flushLiveShellSnapshot.pipe(Effect.forkScoped)),
    Effect.asVoid,
  );
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setStreamError = (error: unknown) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(Effect.logWarning("Could not synchronize the environment shell.")),
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  // Server items and deferred link fills both read the snapshot and write it back; one at a
  // time, so neither can overwrite what the other wrote in between.
  const snapshotWriteLock = yield* Semaphore.make(1);

  const applyItems = Effect.fn("EnvironmentShellState.applyItems")(function* (
    items: ReadonlyArray<OrchestrationV2ShellStreamItem>,
    pendingLinkIds?: ReadonlySet<ThreadId>,
  ) {
    const initial = yield* SubscriptionRef.get(state);
    let waiting = yield* Ref.get(awaitingCompletion);
    let next = initial;
    let receivedAuthoritativeSnapshot = false;
    let receivedCompletion = false;
    let deltas: Array<ShellStreamEvent> = [];
    const flushDeltas = () => {
      if (deltas.length > 0 && Option.isSome(next.snapshot)) {
        let sequence = next.snapshot.value.snapshotSequence;
        let removedAt: Map<ThreadId, number> | undefined;
        for (const delta of deltas) {
          if (delta.sequence <= sequence) continue;
          switch (delta.kind) {
            case "thread.removed":
              removedAt ??= new Map(next.removedAt);
              removedAt.set(delta.threadId, delta.sequence);
              break;
            case "thread.updated":
            case "project.updated":
            case "project.removed":
              break;
            default:
              continue;
          }
          sequence = delta.sequence;
        }
        next = {
          ...next,
          removedAt: removedAt ?? next.removedAt,
          snapshot: Option.some(applyShellStreamEvents(next.snapshot.value, deltas)),
          status: waiting ? "synchronizing" : "live",
          error: Option.none(),
        };
      }
      deltas = [];
    };
    for (const item of items) {
      if (item.kind !== "snapshot" && item.kind !== "synchronized") {
        deltas.push(item);
        continue;
      }
      // Snapshots can reset the cursor; completion markers change the sync status.
      flushDeltas();
      if (item.kind === "synchronized") {
        waiting = false;
        receivedCompletion = true;
        if (Option.isSome(next.snapshot)) {
          next = { ...next, status: "live", error: Option.none() };
        }
        continue;
      }
      const authoritative = item.resolvedRepositoryIdentityRoots === undefined;
      const nextSnapshot = mergeShellSnapshotProjects(
        Option.getOrNull(next.snapshot),
        item.snapshot,
        item.resolvedRepositoryIdentityRoots === undefined
          ? undefined
          : { resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots },
      );
      // An enrichment refresh only fills in project identities; it vouches for nothing.
      receivedAuthoritativeSnapshot ||= authoritative;
      next = {
        snapshot: Option.some(nextSnapshot),
        status: waiting ? "synchronizing" : "live",
        error: Option.none(),
        generation: authoritative ? ++lastShellGeneration : next.generation,
        removedAt: authoritative ? EMPTY_REMOVALS : next.removedAt,
      };
    }
    flushDeltas();
    yield* Ref.set(awaitingCompletion, waiting);
    if (next === initial) return;
    if (pendingLinkIds !== undefined && Option.isSome(next.snapshot)) {
      pendingLinkRows = new Set(
        next.snapshot.value.threads.filter((thread) => pendingLinkIds.has(thread.id)),
      );
    }
    const previousVouch = yield* Ref.get(lineageVouch);
    let vouch = previousVouch;
    if (receivedAuthoritativeSnapshot) {
      const subscription = yield* Ref.get(activeSubscription);
      vouch =
        subscription?.serverVersion == null
          ? undefined
          : {
              omissionKey: subscription.omissionKey,
              serverVersion: subscription.serverVersion,
              authoritativeAt: yield* Clock.currentTimeMillis,
            };
      yield* Ref.set(lineageVouch, vouch);
      yield* Ref.set(pendingCacheResume, null);
      if (subscription !== null) {
        yield* Ref.set(authoritativeOmission, subscription.omissionKey);
      }
    } else if (receivedCompletion && Option.isSome(next.snapshot)) {
      // The resumed cache has replayed up to the server, so later reconnects resume from memory.
      const resumed = yield* Ref.getAndSet(pendingCacheResume, null);
      if (resumed !== null) {
        yield* Ref.set(authoritativeOmission, resumed);
      }
    }
    if (Option.isSome(next.snapshot)) {
      yield* Ref.set(latestLive, Option.some({ snapshot: next.snapshot.value, vouch }));
    }
    yield* SubscriptionRef.set(state, next);
    if (
      Option.isSome(next.snapshot) &&
      (next.snapshot !== initial.snapshot || vouch !== previousVouch)
    ) {
      yield* Queue.offer(persistence, next.snapshot.value);
    }
  }, snapshotWriteLock.withPermit);

  const stateScope = yield* Effect.scope;
  // Each full snapshot supersedes the previous one's fill; links from an older snapshot must
  // not land on rows a newer snapshot reused.

  let activeFill: Fiber.Fiber<void> | undefined;
  const cancelActiveFill = Effect.suspend(() => {
    const fill = activeFill;
    activeFill = undefined;
    return fill === undefined ? Effect.void : Fiber.interrupt(fill);
  });
  const fillDeferredPullRequests = Effect.fnUntraced(function* (
    source: DeferredShellSnapshot,
    applied: OrchestrationV2ShellSnapshot,
  ) {
    yield* cancelActiveFill;
    if (source.loadPullRequests === undefined) return;
    const arrivedRows = new Set(applied.threads);
    const arrivedIds = new Set(source.threads.map((thread) => thread.id));
    pendingLinkRows = new Set(applied.threads.filter((thread) => arrivedIds.has(thread.id)));
    activeFill = yield* source.loadPullRequests.pipe(
      Effect.flatMap((linksByThreadId) =>
        writeFilledLinks(linksByThreadId, arrivedRows, arrivedIds),
      ),
      Effect.forkIn(stateScope),
    );
  });
  const writeFilledLinks = Effect.fnUntraced(
    function* (
      linksByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<ThreadPullRequestLink>>,
      arrivedRows: ReadonlySet<OrchestrationV2ThreadShell>,
      arrivedIds: ReadonlySet<ThreadId>,
    ) {
      const filled = yield* SubscriptionRef.modify(
        state,
        (current): [Option.Option<OrchestrationV2ShellSnapshot>, EnvironmentShellState] => {
          if (Option.isNone(current.snapshot)) return [Option.none(), current];
          const snapshot = current.snapshot.value;
          let changed = false;
          const threads = snapshot.threads.map((thread) => {
            if (!arrivedRows.has(thread) || !arrivedIds.has(thread.id)) return thread;
            const links = linksByThreadId.get(thread.id);
            if (sameThreadPullRequests(thread.pullRequests, links)) return thread;
            changed = true;
            if (links === undefined) {
              const { pullRequests: _previous, ...row } = thread;
              return row;
            }
            return { ...thread, pullRequests: links };
          });
          if (!changed) return [Option.none(), current];
          const next = { ...snapshot, threads };
          return [Option.some(next), { ...current, snapshot: Option.some(next) }];
        },
      );
      pendingLinkRows = new Set();
      const live = yield* Ref.get(latestLive);
      if (Option.isNone(live)) return;
      const latest = Option.isSome(filled) ? filled.value : live.value.snapshot;
      yield* Ref.set(latestLive, Option.some({ snapshot: latest, vouch: live.value.vouch }));
      yield* Queue.offer(persistence, latest);
    },
    (effect) => snapshotWriteLock.withPermit(effect),
  );
  if (Option.isSome(cachedShell) && Option.isSome(cachedSnapshot)) {
    yield* fillDeferredPullRequests(cachedShell.value, cachedSnapshot.value);
  }

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (session) {
        const { omitIdleSubagents, omitOlderSettled, serverVersion } =
          yield* session.initialConfig.pipe(
            Effect.map((config) => ({
              omitIdleSubagents: config.shellThreadFamilies === true,
              omitOlderSettled:
                config.shellOlderSettled === true && config.shellThreadFamilies === true,
              serverVersion: config.environment.serverVersion as string | null,
            })),
            Effect.orElseSucceed(() => ({
              omitIdleSubagents: false,
              omitOlderSettled: false,
              serverVersion: null,
            })),
          );
        const omissionKey = `${omitIdleSubagents}:${omitOlderSettled}`;
        yield* Ref.set(activeSubscription, { omissionKey, serverVersion });
        yield* Ref.set(pendingCacheResume, null);
        yield* Ref.set(awaitingCompletion, true);
        yield* setSynchronizing;

        // A shell from a server snapshot resumes from its in-memory cursor. Cached data, or a
        // snapshot taken with other omissions, reloads over HTTP so a valid cursor cannot
        // preserve incomplete data; only a matching cache vouch lets the first subscription resume.
        const hasAuthoritativeSnapshot = (yield* Ref.get(authoritativeOmission)) === omissionKey;
        const cacheVouch = yield* Ref.getAndSet(cacheResumeVouch, undefined);
        let canResume = hasAuthoritativeSnapshot;
        let current = yield* SubscriptionRef.get(state);
        const resumesFromCache =
          !hasAuthoritativeSnapshot &&
          cacheVouch !== undefined &&
          Option.isSome(current.snapshot) &&
          canResumeFromCache(
            cacheVouch,
            { omissionKey, serverVersion },
            yield* Clock.currentTimeMillis,
          );
        if (resumesFromCache) {
          canResume = true;
          yield* Ref.set(pendingCacheResume, omissionKey);
        }
        if ((!hasAuthoritativeSnapshot && !resumesFromCache) || Option.isNone(current.snapshot)) {
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          // HTTP and the socket must agree, or omitted children would return through the socket.
          const httpSnapshot = yield* snapshotLoader.load(prepared, {
            omitIdleSubagents,
            omitOlderSettled,
          });
          if (Option.isSome(httpSnapshot)) {
            yield* cancelActiveFill;
            const previous = yield* SubscriptionRef.get(state);
            const snapshot = reuseUnchangedThreadShells(
              Option.getOrNull(previous.snapshot),
              withoutDeferredPullRequests(httpSnapshot.value),
            );
            const pendingLinkIds = new Set(
              httpSnapshot.value.loadPullRequests === undefined
                ? []
                : httpSnapshot.value.threads.map((thread) => thread.id),
            );
            yield* applyItems([{ kind: "snapshot", snapshot }], pendingLinkIds);
            canResume = true;
            current = yield* SubscriptionRef.get(state);
            if (Option.isSome(current.snapshot)) {
              yield* fillDeferredPullRequests(httpSnapshot.value, current.snapshot.value);
            }
          }
        }

        const omission = {
          ...(omitIdleSubagents ? { omitIdleSubagents: true as const } : {}),
          ...(omitOlderSettled ? { omitOlderSettled: true as const } : {}),
        };
        if (!canResume || Option.isNone(current.snapshot)) {
          return { ...omission, requestCompletionMarker: true as const };
        }
        return {
          afterSequence: current.snapshot.value.snapshotSequence,
          ...omission,
          requestCompletionMarker: true as const,
        };
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEachArray((items) => applyItems(items))),
  );
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  return state;
});

function shellStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentShellState().pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly firstError: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  firstError: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.firstError === right.firstError
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let firstError: string | null = null;

    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      firstError,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

/**
 * Every shell push replaces the state, so views that gate on load progress read these
 * primitives instead and stay put while threads stream.
 */
function createEnvironmentShellProgressAtoms(
  stateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>,
) {
  return {
    statusAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => get(stateValueAtom(environmentId)).status).pipe(
        Atom.withLabel(`environment-shell-status:${environmentId}`),
      ),
    ),
    hasSnapshotAtom: Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => Option.isSome(get(stateValueAtom(environmentId)).snapshot)).pipe(
        Atom.withLabel(`environment-shell-has-snapshot:${environmentId}`),
      ),
    ),
  };
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ShellSnapshotLoader.ShellSnapshotLoader
    | R,
    E
  >,
) {
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(shellStateChanges(environmentId), {
      initialValue: EMPTY_SHELL_STATE,
    }),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      AsyncResult.getOrElse(get(stateAtom(environmentId)), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  const { statusAtom, hasSnapshotAtom } = createEnvironmentShellProgressAtoms(stateValueAtom);

  return {
    stateAtom,
    stateValueAtom,
    statusAtom,
    hasSnapshotAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellPullRequests.ts";
export * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
