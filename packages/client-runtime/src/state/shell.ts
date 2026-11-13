import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ExecutionEnvironmentDescriptor,
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
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase, type PreparedConnection } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import { subscribeDynamicWithSession } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
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
 * Replay does not refresh the older-settled cut, rows that left the newest window, or
 * projections the server rebuilt, so drift grows with the age of the last server snapshot.
 */
const CACHE_RESUME_MAX_AGE_MILLIS = 12 * 60 * 60 * 1000;

// How long a ready socket waits for the early HTTP answer before it resumes held rows itself.
// The supervisor's quick probe allows a live host the same time. A proxy that drops `/api`
// without an answer would otherwise hold each connect for the full HTTP timeout.
const EARLY_LOAD_GRACE = "3 seconds";

type ShellOriginIdentity = Omit<Persistence.ShellCacheOrigin, "snapshotAt">;

interface ShellSubscription {
  readonly session: RpcSession;
  /** What a snapshot from this subscription descends from; null when the server did not say. */
  readonly identity: ShellOriginIdentity | null;
}

function shellIdentity(
  environment: Pick<ExecutionEnvironmentDescriptor, "serverVersion" | "databaseMigration">,
  flags: { readonly shellThreadFamilies?: boolean; readonly shellOlderSettled?: boolean },
): ShellOriginIdentity {
  const omitIdleSubagents = flags.shellThreadFamilies === true;
  return {
    serverVersion: environment.serverVersion,
    // Migrations rewrite projections without events, so a migrated server reloads.
    databaseMigration: environment.databaseMigration ?? null,
    omitIdleSubagents,
    omitOlderSettled: flags.shellOlderSettled === true && omitIdleSubagents,
  };
}

function sameConnection(left: PreparedConnection, right: PreparedConnection): boolean {
  const keys = Object.keys({ ...left, ...right }) as Array<keyof PreparedConnection>;
  return keys.every((key) => key === "httpAuthorization" || left[key] === right[key]);
}

/** Null for a server whose descriptor does not name its shell flags; only its config does. */
function descriptorShellIdentity(
  descriptor: ExecutionEnvironmentDescriptor | undefined,
): ShellOriginIdentity | null {
  if (descriptor?.capabilities.shellThreadFamilies === undefined) return null;
  return shellIdentity(descriptor, descriptor.capabilities);
}

function sameShellIdentity(left: ShellOriginIdentity, right: ShellOriginIdentity): boolean {
  return (
    left.serverVersion === right.serverVersion &&
    left.databaseMigration === right.databaseMigration &&
    left.omitIdleSubagents === right.omitIdleSubagents &&
    left.omitOlderSettled === right.omitOlderSettled
  );
}

function canResumeFrom(
  origin: Persistence.ShellCacheOrigin | undefined,
  identity: ShellOriginIdentity | null,
  now: number,
): boolean {
  if (origin === undefined || identity === null) return false;
  const age = now - origin.snapshotAt;
  return sameShellIdentity(origin, identity) && age >= 0 && age < CACHE_RESUME_MAX_AGE_MILLIS;
}

type HttpShellOutcome =
  | { readonly kind: "snapshot"; readonly projectIdentities: string | undefined }
  /** The server can replay from the rows the client holds. */
  | { readonly kind: "resumable" }
  | { readonly kind: "failed" };

interface EarlyShellLoad {
  readonly prepared: PreparedConnection;
  readonly identity: ShellOriginIdentity;
  readonly fiber: Fiber.Fiber<HttpShellOutcome>;
  // One subscription uses a load; a later one on the same connection decides again.
  readonly claimed: boolean;
}

