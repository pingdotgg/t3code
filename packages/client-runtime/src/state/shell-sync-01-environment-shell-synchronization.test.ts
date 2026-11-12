import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { type EnvironmentShellState, makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import { v2Project, v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const LIVE_SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 1,
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({ shellResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makePersistenceHarness = Effect.fn("test.makeShellPersistenceHarness")(function* (
  saveShell: Persistence.EnvironmentCacheStore["Service"]["saveShell"],
) {
  const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
  } as unknown as WsRpcProtocolClient;
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session(client))),
    prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const state = yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
      load: () => Effect.succeedNone,
    }),
  );
  const send = Effect.fn("test.sendShellItem")(function* (
    item: OrchestrationV2ShellStreamItem,
    ready: (snapshot: OrchestrationV2ShellSnapshot) => boolean,
  ) {
    const previous = yield* SubscriptionRef.get(state);
    yield* Queue.offer(events, item);
    return yield* SubscriptionRef.changes(state).pipe(
      Stream.filter((value) => value !== previous),
      Stream.map((value) => value.snapshot),
      Stream.filter(Option.isSome),
      Stream.map((value) => value.value),
      Stream.filter(ready),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  });
  yield* send({ kind: "snapshot", snapshot: LIVE_SHELL_SNAPSHOT }, () => true);
  return { state, send };
});



