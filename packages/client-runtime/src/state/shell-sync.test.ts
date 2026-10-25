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
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("environment shell synchronization", () => {
  it.effect("flushes the latest live snapshot without blocking connection state updates", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* Ref.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
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
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: (_environmentId, snapshot) =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
            Effect.andThen(Ref.update(saved, (values) => [...values, snapshot])),
          ),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
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
      for (let index = 0; index < 100; index += 1) {
        if ((yield* SubscriptionRef.get(shellState)).status === "synchronizing") break;
        yield* Effect.yieldNow;
      }

      expect((yield* SubscriptionRef.get(shellState)).status).toBe("synchronizing");
      expect(yield* Ref.get(saved)).toEqual([]);

      yield* Deferred.succeed(releaseSave, undefined);
      for (let index = 0; index < 100; index += 1) {
        if ((yield* Ref.get(saved)).length > 0) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(saved)).toEqual([LIVE_SHELL_SNAPSHOT]);
    }),
  );

  it.effect("re-persists same-sequence enrichment when an older in-flight save completes", () =>
    Effect.gen(function* () {
      const repositoryIdentity = {
        canonicalKey: "github.com/example/repo",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/repo.git",
        },
      };
      const unenrichedSnapshot: OrchestrationV2ShellSnapshot = {
        ...LIVE_SHELL_SNAPSHOT,
        snapshotSequence: 1,
        projects: [{ ...v2Project, repositoryIdentity: null }],
      };
      const enrichedSnapshot: OrchestrationV2ShellSnapshot = {
        ...LIVE_SHELL_SNAPSHOT,
        snapshotSequence: 1,
        projects: [{ ...v2Project, repositoryIdentity }],
      };

      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* Ref.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
      const unenrichedSaveStarted = yield* Deferred.make<void>();
      const releaseUnenrichedSave = yield* Deferred.make<void>();
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
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: (_environmentId, snapshot) =>
          Effect.gen(function* () {
            if (snapshot.projects[0]?.repositoryIdentity == null) {
              yield* Deferred.succeed(unenrichedSaveStarted, undefined);
              yield* Deferred.await(releaseUnenrichedSave);
            }
            yield* Ref.update(saved, (values) => [...values, snapshot]);
          }),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
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
        snapshot: unenrichedSnapshot,
      });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      // Disconnect flush starts an immediate persist of the unenriched snapshot
      // (debounced path needs TestClock advancement; flush does not).
      yield* SubscriptionRef.set(supervisorState, {
        desired: false,
        network: "online",
        phase: "available",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      yield* Deferred.await(unenrichedSaveStarted);

      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: enrichedSnapshot,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) =>
            Option.isSome(state.snapshot) &&
            state.snapshot.value.projects[0]?.repositoryIdentity != null,
        ),
        Stream.runHead,
      );

      yield* Deferred.succeed(releaseUnenrichedSave, undefined);
      for (let index = 0; index < 100; index += 1) {
        const values = yield* Ref.get(saved);
        if (values.length > 0 && values.at(-1)?.projects[0]?.repositoryIdentity != null) {
          break;
        }
        yield* Effect.yieldNow;
      }

      const finalSaved = (yield* Ref.get(saved)).at(-1);
      expect(finalSaved?.snapshotSequence).toBe(1);
      expect(finalSaved?.projects[0]?.repositoryIdentity).toEqual(repositoryIdentity);
    }),
  );

  it.effect("scope teardown flush stays stable while a save is blocked", () =>
    Effect.gen(function* () {
      const lateSnapshot: OrchestrationV2ShellSnapshot = {
        ...LIVE_SHELL_SNAPSHOT,
        snapshotSequence: 2,
        projects: [{ ...v2Project, title: "Late stream event" }],
      };
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const saved = yield* Ref.make<ReadonlyArray<OrchestrationV2ShellSnapshot>>([]);
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
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: (_environmentId, snapshot) =>
          Deferred.succeed(saveStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSave)),
            Effect.andThen(Ref.update(saved, (values) => [...values, snapshot])),
          ),
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });

      const scope = yield* Scope.make();
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
        Scope.provide(scope),
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

      const closeFiber = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Deferred.await(saveStarted);
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: lateSnapshot,
      });
      for (let index = 0; index < 50; index += 1) {
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(releaseSave, undefined);
      yield* Fiber.join(closeFiber);

      const values = yield* Ref.get(saved);
      expect(values.length).toBeGreaterThan(0);
      expect(values.every((snapshot) => snapshot.snapshotSequence === 1)).toBe(true);
      expect(values.every((snapshot) => snapshot.projects[0]?.title !== "Late stream event")).toBe(
        true,
      );
    }),
  );

  it.effect("applies authoritative lower-sequence HTTP resets over client-ahead cache", () =>
    Effect.gen(function* () {
      const cachedSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 20,
        projects: [{ ...v2Project, title: "Client ahead" }],
      };
      const httpSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 4,
        projects: [{ ...v2Project, title: "Server reset" }],
      };
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: supervisorState,
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.some(cachedSnapshot)),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.some(httpSnapshot)),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 4,
        ),
        Stream.runHead,
      );

      const state = yield* SubscriptionRef.get(shellState);
      expect(Option.getOrThrow(state.snapshot).snapshotSequence).toBe(4);
      expect(Option.getOrThrow(state.snapshot).projects[0]?.title).toBe("Server reset");
    }),
  );

  it.effect("opts in to idle-child omission and counts authoritative snapshots and removals", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const subscribeInput = yield* Deferred.make<unknown>();
      const loadOptions = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: unknown) =>
          Stream.unwrap(
            Deferred.succeed(subscribeInput, input).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const familySession: RpcSession.RpcSession = {
        ...session(client),
        initialConfig: Effect.succeed({
          shellResumeCompletionMarker: true,
          shellThreadFamilies: true,
        } as never),
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(familySession)),
        prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.none()),
        saveServerConfig: () => Effect.void,
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: (_prepared, options) =>
          Ref.update(loadOptions, (all) => [...all, options]).pipe(
            Effect.as(Option.some(LIVE_SHELL_SNAPSHOT)),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );
      const stateWhere = (predicate: (state: EnvironmentShellState) => boolean) =>
        SubscriptionRef.changes(shellState).pipe(Stream.filter(predicate), Stream.runHead);

      // Both transports must omit, or omitted children would come back through the socket.
      expect(yield* Deferred.await(subscribeInput)).toMatchObject({
        afterSequence: 1,
        omitIdleSubagents: true,
      });
      expect(yield* Ref.get(loadOptions)).toEqual([{ omitIdleSubagents: true }]);
      const loaded = Option.getOrThrow(yield* stateWhere((state) => state.generation > 0));
      expect(loaded.removedAt.size).toBe(0);

      const gone = ThreadId.make("thread-gone");
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: { ...LIVE_SHELL_SNAPSHOT, threads: [] },
        resolvedRepositoryIdentityRoots: [],
      });
      yield* Queue.offer(events, {
        kind: "thread.removed",
        sequence: 2,
        location: "active",
        threadId: gone,
      });
      const removed = Option.getOrThrow(yield* stateWhere((state) => state.removedAt.size > 0));
      // An enrichment refresh is not authoritative.
      expect(removed.generation).toBe(loaded.generation);
      expect(removed.removedAt.get(gone)).toBe(2);

      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 5 },
      });
      const reset = Option.getOrThrow(
        yield* stateWhere((state) => state.generation > loaded.generation),
      );
      expect(reset.removedAt.size).toBe(0);
    }),
  );

  it.effect("fills deferred cached pull request links without overwriting newer rows", () =>
    Effect.gen(function* () {
      const link = (number: number): ThreadPullRequestLink => ({
        host: "github.com",
        repository: "pingdotgg/t3code",
        number,
        url: `https://github.com/pingdotgg/t3code/pull/${number}`,
        source: "agent",
        linkedAt: "2026-06-20T00:00:00.000Z",
        snapshot: null,
        stack: null,
      });
      const otherThreadId = ThreadId.make("thread-other");
      const cachedSnapshot: OrchestrationV2ShellSnapshot = {
        ...v2ShellSnapshot,
        snapshotSequence: 5,
        threads: [v2ThreadShell, { ...v2ThreadShell, id: otherThreadId }],
      };
      const linksReady = yield* Deferred.make<void>();
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
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () =>
          Effect.succeedSome({
            ...cachedSnapshot,
            loadPullRequests: Deferred.await(linksReady).pipe(
              Effect.as(
                new Map([
                  [v2ThreadShell.id, [link(1)]],
                  [otherThreadId, [link(2)]],
                ]),
              ),
            ),
          }),
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
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () => Effect.succeedNone,
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );

      const threadsOf = (state: {
        readonly snapshot: Option.Option<OrchestrationV2ShellSnapshot>;
      }) => Option.getOrThrow(state.snapshot).threads;
      expect(threadsOf(yield* SubscriptionRef.get(shellState))).toEqual(cachedSnapshot.threads);

      const serverRow = { ...v2ThreadShell, title: "From server", pullRequests: [link(9)] };
      yield* Queue.offer(events, {
        kind: "thread.updated",
        sequence: 6,
        location: "active",
        thread: serverRow,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => threadsOf(state)[0]?.title === "From server"),
        Stream.runHead,
      );

      yield* Deferred.succeed(linksReady, undefined);
      const filled = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.map(threadsOf),
        Stream.filter((threads) => threads[1]?.pullRequests !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(filled[0]).toBe(serverRow);
      expect(filled[1]?.pullRequests).toEqual([link(2)]);
    }),
  );

  it.effect("drops an older snapshot's links once a newer snapshot reuses its rows", () =>
    Effect.gen(function* () {
      const link = (number: number): ThreadPullRequestLink => ({
        host: "github.com",
        repository: "pingdotgg/t3code",
        number,
        url: `https://github.com/pingdotgg/t3code/pull/${number}`,
        source: "agent",
        linkedAt: "2026-06-20T00:00:00.000Z",
        snapshot: null,
        stack: null,
      });
      const firstLinks = yield* Deferred.make<void>();
      const secondLinks = yield* Deferred.make<void>();
      const firstFillStarted = yield* Deferred.make<void>();
      const loads = yield* Ref.make(0);
      const subscriptions = yield* Ref.make(0);
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
          Stream.unwrap(Ref.update(subscriptions, (n) => n + 1).pipe(Effect.as(Stream.never))),
      } as unknown as WsRpcProtocolClient;
      const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
        Option.some(session(client)),
      );
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
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
      const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
        load: () =>
          Ref.updateAndGet(loads, (n) => n + 1).pipe(
            Effect.map((n) =>
              Option.some({
                ...v2ShellSnapshot,
                snapshotSequence: n,
                loadPullRequests: (n === 1
                  ? Deferred.succeed(firstFillStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(firstLinks)),
                    )
                  : Deferred.await(secondLinks)
                ).pipe(Effect.as(new Map([[v2ThreadShell.id, [link(n)]]]))),
              }),
            ),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
      );
      yield* Deferred.await(firstFillStarted);

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (state) => Option.isSome(state.snapshot) && state.snapshot.value.snapshotSequence === 2,
        ),
        Stream.runHead,
      );

      yield* Deferred.succeed(firstLinks, undefined);
      yield* Deferred.succeed(secondLinks, undefined);
      const filled = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.map((state) => Option.getOrThrow(state.snapshot).threads[0]?.pullRequests),
        Stream.filter((links) => links !== undefined),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(filled).toEqual([link(2)]);
    }),
  );
});