interface LiveShell {
  readonly snapshot: OrchestrationV2ShellSnapshot;
  // Read together with the rows, so a save never pairs them with another snapshot's origin.
  readonly origin: Persistence.ShellCacheOrigin | undefined;
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
  const cachedOrigin = Option.isSome(cached) ? cached.value.origin : undefined;
  const cachedSnapshot = Option.map(cached, ({ origin: _origin, ...rows }) =>
    withoutDeferredPullRequests(rows),
  );
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
  });
  const awaitingCompletion = yield* Ref.make(false);
  const activeSubscription = yield* Ref.make<ShellSubscription | null>(null);
  // The server snapshot the in-memory rows descend from, directly or through the cache.
  // Only a server snapshot renews it; `snapshot-required` drops it.
  const origin = yield* Ref.make(cachedOrigin);
  const reloadRequests = yield* Queue.unbounded<void>();
  const latestLive = yield* Ref.make<Option.Option<LiveShell>>(Option.none());
  const persistence = yield* Queue.sliding<OrchestrationV2ShellSnapshot>(1);

  const persistenceLock = yield* Semaphore.make(1);
  let lastPersisted: LiveShell | undefined;
  // Rows still waiting for their deferred pull request links, which must not be saved:
  // the cache would keep them without links until the next server refresh.
  let pendingLinkRows: ReadonlySet<OrchestrationV2ThreadShell> = new Set();
  const persistLatest = Effect.fn("EnvironmentShellState.persistLatest")(function* (
    flush: boolean,
  ) {
    while (true) {
      const latest = yield* Ref.get(latestLive);
      if (Option.isNone(latest) || latest.value === lastPersisted) return;
      const { snapshot, origin } = latest.value;
      if (snapshot.threads.some((thread) => pendingLinkRows.has(thread))) return;
      if (
        lastPersisted !== undefined &&
        origin === lastPersisted.origin &&
        snapshot.snapshotSequence >= lastPersisted.snapshot.snapshotSequence &&
        snapshot.schemaVersion === lastPersisted.snapshot.schemaVersion &&
        snapshot.projects === lastPersisted.snapshot.projects &&
        snapshot.threads === lastPersisted.snapshot.threads &&
        snapshot.archivedThreads === lastPersisted.snapshot.archivedThreads
      ) {
        // Keep the live cursor without rewriting the rows. Remember it here too so a
        // later authoritative reset to a lower sequence still reaches the cache.
        lastPersisted = latest.value;
        return;
      }
      const saved = yield* cache.saveShell(environmentId, snapshot, origin).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist environment shell cache.").pipe(
            Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            Effect.as(false),
          ),
        ),
      );
      if (!saved) return;
      lastPersisted = latest.value;
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

  const applyLocked = Effect.fnUntraced(function* (
    items: ReadonlyArray<OrchestrationV2ShellStreamItem>,
    /** What an authoritative snapshot among the items descends from. */
    identity: ShellOriginIdentity | null,
    /** Set for an HTTP snapshot: the rows that still wait for their pull request links. */
    pendingLinkIds?: ReadonlySet<ThreadId>,
  ) {
    const initial = yield* SubscriptionRef.get(state);
    // No socket has confirmed an HTTP snapshot, so it never makes the shell live.
    const fromHttp = pendingLinkIds !== undefined;
    const disconnected = initial.status === "empty" || initial.status === "cached";
    let waiting = yield* Ref.get(awaitingCompletion);
    let next = initial;
    let receivedAuthoritativeSnapshot = false;
    let snapshotRequired = false;
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
      if (item.kind === "snapshot-required") {
        snapshotRequired = true;
        continue;
      }
      if (item.kind !== "snapshot" && item.kind !== "synchronized") {
        deltas.push(item);
        continue;
      }
      // Snapshots can reset the cursor; completion markers change the sync status.
      flushDeltas();
      if (item.kind === "synchronized") {
        waiting = false;
        if (Option.isSome(next.snapshot)) {
          next = {
            ...next,
            status: "live",
            error: Option.none(),
            // A cache resume that caught up is as current as a snapshot for generation readers.
            generation: next.generation === 0 ? ++lastShellGeneration : next.generation,
          };
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
      if (authoritative) receivedAuthoritativeSnapshot = true;
      next = {
        snapshot: Option.some(nextSnapshot),
        status:
          fromHttp && disconnected ? "cached" : waiting || fromHttp ? "synchronizing" : "live",
        error: Option.none(),
        generation: authoritative ? ++lastShellGeneration : next.generation,
        removedAt: authoritative ? EMPTY_REMOVALS : next.removedAt,
      };
    }
    flushDeltas();
    yield* Ref.set(awaitingCompletion, waiting);
    let nextOrigin = yield* Ref.get(origin);
    if (snapshotRequired) {
      // The rows stay on screen but reload before the next resume; the cache keeps the old
      // origin until that reload saves, which costs at most one more refusal.
      nextOrigin = undefined;
      yield* Ref.set(origin, nextOrigin);
      yield* Queue.offer(reloadRequests, undefined);
    } else if (receivedAuthoritativeSnapshot) {
      nextOrigin =
        identity === null ? undefined : { ...identity, snapshotAt: yield* Clock.currentTimeMillis };
      yield* Ref.set(origin, nextOrigin);
    }
    if (next === initial) return;
    if (pendingLinkIds !== undefined && Option.isSome(next.snapshot)) {
      pendingLinkRows = new Set(
        next.snapshot.value.threads.filter((thread) => pendingLinkIds.has(thread.id)),
      );
    }
    if (Option.isSome(next.snapshot)) {
      yield* Ref.set(
        latestLive,
        Option.some({ snapshot: next.snapshot.value, origin: nextOrigin }),
      );
    }
    yield* SubscriptionRef.set(state, next);
    if (next.snapshot !== initial.snapshot && Option.isSome(next.snapshot)) {
      yield* Queue.offer(persistence, next.snapshot.value);
    }
  });

  const applyItems = Effect.fn("EnvironmentShellState.applyItems")(function* (
    entries: ReadonlyArray<readonly [RpcSession, OrchestrationV2ShellStreamItem]>,
  ) {
    // Read under the lock: items buffered across a session change must not land on the
    // rows the next session loaded.
    const subscription = yield* Ref.get(activeSubscription);
    yield* applyLocked(
      entries.flatMap(([session, item]) => (session === subscription?.session ? [item] : [])),
      subscription?.identity ?? null,
    );
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
      yield* Ref.set(latestLive, Option.some({ snapshot: latest, origin: live.value.origin }));
      yield* Queue.offer(persistence, latest);
    },
    (effect) => snapshotWriteLock.withPermit(effect),
  );
  if (Option.isSome(cached) && Option.isSome(cachedSnapshot)) {
    yield* fillDeferredPullRequests(cached.value, cachedSnapshot.value);
  }

  const applyHttpSnapshot = Effect.fnUntraced(function* (
    loaded: ShellSnapshotLoader.ShellHttpSnapshot,
    identity: ShellOriginIdentity | null,
  ) {
    const { projectIdentities: _identities, ...deferred } = loaded;
    yield* cancelActiveFill;
    const previous = yield* SubscriptionRef.get(state);
    const snapshot = reuseUnchangedThreadShells(
      Option.getOrNull(previous.snapshot),
      withoutDeferredPullRequests(deferred),
    );
    const pendingLinkIds = new Set(
      deferred.loadPullRequests === undefined ? [] : deferred.threads.map((thread) => thread.id),
    );
    yield* snapshotWriteLock.withPermit(
      applyLocked([{ kind: "snapshot", snapshot }], identity, pendingLinkIds),
    );
    const current = yield* SubscriptionRef.get(state);
    if (Option.isSome(current.snapshot)) {
      yield* fillDeferredPullRequests(deferred, current.snapshot.value);
    }
  }, Effect.uninterruptible);

  /**
   * One request to the HTTP shell route. Held rows that may resume are named, so the server
   * answers that they still can, in a few bytes, or sends the snapshot that replaces them.
   */
  const loadOverHttp = Effect.fn("EnvironmentShellState.loadOverHttp")(function* (
    prepared: PreparedConnection,
    identity: ShellOriginIdentity | null,
  ) {
    const held = yield* SubscriptionRef.get(state);
    const resumeFrom =
      Option.isSome(held.snapshot) &&
      canResumeFrom(yield* Ref.get(origin), identity, yield* Clock.currentTimeMillis)
        ? held.snapshot.value.snapshotSequence
        : undefined;
    // HTTP and the socket must agree, or omitted children would return through the socket.
    const answer = yield* snapshotLoader.load(prepared, {
      omitIdleSubagents: identity?.omitIdleSubagents === true,
      omitOlderSettled: identity?.omitOlderSettled === true,
      ...(resumeFrom === undefined ? {} : { resumeFrom }),
    });
    if (Option.isNone(answer)) return { kind: "failed" } satisfies HttpShellOutcome;
    if ("resumable" in answer.value) return { kind: "resumable" } satisfies HttpShellOutcome;
    yield* applyHttpSnapshot(answer.value, identity);
    return {
      kind: "snapshot",
      projectIdentities: answer.value.projectIdentities,
    } satisfies HttpShellOutcome;
  });

  // A server whose descriptor names its shell flags is asked for the shell as soon as the
  // connection is prepared, while the socket opens and the config downloads. The subscription
  // claims that load, and reloads when the live config disagrees with the descriptor.
  const earlyLoad = yield* SynchronizedRef.make<EarlyShellLoad | null>(null);
  const useEarlyLoad = (prepared: PreparedConnection | null, claim: boolean) =>
    SynchronizedRef.modifyEffect(
      earlyLoad,
      Effect.fnUntraced(function* (current) {
        // A rotated credential replaces the prepared connection of a session that stays up.
        if (current !== null && prepared !== null && sameConnection(current.prepared, prepared)) {
          const next = { ...current, prepared, claimed: current.claimed || claim };
          // A claimed load that still runs is handed out again. A second request could
          // answer first, and this one would then replace its rows under a passed cursor.
          const done = current.fiber.pollUnsafe() !== undefined;
          return [current.claimed && done ? null : current, next] as const;
        }
        if (current !== null) yield* Fiber.interrupt(current.fiber);
        const identity = descriptorShellIdentity(prepared?.descriptor);
        if (prepared === null || identity === null) return [null, null] as const;
        // Items a closed session still has in flight must not land on the rows this loads.
        yield* Ref.set(activeSubscription, null);
        const fiber = yield* loadOverHttp(prepared, identity).pipe(Effect.forkIn(stateScope));
        const next: EarlyShellLoad = { prepared, identity, fiber, claimed: claim };
        return [next, next] as const;
      }),
    ).pipe(
      // Covers the store too. A cancel that lands during the wait above would otherwise take
      // effect before the store, and the load just started would run on with no record.
      Effect.uninterruptible,
    );
  /**
   * The subscription waits for the early load, so its answer is applied before the socket
   * moves the rows on. Held rows that can resume wait a limited time only: after that the
   * load is ended, so a late answer applies nothing, and the socket resumes them.
   */
  const awaitEarlyLoad = Effect.fnUntraced(function* (
    early: EarlyShellLoad,
    identity: ShellOriginIdentity | null,
  ) {
    const resumable =
      Option.isSome((yield* SubscriptionRef.get(state)).snapshot) &&
      canResumeFrom(yield* Ref.get(origin), identity, yield* Clock.currentTimeMillis);
    if (!resumable) return yield* Fiber.await(early.fiber);
    const answered = yield* Fiber.await(early.fiber).pipe(Effect.timeoutOption(EARLY_LOAD_GRACE));
    if (Option.isSome(answered)) return answered.value;
    // Returns after an answer that is being applied has finished, so the cursor below is read
    // from rows that no longer change under it.
    yield* Fiber.interrupt(early.fiber);
    return yield* Fiber.await(early.fiber);
  });

  yield* SubscriptionRef.changes(supervisor.prepared).pipe(
    // Reads the connection of this moment: a change handled late must not start a load for a
    // connection that ended, which would also drop the items of the session that replaced it.
    Stream.runForEach(() =>
      SubscriptionRef.get(supervisor.prepared).pipe(
        Effect.flatMap((prepared) => useEarlyLoad(Option.getOrNull(prepared), false)),
      ),
    ),
    Effect.forkScoped,
  );

  const resubscriptions = Stream.merge(
    Stream.fromQueue(reloadRequests),
    Option.match(wakeups, {
      onNone: () => Stream.never,
      onSome: (service) =>
        service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
    }),
  );

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamicWithSession(
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (session) {
        const identity = yield* session.initialConfig.pipe(
          Effect.map((config) => shellIdentity(config.environment, config)),
          Effect.orElseSucceed(() => null),
        );
        const { omitIdleSubagents, omitOlderSettled } = identity ?? {
          omitIdleSubagents: false,
          omitOlderSettled: false,
        };
        const early = yield* useEarlyLoad(
          Option.getOrNull(yield* SubscriptionRef.get(supervisor.prepared)),
          true,
        );
        const earlyExit = early === null ? null : yield* awaitEarlyLoad(early, identity);
        // Rows the descriptor's flags or build loaded are not kept when the live config differs:
        // their origin then cannot resume, so the load below replaces them.
        let loaded =
          early !== null &&
          earlyExit !== null &&
          Exit.isSuccess(earlyExit) &&
          identity !== null &&
          sameShellIdentity(early.identity, identity)
            ? earlyExit.value
            : null;
        yield* Ref.set(activeSubscription, { session, identity });
        yield* Ref.set(awaitingCompletion, true);
        yield* setSynchronizing;

        // Rows from a recent server snapshot with the same omissions and server build resume
        // from their cursor, in memory or from the cache. Anything else reloads the HTTP
        // snapshot so a valid cursor cannot preserve stale or incomplete data. A `resumable`
        // answer is checked again too: the rows can pass their age limit while the socket opens.
        const resumingHeldRows =
          loaded?.kind !== "snapshot" &&
          Option.isSome((yield* SubscriptionRef.get(state)).snapshot) &&
          canResumeFrom(yield* Ref.get(origin), identity, yield* Clock.currentTimeMillis);
        if (!resumingHeldRows && loaded === null) {
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
          loaded = yield* loadOverHttp(prepared, identity);
        }

        const current = yield* SubscriptionRef.get(state);
        const omission = {
          ...(omitIdleSubagents ? { omitIdleSubagents: true as const } : {}),
          ...(omitOlderSettled ? { omitOlderSettled: true as const } : {}),
        };
        if (Option.isNone(current.snapshot) || !(resumingHeldRows || loaded?.kind === "snapshot")) {
          return { ...omission, requestCompletionMarker: true as const };
        }
        return {
          afterSequence: current.snapshot.value.snapshotSequence,
          // Only rows the client already held may be refused; a cursor from the snapshot just
          // loaded falls back to the socket snapshot, so a refusal cannot loop.
          ...(resumingHeldRows ? { httpSnapshotFallback: true as const } : {}),
          // No stream item has touched the snapshot just loaded, so its identities still hold.
          ...(loaded?.kind === "snapshot" && loaded.projectIdentities !== undefined
            ? { knownProjectIdentities: loaded.projectIdentities }
            : {}),
          ...omission,
          requestCompletionMarker: true as const,
        };
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: resubscriptions,
      },
    ).pipe(Stream.runForEachArray((entries) => applyItems(entries))),
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
export * from "./steadyShells.ts";
