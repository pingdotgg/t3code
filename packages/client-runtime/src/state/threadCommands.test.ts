import {
  CommandId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import { archiveThreadAndEvictCache } from "./threadCommands.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const THREAD_ID = ThreadId.make("thread-1");
const TARGET = new PrimaryConnectionTarget({
  environmentId: ENVIRONMENT_ID,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const makeSupervisor = Effect.fn("TestThreadCommands.makeSupervisor")(function* (
  client: WsRpcProtocolClient,
) {
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

function makeCache(
  removeThread: Persistence.EnvironmentCacheStore["Service"]["removeThread"],
): Persistence.EnvironmentCacheStore["Service"] {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
}

describe("thread commands", () => {
  it.effect("evicts cached detail after the archive acknowledgement", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const acknowledged = yield* Deferred.make<void>();
      const dispatched = yield* Ref.make<ClientOrchestrationCommand[]>([]);
      const removals = yield* Ref.make<Array<readonly [EnvironmentId, ThreadId]>>([]);
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Ref.update(dispatched, (commands) => [...commands, command]).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(acknowledged)),
            Effect.as({ sequence: 1 }),
          ),
      } as unknown as WsRpcProtocolClient;
      const supervisor = yield* makeSupervisor(client);
      const cache = makeCache((environmentId, threadId) =>
        Ref.update(removals, (entries) => [...entries, [environmentId, threadId] as const]),
      );

      const archive = yield* archiveThreadAndEvictCache({
        commandId: CommandId.make("archive-command"),
        threadId: THREAD_ID,
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        Effect.forkChild({ startImmediately: true }),
      );

      yield* Deferred.await(started);
      expect(yield* Ref.get(removals)).toEqual([]);

      yield* Deferred.succeed(acknowledged, undefined);
      expect(yield* Fiber.join(archive)).toEqual({ sequence: 1 });
      expect(yield* Ref.get(removals)).toEqual([[ENVIRONMENT_ID, THREAD_ID]]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("keeps a successful archive successful when cache eviction fails", () =>
    Effect.gen(function* () {
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (_command: ClientOrchestrationCommand) =>
          Effect.succeed({ sequence: 1 }),
      } as unknown as WsRpcProtocolClient;
      const supervisor = yield* makeSupervisor(client);
      const cache = makeCache(() =>
        Effect.fail(
          new Persistence.ConnectionPersistenceError({
            operation: "remove-thread",
            message: "IndexedDB unavailable",
          }),
        ),
      );

      const result = yield* archiveThreadAndEvictCache({
        commandId: CommandId.make("archive-command"),
        threadId: THREAD_ID,
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      );

      expect(result).toEqual({ sequence: 1 });
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
