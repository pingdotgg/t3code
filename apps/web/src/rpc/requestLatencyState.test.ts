import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  ThreadId,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  RpcPermissionGuard,
  type RpcSession,
  type WsRpcProtocolClient,
  requestGuarded,
} from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { layer as connectionPlatformLayer } from "../connection/platform";
import { type SlowRpcAckRequest, subscribeSlowRpcAckRequests } from "./requestLatencyState";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const THREAD_ID = ThreadId.make("thread-1");

const makeSupervisor = Effect.fn("TestRequestLatency.makeSupervisor")(function* () {
  // The server never acks, as when another write holds the SQLite writer.
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: () => Effect.never,
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
});

const slowRequestsAfterUnackedDispatch = Effect.fn("TestRequestLatency.slowRequests")(function* (
  command: OrchestrationV2Command,
) {
  let slowRequests: ReadonlyArray<SlowRpcAckRequest> = [];
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      subscribeSlowRpcAckRequests((requests) => {
        slowRequests = requests;
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      vi.useFakeTimers();
      // The platform layer reads `window.desktopBridge`; absent means the browser build.
      vi.stubGlobal("window", {});
    }),
    () =>
      Effect.sync(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }),
  );
  const supervisor = yield* makeSupervisor();
  yield* requestGuarded(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
    Effect.provide(connectionPlatformLayer),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* Effect.promise(() => vi.advanceTimersByTimeAsync(20_000));
  return slowRequests;
});

describe("slow RPC ack tracking", () => {
  it.effect("never reports a thread visit dispatch as slow, however late its ack", () =>
    Effect.gen(function* () {
      const slowRequests = yield* slowRequestsAfterUnackedDispatch({
        type: "thread.visit",
        commandId: CommandId.make("command-visit"),
        threadId: THREAD_ID,
        visitedAt: "2026-11-03T00:00:00.000Z",
        opened: true,
      });

      expect(slowRequests.map((request) => request.tag)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("still reports other dispatched commands the user waits on", () =>
    Effect.gen(function* () {
      const slowRequests = yield* slowRequestsAfterUnackedDispatch({
        type: "thread.mark-unread",
        commandId: CommandId.make("command-mark-unread"),
        threadId: THREAD_ID,
      });

      expect(slowRequests.map((request) => request.tag)).toEqual([
        `${ORCHESTRATION_V2_WS_METHODS.dispatchCommand} · ${TARGET.label}`,
      ]);
    }).pipe(Effect.scoped),
  );
});
