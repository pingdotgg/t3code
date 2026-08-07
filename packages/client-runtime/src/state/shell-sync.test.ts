import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeEnvironmentShellState, ShellSnapshotLoader } from "./shell.ts";

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

const LIVE_SHELL_SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-06-06T00:00:00.000Z",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({ shellResumeCompletionMarker: true } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("environment shell synchronization", () => {
  it.effect("publishes live state before persistence and preserves it when ready", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
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
        saveShell: () => Effect.never,
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
      // Cold cache with no HTTP snapshot available → falls back to the
      // socket-embedded snapshot.
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () => Effect.succeed(Option.none()),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
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
      const synchronizing = yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "synchronizing" && Option.isSome(state.snapshot)),
        Stream.runHead,
      );
      expect(Option.getOrThrow(Option.getOrThrow(synchronizing).snapshot)).toEqual(
        LIVE_SHELL_SNAPSHOT,
      );

      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
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
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      const state = yield* SubscriptionRef.get(shellState);
      expect(state.status).toBe("live");
      expect(Option.getOrThrow(state.snapshot)).toEqual(LIVE_SHELL_SNAPSHOT);
    }),
  );

  it.effect("requests a full socket snapshot when the HTTP refresh fails", () =>
    Effect.gen(function* () {
      const cachedSnapshot: OrchestrationShellSnapshot = {
        snapshotSequence: 5,
        projects: [],
        threads: [{ id: "cached-thread" } as never],
        updatedAt: "2026-06-06T00:00:00.000Z",
      };
      const resetSnapshot: OrchestrationShellSnapshot = {
        ...cachedSnapshot,
        snapshotSequence: 9_999,
        threads: [],
        updatedAt: "2026-06-07T00:00:00.000Z",
      };
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
      const subscribeInputs = yield* Queue.unbounded<{
        readonly afterSequence?: number;
        readonly requestCompletionMarker?: boolean;
      }>();
      const loaderCalls = yield* Ref.make(0);
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: {
          readonly afterSequence?: number;
          readonly requestCompletionMarker?: boolean;
        }) =>
          Stream.unwrap(
            Queue.offer(subscribeInputs, input).pipe(Effect.as(Stream.fromQueue(events))),
          ),
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
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () => Ref.update(loaderCalls, (count) => count + 1).pipe(Effect.as(Option.none())),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
        Effect.provideService(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
        ),
      );

      const subscribeInput = yield* Queue.take(subscribeInputs);
      expect(subscribeInput.afterSequence).toBeUndefined();
      expect(subscribeInput.requestCompletionMarker).toBe(true);
      expect(yield* Ref.get(loaderCalls)).toBe(1);
      const synchronizing = yield* SubscriptionRef.get(shellState);
      expect(synchronizing.status).toBe("synchronizing");
      expect(Option.getOrThrow(synchronizing.snapshot)).toEqual(cachedSnapshot);

      yield* Queue.offer(events, { kind: "snapshot", snapshot: resetSnapshot });
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((value) => value.status === "live"),
        Stream.runHead,
      );

      const live = yield* SubscriptionRef.get(shellState);
      expect(Option.getOrThrow(live.snapshot)).toEqual(resetSnapshot);
      expect(yield* Ref.get(loaderCalls)).toBe(1);

      yield* Queue.offer(wakeups, "application-active");
      const resumedInput = yield* Queue.take(subscribeInputs);
      expect(resumedInput.afterSequence).toBe(resetSnapshot.snapshotSequence);
      expect(resumedInput.requestCompletionMarker).toBe(true);
      expect(yield* Ref.get(loaderCalls)).toBe(1);
    }),
  );

  it.effect("resubscribes from the in-memory shell cursor when the app becomes active", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
      const loaderCalls = yield* Ref.make(0);
      const capturedAfterSequences = yield* Ref.make<ReadonlyArray<number | undefined>>([]);
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input: { readonly afterSequence?: number }) =>
          Stream.unwrap(
            Ref.update(capturedAfterSequences, (captured) => [
              ...captured,
              input.afterSequence,
            ]).pipe(Effect.as(Stream.fromQueue(events))),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
      const activeSession = yield* SubscriptionRef.make(Option.some(session(client)));
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
        loadShell: () => Effect.succeed(Option.some(LIVE_SHELL_SNAPSHOT)),
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
      const snapshotLoader = ShellSnapshotLoader.of({
        load: () =>
          Ref.updateAndGet(loaderCalls, (count) => count + 1).pipe(
            Effect.map((count) =>
              Option.some({ ...LIVE_SHELL_SNAPSHOT, snapshotSequence: count * 10 }),
            ),
          ),
      });
      const shellState = yield* makeEnvironmentShellState().pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.provideService(ShellSnapshotLoader, snapshotLoader),
        Effect.provideService(
          ConnectionWakeups.ConnectionWakeups,
          ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
        ),
      );

      // A new session starts from an authoritative HTTP snapshot.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(capturedAfterSequences)).length >= 1) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(capturedAfterSequences)).toEqual([10]);
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((value) => value.status === "live"),
        Stream.runHead,
      );

      // A newer snapshot arrives on the stream and advances the cursor.
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 40 },
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter(
          (value) => Option.isSome(value.snapshot) && value.snapshot.value.snapshotSequence === 40,
        ),
        Stream.runHead,
      );

      yield* Queue.offer(wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(capturedAfterSequences)).length >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(capturedAfterSequences)).toEqual([10, 40]);
      yield* Queue.offer(events, { kind: "synchronized" });

      yield* Queue.offer(wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(capturedAfterSequences)).length >= 3) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(capturedAfterSequences)).toEqual([10, 40, 40]);

      yield* Queue.offer(wakeups, "application-active-reconnect");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect((yield* Ref.get(capturedAfterSequences)).length).toBe(3);
      expect(yield* Ref.get(loaderCalls)).toBe(1);

      // Replacing the session performs another authoritative refresh.
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(capturedAfterSequences)).length >= 4) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(capturedAfterSequences)).toEqual([10, 40, 40, 20]);
      expect(yield* Ref.get(loaderCalls)).toBe(2);
    }),
  );
});