describe("environment shell synchronization", () => {
  it.effect.each([
    { bufferSize: Infinity, expectedSequences: [51], existingRows: false },
    { bufferSize: Infinity, expectedSequences: [51], existingRows: true },
    // RpcClient defaults to a 16-event buffer, which splits larger server chunks.
    { bufferSize: 16, expectedSequences: [17, 33, 49, 51], existingRows: false },
    { bufferSize: 16, expectedSequences: [17, 33, 49, 51], existingRows: true },
  ])("batches $bufferSize events (existing: $existingRows)", (input) =>
    Effect.gen(function* () {
      const { bufferSize, expectedSequences, existingRows } = input;
      const events = yield* Queue.bounded<OrchestrationV2ShellStreamItem>(bufferSize);
      let rowVisits = 0;
      const rows = Array.from({ length: 50 }, (_, index) => ({
        ...v2ThreadShell,
        get id() {
          rowVisits += 1;
          return ThreadId.make(`thread-${index}`);
        },
      }));
      const batchSnapshot = { ...LIVE_SHELL_SNAPSHOT, threads: existingRows ? rows : [] };
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(
          ShellSnapshotLoader.ShellSnapshotLoader,
          ShellSnapshotLoader.ShellSnapshotLoader.of({
            load: () => Effect.succeedNone,
          }),
        ),
      );
      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, { kind: "snapshot", snapshot: batchSnapshot });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      // Observe before publishing so no batch can arrive before the subscription.
      const observed = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.drop(1),
        Stream.takeUntil(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 51,
        ),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      rowVisits = 0;
      yield* Queue.offerAll(
        events,
        Array.from({ length: 50 }, (_, index) => ({
          kind: "thread.updated" as const,
          sequence: 2 + index,
          location: "active" as const,
          thread: {
            ...v2ThreadShell,
            get id() {
              rowVisits += 1;
              return ThreadId.make(`thread-${index}`);
            },
            title: "Updated",
          },
        })),
      );
      const states = yield* Fiber.join(observed);
      if (existingRows) {
        // Index each received batch once; distinct updates must not rescan every row.
        expect(rowVisits).toBeLessThanOrEqual(50 * (expectedSequences.length + 10));
      }
      const snapshots = states.map((state) => Option.getOrThrow(state.snapshot));
      expect(snapshots.map((snapshot) => snapshot.snapshotSequence)).toEqual(expectedSequences);
      expect(snapshots.at(-1)!.threads.map((thread) => thread.id)).toEqual(
        Array.from({ length: 50 }, (_, index) => `thread-${index}`),
      );

      const removedObserved = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 52,
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Queue.offerAll(events, [
        { kind: "future.event", sequence: 99 } as never,
        {
          kind: "thread.removed",
          sequence: 52,
          location: "active",
          threadId: ThreadId.make("thread-0"),
        },
        {
          kind: "thread.removed",
          sequence: 51,
          location: "active",
          threadId: ThreadId.make("thread-1"),
        },
      ]);
      const removedState = Option.getOrThrow(yield* Fiber.join(removedObserved));
      expect(removedState.generation).toBe(states.at(-1)!.generation);
      expect([...removedState.removedAt]).toEqual([[ThreadId.make("thread-0"), 52]]);

      // An authoritative snapshot resets even a higher live cursor in the same batch.
      const resetRow = { ...v2ThreadShell, id: ThreadId.make("reset-row") };
      const resetObserved = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 4,
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Queue.offerAll(events, [
        {
          kind: "thread.removed",
          sequence: 52,
          location: "active",
          threadId: ThreadId.make("thread-0"),
        },
        {
          kind: "snapshot",
          snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 2, threads: [resetRow] },
        },
        { kind: "thread.removed", sequence: 2, location: "active", threadId: resetRow.id },
        {
          kind: "thread.updated",
          sequence: 3,
          location: "active",
          thread: { ...resetRow, title: "After reset" },
        },
        { kind: "synchronized" },
        {
          kind: "thread.updated",
          sequence: 4,
          location: "active",
          thread: { ...resetRow, title: "After completion" },
        },
      ]);
      const resetState = Option.getOrThrow(yield* Fiber.join(resetObserved));
      expect(resetState.status).toBe("live");
      expect(resetState.generation).toBeGreaterThan(removedState.generation);
      expect(resetState.removedAt.size).toBe(0);
      expect(Option.getOrThrow(resetState.snapshot).threads).toEqual([
        { ...resetRow, title: "After completion" },
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("skips unchanged shell writes, persists resets and flushes changed rows", () =>
    Effect.gen(function* () {
      const saved = yield* SubscriptionRef.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makePersistenceHarness((_id, snapshot) =>
            SubscriptionRef.update(saved, (values) => [...values, snapshot]),
          );
          yield* TestClock.adjust("500 millis");
          yield* h.send(
            { kind: "thread.updated", sequence: 10, location: "active", thread: v2ThreadShell },
            (snapshot) => snapshot.snapshotSequence === 10,
          );
          yield* TestClock.adjust("10 seconds");
          expect(
            (yield* SubscriptionRef.get(saved)).map((snapshot) => snapshot.snapshotSequence),
          ).toEqual([1]);
          const live = Option.getOrThrow((yield* SubscriptionRef.get(h.state)).snapshot);
          expect(live.snapshotSequence).toBe(10);
          const enriched = yield* h.send(
            {
              kind: "snapshot",
              snapshot: { ...live, projects: live.projects.map((project) => ({ ...project })) },
              resolvedRepositoryIdentityRoots: live.projects.map(
                (project) => project.workspaceRoot,
              ),
            },
            () => true,
          );
          expect(enriched.projects).toEqual(live.projects);
          expect(enriched.snapshotSequence).toBe(10);
          yield* TestClock.adjust("10 seconds");
          expect(
            (yield* SubscriptionRef.get(saved)).map((snapshot) => snapshot.snapshotSequence),
          ).toEqual([1]);
          yield* h.send(
            { kind: "snapshot", snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 4 } },
            (snapshot) => snapshot.snapshotSequence === 4,
          );
          yield* TestClock.adjust("10 seconds");
          yield* h.send(
            {
              kind: "snapshot",
              snapshot: {
                ...LIVE_SHELL_SNAPSHOT,
                snapshotSequence: 4,
                projects: [{ ...v2Project, title: "Changed at same sequence" }],
              },
            },
            (snapshot) => snapshot.projects[0]?.title === "Changed at same sequence",
          );
        }),
      );
      expect(
        (yield* SubscriptionRef.get(saved)).map((snapshot) => [
          snapshot.snapshotSequence,
          snapshot.projects[0]?.title,
        ]),
      ).toEqual([
        [1, v2Project.title],
        [4, v2Project.title],
        [4, "Changed at same sequence"],
      ]);
    }),
  );
  it.effect("retries a failed shell save after a cursor-only update", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make<ReadonlyArray<number>>([]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makePersistenceHarness((_id, snapshot) =>
            Effect.gen(function* () {
              const values = yield* Ref.updateAndGet(attempts, (values) => [
                ...values,
                snapshot.snapshotSequence,
              ]);
              if (values.length === 1)
                return yield* new Persistence.ConnectionPersistenceError({
                  operation: "save-shell",
                  message: "test failure",
                });
            }),
          );
          yield* TestClock.adjust("500 millis");
          yield* h.send(
            { kind: "thread.updated", sequence: 2, location: "active", thread: v2ThreadShell },
            (snapshot) => snapshot.snapshotSequence === 2,
          );
          yield* TestClock.adjust("10 seconds");
        }),
      );
      expect(yield* Ref.get(attempts)).toEqual([1, 2]);
    }),
  );
  it.effect("flushes the latest live snapshot without blocking connection state updates", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* SubscriptionRef.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      const saveStarted = yield* Deferred.make<void>();
      const releaseSave = yield* Deferred.make<void>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: activeSession,
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeedNone,
        saveShell: (_environmentId, snapshot) =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
            Effect.andThen(SubscriptionRef.update(saved, (values) => [...values, snapshot])),
          ),
        loadThread: () => Effect.succeedNone,
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeedNone,
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeedNone,
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeedNone,
      });

      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 2,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* SubscriptionRef.set(supervisorState, {
        desired: false,
        network: "online",
        phase: "available",
        stage: null,
        attempt: 2,
        generation: 2,
        lastFailure: null,
        retryAt: null,
      });
      yield* Deferred.await(saveStarted);

      yield* SubscriptionRef.set(supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 3,
        generation: 3,
        lastFailure: null,
        retryAt: null,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "synchronizing"),
        Stream.runHead,
      );

      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");
      expect(yield* SubscriptionRef.get(saved)).toEqual([]);

      yield* Deferred.succeed(releaseSave, undefined);
      yield* SubscriptionRef.changes(saved).pipe(
        Stream.filter((values) => values.length > 0),
        Stream.runHead,
      );

      expect(yield* SubscriptionRef.get(saved)).toEqual([LIVE_SHELL_SNAPSHOT]);
    }),
  );
});

