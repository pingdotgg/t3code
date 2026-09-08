import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { RpcClientError } from "effect/unstable/rpc";
import { Socket } from "effect/unstable/socket";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { ConnectionWakeups, type ConnectionWakeup } from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentThreadDetailAtoms } from "./threadDetail.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import type { ThreadSnapshotWindow } from "./threadSnapshotHttp.ts";
import {
  createEnvironmentThreadStateAtoms,
  makeEnvironmentThreadState,
  requestOlderThreadTurns,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = ThreadId.make("thread-1");
const THREAD: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "ModelA" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const SNAPSHOT: OrchestrationThreadDetailSnapshot = { snapshotSequence: 7, thread: THREAD };

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const makeHarness = Effect.fn("TestThreadAtoms.makeHarness")(function* (options?: {
  readonly snapshot?: OrchestrationThreadDetailSnapshot;
  readonly connected?: boolean;
  readonly httpNone?: boolean;
  readonly initialLoad?: Effect.Effect<Option.Option<OrchestrationThreadDetailSnapshot>>;
  readonly stream?: Stream.Stream<OrchestrationThreadStreamItem, Error>;
}) {
  const clock = yield* Clock.Clock;
  const wakeups = yield* Queue.unbounded<ConnectionWakeup>();
  const subscriptions = yield* Queue.unbounded<{
    readonly afterSequence: number | undefined;
    readonly events: Queue.Queue<OrchestrationThreadStreamItem, Error>;
    readonly closed: Deferred.Deferred<void>;
  }>();
  const olderLoads = yield* Queue.unbounded<{
    readonly window: ThreadSnapshotWindow;
    readonly response: Deferred.Deferred<Option.Option<OrchestrationThreadDetailSnapshot>>;
    readonly closed: Deferred.Deferred<void>;
  }>();
  const snapshot = options?.snapshot ?? SNAPSHOT;
  let httpLoads = 0;
  let diskLoads = 0;
  let opened = 0;
  let active = 0;
  const client = {
    [ORCHESTRATION_WS_METHODS.subscribeThread]: (input: { readonly afterSequence?: number }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const events = yield* Queue.unbounded<OrchestrationThreadStreamItem, Error>();
          const closed = yield* Deferred.make<void>();
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              opened += 1;
              active += 1;
            }),
            () =>
              Effect.sync(() => {
                active -= 1;
              }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
          );
          yield* Queue.offer(subscriptions, { afterSequence: input.afterSequence, events, closed });
          return options?.stream ?? Stream.fromQueue(events);
        }),
      ),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({
      threadResumeCompletionMarker: true,
      threadSnapshotPagination: true,
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const connectionState = yield* SubscriptionRef.make(
    options?.connected ? CONNECTED_STATE : AVAILABLE_CONNECTION_STATE,
  );
  const sessionRef = yield* SubscriptionRef.make(Option.some(session));
  const supervisor = EnvironmentSupervisor.of({
    target: TARGET,
    state: connectionState,
    session: sessionRef,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        socketUrl: TARGET.wsBaseUrl,
        httpAuthorization: null,
        target: TARGET,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environmentRegistry = EnvironmentRegistry.of({
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map(),
    ),
    networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
    start: Effect.void,
    register: () => Effect.die("Unexpected environment registration"),
    registerPlatform: () => Effect.die("Unexpected environment registration"),
    reconcilePlatform: () => Effect.die("Unexpected environment reconciliation"),
    remove: () => Effect.die("Unexpected environment removal"),
    removeRelayEnvironments: () => Effect.die("Unexpected environment removal"),
    retryNow: () => Effect.void,
    state: () => SubscriptionRef.get(supervisor.state),
    stateChanges: () => SubscriptionRef.changes(supervisor.state),
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    runStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  });
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(ConnectionWakeups, { changes: Stream.fromQueue(wakeups) }),
      Layer.succeed(EnvironmentRegistry, environmentRegistry),
      Layer.succeed(
        EnvironmentCacheStore,
        EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () =>
            Effect.sync(() => {
              diskLoads += 1;
              return Option.none();
            }),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          clear: () => Effect.void,
        }),
      ),
      Layer.succeed(
        ThreadSnapshotLoader,
        ThreadSnapshotLoader.of({
          load: (_prepared, _threadId, window) => {
            if (window?.beforeCursor === undefined) {
              return Effect.sync(() => {
                httpLoads += 1;
              }).pipe(
                Effect.andThen(
                  options?.initialLoad ??
                    Effect.succeed(options?.httpNone ? Option.none() : Option.some(snapshot)),
                ),
              );
            }
            return Effect.gen(function* () {
              const response =
                yield* Deferred.make<Option.Option<OrchestrationThreadDetailSnapshot>>();
              const closed = yield* Deferred.make<void>();
              yield* Effect.addFinalizer(() => Deferred.succeed(closed, undefined));
              yield* Queue.offer(olderLoads, { window, response, closed });
              return yield* Deferred.await(response);
            }).pipe(Effect.scoped);
          },
        }),
      ),
    ),
  );
  const raw = createEnvironmentThreadStateAtoms(runtime);
  const details = createEnvironmentThreadDetailAtoms(raw.stateAtom);
  const ref = { environmentId: TARGET.environmentId, threadId: THREAD_ID };
  const stateAtom = details.stateAtom(ref);
  const makeRegistry = Effect.acquireRelease(
    Effect.sync(() => AtomRegistry.make({ defaultIdleTTL: 60_000, timeoutResolution: 1 })),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  const registry = yield* makeRegistry;

  return {
    runtime,
    supervisor,
    registry,
    makeRegistry,
    rawAtoms: raw,
    stateAtom,
    details,
    ref,
    subscriptions,
    olderLoads,
    connectionState,
    session,
    sessionRef,
    wakeups,
    counts: () => ({ httpLoads, diskLoads, opened, active }),
  };
});

