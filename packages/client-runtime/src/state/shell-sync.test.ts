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
import { makeEnvironmentShellState } from "./shell.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const LIVE_SHELL_SNAPSHOT: OrchestrationShellSnapshot = {
  snapshotSequence: 1,
  projects: [],
  threads: [],
  updatedAt: "2026-06-06T00:00:00.000Z",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function makeTestShellState(client: WsRpcProtocolClient) {
  return Effect.gen(function* () {
    const supervisorState = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
    const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
      Option.some(session(client)),
    );
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: supervisorState,
      session: activeSession,
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
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
      clear: () => Effect.void,
    });
    const shellState = yield* makeEnvironmentShellState().pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    );
    return { shellState, supervisorState };
  });
}

describe("environment shell synchronization", () => {
  it.effect("publishes live state before persistence and preserves it when ready", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const { shellState, supervisorState } = yield* makeTestShellState(client);

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

  it.effect("retries expected subscription failures and accepts the next live snapshot", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const attempts = yield* Ref.make(0);
      const client = {
        [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(attempts, (count) => count + 1).pipe(
              Effect.map((attempt) =>
                attempt === 0
                  ? Stream.fail(new Error("transient shell failure"))
                  : Stream.fromQueue(events),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { shellState } = yield* makeTestShellState(client);

      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => Option.isSome(state.error)),
        Stream.runHead,
      );
      const failedState = yield* SubscriptionRef.get(shellState);
      expect(failedState.status).toBe("empty");
      expect(Option.getOrThrow(failedState.error)).toBe("Could not synchronize environment data.");
      expect(yield* Ref.get(attempts)).toBe(1);

      yield* TestClock.adjust("250 millis");
      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshot: LIVE_SHELL_SNAPSHOT,
      });
      yield* SubscriptionRef.changes(shellState).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
      );

      const liveState = yield* SubscriptionRef.get(shellState);
      expect(yield* Ref.get(attempts)).toBe(2);
      expect(liveState.status).toBe("live");
      expect(liveState.error).toEqual(Option.none());
      expect(Option.getOrThrow(liveState.snapshot)).toEqual(LIVE_SHELL_SNAPSHOT);
    }),
  );
});
