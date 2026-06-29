import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
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
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { makeEnvironmentThreadState } from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

describe("V2 thread synchronization", () => {
  it.effect("applies a snapshot followed by committed projection events", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const rpcSession: RpcSession.RpcSession = {
        client,
        initialConfig: Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(rpcSession)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        clear: () => Effect.void,
      });
      const state = yield* makeEnvironmentThreadState(v2ThreadId).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );

      yield* Queue.offer(events, {
        kind: "snapshot",
        snapshotSequence: 1,
        projection: v2Projection,
      });
      yield* SubscriptionRef.changes(state).pipe(
        Stream.filter((current) => current.status === "live"),
        Stream.runHead,
      );

      const occurredAt = DateTime.makeUnsafe("2026-06-20T02:00:00.000Z");
      yield* Queue.offer(events, {
        kind: "event",
        sequence: 2,
        event: {
          id: EventId.make("event-title"),
          type: "thread.metadata-updated",
          threadId: v2ThreadId,
          occurredAt,
          payload: { ...v2Projection.thread, title: "Updated", updatedAt: occurredAt },
        },
      });
      yield* SubscriptionRef.changes(state).pipe(
        Stream.filter((current) => Option.getOrNull(current.data)?.thread.title === "Updated"),
        Stream.runHead,
      );

      expect(Option.getOrThrow((yield* SubscriptionRef.get(state)).data).thread.title).toBe(
        "Updated",
      );
    }),
  );
});