function observeState(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

function currentThread(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<EnvironmentThreadState>,
) {
  return Option.getOrThrow(registry.get(atom).data);
}

describe("createEnvironmentThreadStateAtoms", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.effect("exposes snapshot loader defects before the RPC subscription starts", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      const h = yield* makeHarness({
        connected: true,
        initialLoad: Effect.die(
          new Error("SYNTHETIC_RAW_SNAPSHOT_DEFECT_SHOULD_NOT_REACH_THREAD_UI"),
        ).pipe(Effect.ensuring(Deferred.succeed(completed, undefined))),
      });
      const unmount = h.registry.mount(h.stateAtom);
      yield* Deferred.await(completed);
      const failed = yield* observeState(h.registry, h.stateAtom, (state) =>
        Option.isSome(state.error),
      );
      expect(failed.status).toBe("empty");
      expect(failed.error).toEqual(Option.some("Could not synchronize the thread."));
      expect(failed.data).toEqual(Option.none());
      expect(h.counts()).toEqual({ httpLoads: 1, diskLoads: 1, opened: 0, active: 0 });
      yield* TestClock.adjust("1 second");
      expect(h.registry.get(h.stateAtom)).toEqual(failed);
      expect(h.counts()).toEqual({ httpLoads: 1, diskLoads: 1, opened: 0, active: 0 });
      unmount();
    }),
  );

  it.effect.each([
    { kind: "protocol", httpNone: true },
    { kind: "protocol", httpNone: false },
    { kind: "fatal", httpNone: true },
    { kind: "fatal", httpNone: false },
  ] as const)(
    "retains a terminated $kind load diagnostic across connection updates (empty: $httpNone)",
    ({ kind, httpNone }) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ connected: true, httpNone });
        const unmount = h.registry.mount(h.stateAtom);
        const first = yield* Queue.take(h.subscriptions);
        const error = new Error("SYNTHETIC_RAW_DEFECT_SHOULD_NOT_REACH_THREAD_UI");
        yield* Queue.failCause(
          first.events,
          kind === "fatal"
            ? Cause.die(error)
            : Cause.fail(
                new RpcClientError.RpcClientError({
                  reason: new RpcClientError.RpcClientDefect({
                    message: error.message,
                    cause: error,
                  }),
                }),
              ),
        );
        yield* Deferred.await(first.closed);
        // The real finalizer has run; advancing the atom runtime's test clock
        // also verifies that a defect does not enter the domain retry loop.
        yield* TestClock.adjust("1 second");
        const failed = h.registry.get(h.stateAtom);
        expect(failed.status).toBe(httpNone ? "empty" : "cached");
        expect(failed.error).toEqual(Option.some("Could not synchronize the thread."));
        expect(failed.data).toEqual(httpNone ? Option.none() : Option.some(THREAD));
        expect(h.counts().opened).toBe(1);
        expect(h.counts().active).toBe(0);

        // Session publication can precede connected, and a fatal child cannot
        // restart just because its supervisor reconnects.
        for (const connection of [
          AVAILABLE_CONNECTION_STATE,
          { ...CONNECTED_STATE, phase: "connecting" as const },
          CONNECTED_STATE,
        ]) {
          yield* SubscriptionRef.set(h.connectionState, connection);
          yield* TestClock.adjust("0 millis");
          expect(h.registry.get(h.stateAtom)).toEqual(failed);
        }
        yield* SubscriptionRef.set(h.sessionRef, Option.some({ ...h.session }));
        if (kind === "fatal") {
          yield* TestClock.adjust("1 second");
          expect(h.counts().opened).toBe(1);
          expect(h.registry.get(h.stateAtom)).toEqual(failed);
          unmount();
          return;
        }
        const next = yield* Queue.take(h.subscriptions);
        expect(h.registry.get(h.stateAtom).error).toEqual(Option.none());
        expect(h.registry.get(h.stateAtom).status).toBe("synchronizing");
        yield* Queue.offer(next.events, { kind: "snapshot", snapshot: SNAPSHOT });
        yield* Queue.offer(next.events, { kind: "synchronized" });
        const recovered = yield* observeState(
          h.registry,
          h.stateAtom,
          (state) => state.status === "live",
        );
        expect(recovered.error).toEqual(Option.none());
        expect(recovered.data).toEqual(Option.some(THREAD));
        unmount();
        yield* Deferred.await(next.closed);
      }),
  );

  it.effect.each([true, false])(
    "refreshes a failed load while still mounted (empty: %s)",
    (httpNone) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ connected: true, httpNone });
        const unmount = h.registry.mount(h.stateAtom);
        const first = yield* Queue.take(h.subscriptions);
        yield* Queue.failCause(first.events, Cause.die(new Error("snapshot failed")));
        yield* Deferred.await(first.closed);
        yield* observeState(h.registry, h.stateAtom, (state) => Option.isSome(state.error));

        h.registry.refresh(h.rawAtoms.stateAtom(h.ref.environmentId, h.ref.threadId));
        const next = yield* Queue.take(h.subscriptions);
        expect(h.registry.get(h.stateAtom).error).toEqual(Option.none());
        yield* Queue.offer(next.events, { kind: "snapshot", snapshot: SNAPSHOT });
        yield* Queue.offer(next.events, { kind: "synchronized" });
        const recovered = yield* observeState(
          h.registry,
          h.stateAtom,
          (state) => state.status === "live",
        );
        expect(recovered.data).toEqual(Option.some(THREAD));
        expect(recovered.error).toEqual(Option.none());
        expect(h.counts().active).toBe(1);
        unmount();
        yield* Deferred.await(next.closed);
      }),
  );

  it.effect("retries a protocol failure on foreground without replacing the session", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: true, httpNone: true });
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.fail(
        first.events,
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({
            message: "incompatible snapshot",
            cause: new Error("incompatible snapshot"),
          }),
        }),
      );
      yield* Deferred.await(first.closed);
      yield* TestClock.adjust("0 millis");
      expect(Option.isSome(h.registry.get(h.stateAtom).error)).toBe(true);
      yield* Queue.offer(h.wakeups, "application-active");
      const next = yield* Queue.take(h.subscriptions);
      expect(h.registry.get(h.stateAtom).error).toEqual(Option.none());
      yield* Queue.offer(next.events, { kind: "snapshot", snapshot: SNAPSHOT });
      yield* Queue.offer(next.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      unmount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect("keeps transport loss nonterminal and recovers with a replacement session", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: true, httpNone: true });
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.fail(
        first.events,
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 1006, closeReason: "connection lost" }),
        }),
      );
      yield* Deferred.await(first.closed);
      yield* TestClock.adjust("1 second");
      expect(h.registry.get(h.stateAtom)).toMatchObject({
        status: "synchronizing",
        error: Option.none(),
        data: Option.none(),
      });
      expect(h.counts().opened).toBe(1);
      yield* SubscriptionRef.set(h.sessionRef, Option.some({ ...h.session }));
      const next = yield* Queue.take(h.subscriptions);
      yield* Queue.offer(next.events, { kind: "snapshot", snapshot: SNAPSHOT });
      yield* Queue.offer(next.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      unmount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect("retains ordinary domain error reporting and same-session retries", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: true, httpNone: true });
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.fail(first.events, new Error("thread not found yet"));
      yield* Deferred.await(first.closed);
      const failed = yield* observeState(h.registry, h.stateAtom, (state) =>
        Option.isSome(state.error),
      );
      expect(failed.error).toEqual(Option.some("thread not found yet"));
      yield* TestClock.adjust("250 millis");
      const next = yield* Queue.take(h.subscriptions);
      expect(h.counts().opened).toBe(2);
      yield* Queue.offer(next.events, { kind: "snapshot", snapshot: SNAPSHOT });
      yield* Queue.offer(next.events, { kind: "synchronized" });
      const recovered = yield* observeState(
        h.registry,
        h.stateAtom,
        (state) => state.status === "live",
      );
      expect(recovered.error).toEqual(Option.none());
      unmount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect.each([
    { kind: "protocol", deleted: false },
    { kind: "fatal", deleted: false },
    { kind: "domain", deleted: false },
    { kind: "protocol", deleted: true },
  ] as const)(
    "keeps buffered outcomes after a $kind failure (deleted: $deleted)",
    ({ kind, deleted }) =>
      Effect.gen(function* () {
        const burst = yield* Deferred.make<void>();
        const error = new Error(
          kind === "domain"
            ? "buffered thread failure"
            : "SYNTHETIC_BUFFERED_DEFECT_SHOULD_NOT_REACH_THREAD_UI",
        );
        const items: OrchestrationThreadStreamItem[] = [
          { kind: "snapshot", snapshot: SNAPSHOT },
          { kind: "synchronized" },
          {
            kind: "event",
            event: {
              eventId: EventId.make("buffered-event"),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              sequence: 8,
              occurredAt: THREAD.createdAt,
              aggregateKind: "thread",
              aggregateId: THREAD_ID,
              type: "thread.meta-updated",
              payload: {
                threadId: THREAD_ID,
                title: "Buffer drained",
                updatedAt: THREAD.createdAt,
              },
            },
          },
        ];
        if (deleted) {
          items.push({
            kind: "event",
            event: {
              eventId: EventId.make("buffered-deletion"),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              sequence: 9,
              occurredAt: THREAD.createdAt,
              aggregateKind: "thread",
              aggregateId: THREAD_ID,
              type: "thread.deleted",
              payload: { threadId: THREAD_ID, deletedAt: THREAD.createdAt },
            },
          });
        }
        const failure =
          kind === "fatal"
            ? Cause.die(error)
            : Cause.fail(
                kind === "domain"
                  ? error
                  : new RpcClientError.RpcClientError({
                      reason: new RpcClientError.RpcClientDefect({
                        message: error.message,
                        cause: error,
                      }),
                    }),
              );
        const h = yield* makeHarness({
          connected: true,
          httpNone: true,
          stream: Stream.fromEffect(Deferred.await(burst)).pipe(
            Stream.flatMap(() => Stream.fromIterable(items)),
            Stream.concat(Stream.failCause(failure)),
          ),
        });
        yield* Effect.gen(function* () {
          const state = yield* makeEnvironmentThreadState(THREAD_ID);
          const initial = yield* Deferred.make<void>();
          const drained = yield* Deferred.make<void>();
          yield* SubscriptionRef.changes(state).pipe(
            Stream.runForEach((value) =>
              Deferred.succeed(initial, undefined).pipe(
                Effect.andThen(
                  (
                    deleted
                      ? value.status === "deleted"
                      : Option.getOrNull(value.data)?.title === "Buffer drained"
                  )
                    ? Deferred.succeed(drained, undefined)
                    : Effect.void,
                ),
              ),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(initial);
          const subscription = yield* Queue.take(h.subscriptions);
          yield* Deferred.succeed(burst, undefined);
          yield* Deferred.await(subscription.closed);
          yield* Deferred.await(drained);
          const final = yield* SubscriptionRef.get(state);
          if (deleted) {
            expect(final.status).toBe("deleted");
            expect(final.data).toEqual(Option.none());
            expect(final.error).toEqual(Option.none());
            return;
          }
          expect(Option.getOrThrow(final.data).title).toBe("Buffer drained");
          expect(final.error).toEqual(
            Option.some(kind === "domain" ? error.message : "Could not synchronize the thread."),
          );
          expect(final.status).toBe("cached");
        }).pipe(
          Effect.provideService(EnvironmentSupervisor, h.supervisor),
          Effect.provide(h.registry.get(h.runtime.layer)),
          Effect.scoped,
        );
      }),
  );

  it.effect("shares one live stream and closes it after the last detail consumer leaves", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const unmountMessages = h.registry.mount(h.details.messagesAtom(h.ref));
      const first = yield* Queue.take(h.subscriptions);
      const unmountStatus = h.registry.mount(h.details.statusAtom(h.ref));
      expect(h.counts()).toEqual({ httpLoads: 1, diskLoads: 1, opened: 1, active: 1 });
      unmountMessages();
      yield* Queue.offer(first.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      expect(h.counts().active).toBe(1);
      unmountStatus();
      yield* Deferred.await(first.closed);
      expect(h.counts().active).toBe(0);
    }),
  );

  it.effect("keeps warm data and resumes a completed cursor without loading another snapshot", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.offer(first.events, {
        kind: "event",
        event: {
          type: "thread.message-sent",
          sequence: 8,
          eventId: EventId.make("message-1"),
          aggregateKind: "thread",
          aggregateId: THREAD_ID,
          occurredAt: THREAD.createdAt,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: {
            threadId: THREAD_ID,
            messageId: MessageId.make("message-1"),
            role: "assistant",
            text: "Retained text",
            turnId: null,
            streaming: true,
            createdAt: THREAD.createdAt,
            updatedAt: THREAD.createdAt,
          },
        },
      });
      yield* Queue.offer(first.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      const before = currentThread(h.registry, h.stateAtom);
      unmount();
      yield* Deferred.await(first.closed);
      const remount = h.registry.mount(h.stateAtom);
      expect(currentThread(h.registry, h.stateAtom)).toBe(before);
      const next = yield* Queue.take(h.subscriptions);
      expect(next.afterSequence).toBe(8);
      expect(h.counts()).toEqual({ httpLoads: 1, diskLoads: 1, opened: 2, active: 1 });
      remount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect.each([
    { replayed: false, statuses: ["live"] },
    { replayed: true, statuses: ["live", "synchronizing", "live"] },
  ])(
    "keeps a warm resume live until it replays events (replayed: $replayed)",
    ({ replayed, statuses }) =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ connected: true });
        const unmount = h.registry.mount(h.stateAtom);
        const first = yield* Queue.take(h.subscriptions);
        yield* Queue.offer(first.events, { kind: "synchronized" });
        yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
        unmount();
        yield* Deferred.await(first.closed);

        const observed: Array<EnvironmentThreadState["status"]> = [];
        const stop = h.registry.subscribe(h.stateAtom, (state) => observed.push(state.status), {
          immediate: true,
        });
        const remount = h.registry.mount(h.stateAtom);
        const next = yield* Queue.take(h.subscriptions);
        expect(next.afterSequence).toBe(7);
        if (replayed) {
          yield* Queue.offer(next.events, {
            kind: "snapshot",
            snapshot: { snapshotSequence: 9, thread: { ...THREAD, title: "Replayed" } },
          });
          yield* observeState(h.registry, h.stateAtom, (state) => state.status === "synchronizing");
        }
        yield* Queue.offer(next.events, { kind: "synchronized" });
        yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
        expect(observed.filter((status, index) => observed[index - 1] !== status)).toEqual(
          statuses,
        );
        stop();
        remount();
        yield* Deferred.await(next.closed);
      }),
  );

  it.effect("downgrades a warm resume when the connection dropped while away", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ connected: true });
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      yield* Queue.offer(first.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      unmount();
      yield* Deferred.await(first.closed);

      yield* SubscriptionRef.set(h.sessionRef, Option.none());
      yield* SubscriptionRef.set(h.connectionState, AVAILABLE_CONNECTION_STATE);
      const remount = h.registry.mount(h.stateAtom);
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "cached");
      expect(currentThread(h.registry, h.stateAtom)).toBe(THREAD);
      expect(h.counts().opened).toBe(1);

      yield* SubscriptionRef.set(h.connectionState, CONNECTED_STATE);
      yield* SubscriptionRef.set(h.sessionRef, Option.some(h.session));
      const next = yield* Queue.take(h.subscriptions);
      expect(next.afterSequence).toBe(7);
      expect(h.registry.get(h.stateAtom).status).toBe("synchronizing");
      yield* Queue.offer(next.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (state) => state.status === "live");
      remount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect("keeps warm data when the raw atom family's weak entry is collected", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const oldRaw = h.rawAtoms.stateAtom(TARGET.environmentId, THREAD_ID);
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      const latest = { ...THREAD, title: "Newer cached thread" };
      yield* Queue.offer(first.events, {
        kind: "snapshot",
        snapshot: { snapshotSequence: 8, thread: latest },
      });
      yield* Queue.offer(first.events, { kind: "synchronized" });
      yield* observeState(h.registry, h.stateAtom, (value) => value.status === "live");
      unmount();
      yield* Deferred.await(first.closed);

      // Force the weak-family miss without depending on host GC timing.
      const deref = WeakRef.prototype.deref;
      vi.spyOn(WeakRef.prototype, "deref").mockImplementation(function (this: WeakRef<object>) {
        const value = deref.call(this);
        return value === oldRaw ? undefined : value;
      });
      const remount = h.registry.mount(h.stateAtom);
      expect(currentThread(h.registry, h.stateAtom)).toBe(latest);
      const next = yield* Queue.take(h.subscriptions);
      expect(next.afterSequence).toBe(8);
      expect(h.counts()).toEqual({ httpLoads: 1, diskLoads: 1, opened: 2, active: 1 });
      remount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect("keeps cached snapshots local to each registry", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      unmount();
      yield* Deferred.await(first.closed);
      const otherRegistry = yield* h.makeRegistry;
      const unmountOther = otherRegistry.mount(h.stateAtom);
      const other = yield* Queue.take(h.subscriptions);
      expect(h.counts()).toEqual({ httpLoads: 2, diskLoads: 2, opened: 2, active: 1 });
      unmountOther();
      yield* Deferred.await(other.closed);
    }),
  );

  it.effect("expires the plain snapshot after five idle minutes", () =>
    Effect.gen(function* () {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const h = yield* makeHarness();
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      unmount();
      yield* Deferred.await(first.closed);
      yield* Effect.yieldNow;
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(THREAD_SNAPSHOT_IDLE_TTL_MS + 1));
      const remount = h.registry.mount(h.stateAtom);
      const next = yield* Queue.take(h.subscriptions);
      expect(h.counts()).toEqual({ httpLoads: 2, diskLoads: 2, opened: 2, active: 1 });
      remount();
      yield* Deferred.await(next.closed);
    }),
  );

  it.effect("cancels older-page work on unmount and permits it again on a warm return", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        snapshot: {
          ...SNAPSHOT,
          page: { beforeCursor: "older-1", hasMore: true, snapshotSequence: 7 },
        },
      });
      const unmount = h.registry.mount(h.stateAtom);
      const first = yield* Queue.take(h.subscriptions);
      expect(requestOlderThreadTurns(TARGET.environmentId, THREAD_ID)).toBe(true);
      const older = yield* Queue.take(h.olderLoads);
      expect(Option.getOrThrow(h.registry.get(h.stateAtom).page).loadingOlder).toBe(true);
      unmount();
      yield* Deferred.await(first.closed);
      yield* Deferred.await(older.closed);
      const remount = h.registry.mount(h.stateAtom);
      const next = yield* Queue.take(h.subscriptions);
      expect(Option.getOrThrow(h.registry.get(h.stateAtom).page).loadingOlder).toBe(false);
      expect(requestOlderThreadTurns(TARGET.environmentId, THREAD_ID)).toBe(true);
      const retried = yield* Queue.take(h.olderLoads);
      expect(retried.window.beforeCursor).toBe("older-1");
      expect(h.counts().httpLoads).toBe(1);
      remount();
      yield* Deferred.await(next.closed);
      yield* Deferred.await(retried.closed);
    }),
  );
});
