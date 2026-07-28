import { EnvironmentId, WS_METHODS, type VcsListRefsResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { makeCachedVcsRefsChanges } from "./vcs.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_CONNECTION_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const CACHED_REFS: VcsListRefsResult = {
  refs: [
    {
      name: "main",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
};

const LIVE_REFS: VcsListRefsResult = {
  ...CACHED_REFS,
  refs: [
    {
      name: "release",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
};

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function cacheWithRefs(refs: Option.Option<VcsListRefsResult>) {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeed(Option.none()),
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(refs),
    saveVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
}

describe("cached VCS refs", () => {
  it.effect("loads an unfiltered branch list without a connection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.none<RpcSession>()),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const refs = yield* Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(
              Persistence.EnvironmentCacheStore,
              cacheWithRefs(Option.some(CACHED_REFS)),
            ),
          ),
        ).pipe(Stream.runHead);

        expect(Option.getOrThrow(refs)).toEqual(CACHED_REFS);
      }),
    ),
  );

  it.effect("retries a transient live failure while connected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expectedError = new Error("Could not list Git refs.");
        const calls = yield* Ref.make(0);
        const connectionState = yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE);
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1 ? Effect.fail(expectedError) : Effect.succeed(LIVE_REFS),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: connectionState,
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

        const result = Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        ).pipe(Stream.runHead);
        const fiber = yield* Effect.forkChild(result);

        for (let attempt = 0; attempt < 100 && (yield* Ref.get(calls)) < 1; attempt += 1) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(calls)).toBe(1);

        yield* TestClock.adjust("1 second");
        expect(Option.getOrThrow(yield* Fiber.join(fiber))).toEqual(LIVE_REFS);
        expect(yield* Ref.get(calls)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("cancels an in-flight refresh when the connection generation changes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const interruptions = yield* Ref.make(0);
        const connectionState = yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE);
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.updateAndGet(calls, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.never.pipe(
                      Effect.onInterrupt(() =>
                        Ref.update(interruptions, (interruptions) => interruptions + 1),
                      ),
                    )
                  : Effect.succeed(LIVE_REFS),
              ),
            ),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: connectionState,
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

        const result = Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        ).pipe(Stream.runHead);
        const fiber = yield* Effect.forkChild(result);

        for (let attempt = 0; attempt < 100 && (yield* Ref.get(calls)) < 1; attempt += 1) {
          yield* Effect.yieldNow;
        }
        yield* SubscriptionRef.set(connectionState, AVAILABLE_CONNECTION_STATE);
        for (let attempt = 0; attempt < 100 && (yield* Ref.get(interruptions)) < 1; attempt += 1) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(interruptions)).toBe(1);

        yield* SubscriptionRef.set(connectionState, {
          ...CONNECTED_CONNECTION_STATE,
          generation: 2,
        });
        expect(Option.getOrThrow(yield* Fiber.join(fiber))).toEqual(LIVE_REFS);
        expect(yield* Ref.get(calls)).toBe(2);
      }),
    ),
  );

  it.effect("does not poll refs while the connection remains stable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0);
        const client = {
          [WS_METHODS.vcsListRefs]: () =>
            Ref.update(calls, (count) => count + 1).pipe(Effect.as(CACHED_REFS)),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
        const stream = Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cacheWithRefs(Option.none())),
          ),
        ).pipe(Stream.runDrain);
        const fiber = yield* Effect.forkChild(stream);

        for (let attempt = 0; attempt < 100 && (yield* Ref.get(calls)) < 1; attempt += 1) {
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(calls)).toBe(1);

        yield* TestClock.adjust("1 minute");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(calls)).toBe(1);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("emits persisted refs before a live refresh", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = {
          [WS_METHODS.vcsListRefs]: () => Effect.succeed(LIVE_REFS),
        } as unknown as WsRpcProtocolClient;
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session(client))),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);

        const refs = yield* Stream.unwrap(
          makeCachedVcsRefsChanges({ cwd: "/repo", limit: 100 }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(
              Persistence.EnvironmentCacheStore,
              cacheWithRefs(Option.some(CACHED_REFS)),
            ),
          ),
        ).pipe(Stream.take(2), Stream.runCollect);

        expect(refs).toEqual([CACHED_REFS, LIVE_REFS]);
      }),
    ),
  );
});
