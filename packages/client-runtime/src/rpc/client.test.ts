import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  PreviewTabId,
  ThreadId,
  type PreviewAutomationStreamEvent,
  type RelayClientInstallProgressEvent,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  EnvironmentRpcRequestObserver,
  request,
  runStream,
  subscribe,
  subscribeDynamicUntilComplete,
  subscribeDynamicUntilCompleteWithSuspensions,
  subscribeDynamicWithSession,
} from "./client.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INSTALL_CHECKING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "checking",
};
const INSTALL_DOWNLOADING: RelayClientInstallProgressEvent = {
  type: "progress",
  stage: "downloading",
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("environment RPC", () => {
  it.effect("registers a fresh preview host after completion without replaying requests", () =>
    Effect.gen(function* () {
      const firstCompleted = yield* Deferred.make<void>();
      const reconnected = yield* Deferred.make<void>();
      const requests: string[] = [];
      const connections: string[] = [];
      let attempts = 0;
      const client = {
        [WS_METHODS.previewAutomationConnect]: () =>
          Stream.suspend(() => {
            attempts += 1;
            const connected: PreviewAutomationStreamEvent = {
              type: "connected",
              connectionId: `connection-${attempts}`,
            };
            return attempts === 1
              ? Stream.make(connected, {
                  type: "request",
                  connectionId: connected.connectionId,
                  request: {
                    requestId: "timed-out-action",
                    operation: "click",
                    threadId: ThreadId.make("thread-1"),
                    tabId: PreviewTabId.make("tab-1"),
                    input: {},
                    timeoutMs: 1_000,
                  },
                } satisfies PreviewAutomationStreamEvent).pipe(
                  Stream.ensuring(Deferred.succeed(firstCompleted, undefined)),
                )
              : Stream.succeed(connected).pipe(Stream.concat(Stream.never));
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
        clientId: "preview-host",
        environmentId: TARGET.environmentId,
      }).pipe(
        Stream.runForEach((event) => {
          if (event.type === "request") {
            requests.push(event.request.requestId);
            return Effect.void;
          }
          connections.push(event.connectionId);
          return connections.length === 2 ? Deferred.succeed(reconnected, undefined) : Effect.void;
        }),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstCompleted);
      yield* TestClock.adjust(999);
      expect(attempts).toBe(1);
      yield* TestClock.adjust(1);
      expect(attempts).toBe(2);
      yield* Deferred.await(reconnected);
      expect(connections).toEqual(["connection-1", "connection-2"]);
      expect(requests).toEqual(["timed-out-action"]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("does not re-register an unmounted preview host during the recovery delay", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<void>();
      let attempts = 0;
      const client = {
        [WS_METHODS.previewAutomationConnect]: () =>
          Stream.suspend(() => {
            attempts += 1;
            return Stream.empty.pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
        clientId: "preview-host",
        environmentId: TARGET.environmentId,
      }).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(completed);
      yield* Fiber.interrupt(consumer);
      yield* TestClock.adjust(10_000);
      expect(attempts).toBe(1);
    }),
  );

  it.effect.each(["completion", "transport failure"] as const)(
    "keeps preview recovery tied to the active session after %s",
    (reason) =>
      Effect.gen(function* () {
        const completed = yield* Deferred.make<void>();
        const nextConnected = yield* Deferred.make<void>();
        let oldAttempts = 0;
        let nextAttempts = 0;
        const firstClient = {
          [WS_METHODS.previewAutomationConnect]: () =>
            Stream.suspend(() => {
              oldAttempts += 1;
              return (
                reason === "completion"
                  ? Stream.empty
                  : Stream.fail(
                      new RpcClientError.RpcClientError({
                        reason: new RpcClientError.RpcClientDefect({
                          message: "socket closed",
                          cause: new Error("socket closed"),
                        }),
                      }),
                    )
              ).pipe(Stream.ensuring(Deferred.succeed(completed, undefined)));
            }),
        } as unknown as WsRpcProtocolClient;
        const nextClient = {
          [WS_METHODS.previewAutomationConnect]: () =>
            Stream.suspend(() => {
              nextAttempts += 1;
              return Stream.fromEffect(Deferred.succeed(nextConnected, undefined)).pipe(
                Stream.drain,
                Stream.concat(Stream.never),
              );
            }),
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();
        yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
        const consumer = yield* subscribe(WS_METHODS.previewAutomationConnect, {
          clientId: "preview-host",
          environmentId: TARGET.environmentId,
        }).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(completed);
        if (reason === "transport failure") {
          yield* TestClock.adjust(10_000);
          expect(oldAttempts).toBe(1);
        }
        yield* SubscriptionRef.set(activeSession, Option.some(session(nextClient)));
        yield* Deferred.await(nextConnected);
        yield* TestClock.adjust(10_000);
        expect(oldAttempts).toBe(1);
        expect(nextAttempts).toBe(1);
        yield* Fiber.interrupt(consumer);
      }),
  );

  it.effect("reuses the session config stream instead of opening a duplicate subscription", () =>
    Effect.gen(function* () {
      const event: ServerConfigStreamEvent = {
        version: 1,
        type: "settingsUpdated",
        payload: { settings: DEFAULT_SERVER_SETTINGS },
      };
      let duplicateSubscriptions = 0;
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => {
          duplicateSubscriptions += 1;
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some({
          ...session(client),
          subscribeServerConfig: () => Stream.succeed(event),
        }),
      );

      const received = yield* subscribe(WS_METHODS.subscribeServerConfig, {}).pipe(
        Stream.runHead,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(received).toEqual(Option.some(event));
      expect(duplicateSubscriptions).toBe(0);
    }),
  );

  it.effect("observes unary requests until they complete", () =>
    Effect.gen(function* () {
      const observations: string[] = [];
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed({ status: "available", version: "2026.6.0" }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.cloudGetRelayClientStatus, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(
          EnvironmentRpcRequestObserver,
          EnvironmentRpcRequestObserver.of({
            observe: ({ environmentId, method }) =>
              Effect.sync(() => {
                observations.push(`start:${environmentId}:${method}`);
                return Effect.sync(() => {
                  observations.push(`finish:${environmentId}:${method}`);
                });
              }),
          }),
        ),
      );

      expect(result).toEqual({ status: "available", version: "2026.6.0" });
      expect(observations).toEqual([
        `start:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
        `finish:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
      ]);
    }),
  );

  it.effect("binds finite streaming commands to one active session", () =>
    Effect.gen(function* () {
      const firstEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const secondEvents = yield* Queue.unbounded<RelayClientInstallProgressEvent>();
      const firstClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(firstEvents),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.cloudInstallRelayClient]: () => Stream.fromQueue(secondEvents),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* Queue.offer(firstEvents, INSTALL_CHECKING);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Queue.offer(secondEvents, INSTALL_DOWNLOADING);
      yield* Queue.offer(firstEvents, INSTALL_DOWNLOADING);

      expect(yield* Fiber.join(resultFiber)).toEqual([INSTALL_CHECKING, INSTALL_DOWNLOADING]);
    }),
  );

  it.effect("switches durable subscriptions when the supervisor replaces the session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();
      const awaitSubscriptions = Effect.fn("TestEnvironmentRpc.awaitSubscriptions")(function* (
        count: number,
      ) {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (subscriptions.length >= count) {
            return;
          }
          yield* Effect.yieldNow;
        }
        return yield* Effect.die(new Error(`Expected ${count} durable subscriptions.`));
      });

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      yield* awaitSubscriptions(1);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* awaitSubscriptions(2);
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps the producer session on an old value buffered across a session switch", () =>
    Effect.gen(function* () {
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const firstValueBlocked = yield* Deferred.make<void>();
      const releaseFirstValue = yield* Deferred.make<void>();
      const firstValue = { source: "first", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const bufferedFirstValue = {
        source: "first",
        index: 2,
      } as unknown as ServerLifecycleStreamEvent;
      const secondValue = { source: "second", index: 1 } as unknown as ServerLifecycleStreamEvent;
      const firstClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(firstSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromIterable([firstValue, bufferedFirstValue])),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeServerLifecycle]: () =>
          Stream.fromEffect(Deferred.succeed(secondSubscribed, undefined)).pipe(
            Stream.drain,
            Stream.concat(Stream.make(secondValue)),
            Stream.concat(Stream.never),
          ),
      } as unknown as WsRpcProtocolClient;
      const firstSession = session(firstClient);
      const secondSession = session(secondClient);
      const { activeSession, supervisor } = yield* makeHarness();

      const resultFiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeServerLifecycle,
        () => Effect.succeed({}),
      ).pipe(
        Stream.mapEffect(([producerSession, value]) =>
          value === firstValue
            ? Deferred.succeed(firstValueBlocked, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstValue)),
                Effect.as([producerSession, value] as const),
              )
            : Effect.succeed([producerSession, value] as const),
        ),
        Stream.take(3),
        Stream.runCollect,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* Deferred.await(firstSubscribed);
      yield* Deferred.await(firstValueBlocked);
      yield* SubscriptionRef.set(activeSession, Option.some(secondSession));
      yield* Deferred.await(secondSubscribed);
      yield* Deferred.succeed(releaseFirstValue, undefined);

      const result = yield* Fiber.join(resultFiber);
      expect(result).toEqual([
        [firstSession, firstValue],
        [firstSession, bufferedFirstValue],
        [secondSession, secondValue],
      ]);
    }),
  );

  it.effect("keeps durable subscriptions alive across a transport failure and new session", () =>
    Effect.gen(function* () {
      const subscriptions: string[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(
            new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            }),
          );
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      const subscriptionFiber = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  describe("subscribeDynamicUntilComplete", () => {
    const transportFailure = () =>
      new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "socket closed",
          cause: new Error("socket closed"),
        }),
      });
    const extensionClient = (
      open: (options: unknown) => Stream.Stream<string, unknown>,
    ): WsRpcProtocolClient =>
      ({
        [WS_METHODS.subscribeExtensionApi]: (_input: unknown, options: unknown) => open(options),
      }) as unknown as WsRpcProtocolClient;
    const run = Effect.fn("TestEnvironmentRpc.runUntilComplete")(function* (
      supervisor: EnvironmentSupervisor.EnvironmentSupervisor["Service"],
      inputs: Ref.Ref<number>,
      received: Ref.Ref<ReadonlyArray<string>>,
    ) {
      return yield* subscribeDynamicUntilComplete(
        WS_METHODS.subscribeExtensionApi,
        () => Ref.updateAndGet(inputs, (count) => count + 1) as never,
        { streamBufferSize: 1 },
      ).pipe(
        Stream.runForEach((value) =>
          Ref.update(received, (values) => [...values, value as unknown as string]),
        ),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
    });
    const awaitCount = Effect.fn("TestEnvironmentRpc.awaitCount")(function* (
      ref: Ref.Ref<ReadonlyArray<string>>,
      count: number,
    ) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(ref)).length >= count) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error(`Expected ${count} values.`));
    });

    it.effect("resubscribes on the next session after a transport failure", () =>
      Effect.gen(function* () {
        const bufferSizes: unknown[] = [];
        const { activeSession, retryCount, supervisor } = yield* makeHarness();
        const inputs = yield* Ref.make(0);
        const received = yield* Ref.make<ReadonlyArray<string>>([]);
        const fiber = yield* run(supervisor, inputs, received);
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(
            session(
              extensionClient((options) => {
                bufferSizes.push(options);
                return Stream.concat(
                  Stream.succeed("before drop"),
                  Stream.fail(transportFailure()),
                );
              }),
            ),
          ),
        );
        yield* awaitCount(received, 1);
        yield* SubscriptionRef.set(activeSession, Option.none());
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(
            session(
              extensionClient((options) => {
                bufferSizes.push(options);
                return Stream.concat(Stream.succeed("recovered"), Stream.never);
              }),
            ),
          ),
        );
        yield* awaitCount(received, 2);

        expect(yield* Ref.get(received)).toEqual(["before drop", "recovered"]);
        // One payload per session, so session-bound hints are rebuilt.
        expect(yield* Ref.get(inputs)).toBe(2);
        expect(bufferSizes).toEqual([{ streamBufferSize: 1 }, { streamBufferSize: 1 }]);
        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(fiber);
        expect(yield* Ref.get(retryCount)).toBe(0);
      }),
    );

    it.effect("reports each suspension in order with the frames delivered before it", () =>
      Effect.gen(function* () {
        const { activeSession, supervisor } = yield* makeHarness();
        const received = yield* Ref.make<ReadonlyArray<string>>([]);
        const fiber = yield* subscribeDynamicUntilCompleteWithSuspensions(
          WS_METHODS.subscribeExtensionApi,
          () => Effect.succeed({}) as never,
          { streamBufferSize: 1 },
        ).pipe(
          Stream.runForEach((value) =>
            Ref.update(received, (values) => [
              ...values,
              Option.match(value, {
                onNone: () => "suspended",
                onSome: (frame) => frame as unknown as string,
              }),
            ]),
          ),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        const opens = (frames: Stream.Stream<string, unknown>) =>
          Option.some(session(extensionClient(() => frames)));
        yield* SubscriptionRef.set(
          activeSession,
          opens(Stream.concat(Stream.make("first", "buffered"), Stream.fail(transportFailure()))),
        );
        yield* awaitCount(received, 3);
        yield* SubscriptionRef.set(activeSession, Option.none());
        yield* awaitCount(received, 4);
        yield* SubscriptionRef.set(
          activeSession,
          opens(Stream.concat(Stream.succeed("second"), Stream.never)),
        );
        yield* awaitCount(received, 5);
        yield* Fiber.interrupt(fiber);

        // The dropped transport, then the ended session; each after the
        // frames that were already on their way.
        expect(yield* Ref.get(received)).toEqual([
          "first",
          "buffered",
          "suspended",
          "suspended",
          "second",
        ]);
      }),
    );

    it.effect("suspends when the closing session interrupts the stream, then resumes", () =>
      Effect.gen(function* () {
        const { activeSession, supervisor } = yield* makeHarness();
        const received = yield* Ref.make<ReadonlyArray<string>>([]);
        const fiber = yield* subscribeDynamicUntilCompleteWithSuspensions(
          WS_METHODS.subscribeExtensionApi,
          () => Effect.succeed({}) as never,
          { streamBufferSize: 1 },
        ).pipe(
          Stream.runForEach((value) =>
            Ref.update(received, (values) => [
              ...values,
              Option.match(value, {
                onNone: () => "suspended",
                onSome: (frame) => frame as unknown as string,
              }),
            ]),
          ),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        const opens = (frames: Stream.Stream<string, unknown>) =>
          Option.some(session(extensionClient(() => frames)));
        // The RPC client fails its open streams with an interrupt when the
        // dropped session's scope closes, before the supervisor clears it.
        yield* SubscriptionRef.set(
          activeSession,
          opens(Stream.concat(Stream.succeed("first"), Stream.failCause(Cause.interrupt(1)))),
        );
        yield* awaitCount(received, 2);
        yield* SubscriptionRef.set(activeSession, Option.none());
        yield* SubscriptionRef.set(
          activeSession,
          opens(Stream.concat(Stream.succeed("second"), Stream.never)),
        );
        for (let attempt = 0; (yield* Ref.get(received)).at(-1) !== "second"; attempt += 1) {
          if (attempt === 100) return yield* Effect.die(new Error("Expected a resumed frame."));
          yield* Effect.yieldNow;
        }

        expect(fiber.pollUnsafe()).toBeUndefined();
        yield* Fiber.interrupt(fiber);
        // One suspension per outage signal; the ended session may add a second.
        expect(
          (yield* Ref.get(received)).filter((value, index, all) => value !== all[index - 1]),
        ).toEqual(["first", "suspended", "second"]);
      }),
    );

    it.effect("switches to exactly one fresh subscription when the session is replaced", () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const { activeSession, supervisor } = yield* makeHarness();
        const inputs = yield* Ref.make(0);
        const received = yield* Ref.make<ReadonlyArray<string>>([]);
        const fiber = yield* run(supervisor, inputs, received);
        const live = (name: string) =>
          session(
            extensionClient(() => {
              events.push(`open ${name}`);
              return Stream.concat(Stream.succeed(name), Stream.never).pipe(
                Stream.ensuring(Effect.sync(() => events.push(`close ${name}`))),
              );
            }),
          );
        yield* SubscriptionRef.set(activeSession, Option.some(live("first")));
        yield* awaitCount(received, 1);
        yield* SubscriptionRef.set(activeSession, Option.some(live("second")));
        yield* awaitCount(received, 2);
        yield* Fiber.interrupt(fiber);

        expect(yield* Ref.get(received)).toEqual(["first", "second"]);
        expect(events.slice(0, 3)).toEqual(["open first", "close first", "open second"]);
      }),
    );

    it.effect("ends when the source completes instead of waiting for another session", () =>
      Effect.gen(function* () {
        let opened = 0;
        const { activeSession, supervisor } = yield* makeHarness();
        const inputs = yield* Ref.make(0);
        const received = yield* Ref.make<ReadonlyArray<string>>([]);
        const fiber = yield* run(supervisor, inputs, received);
        const finite = session(
          extensionClient(() => {
            opened += 1;
            return Stream.succeed("last");
          }),
        );
        yield* SubscriptionRef.set(activeSession, Option.some(finite));
        const exit = yield* Fiber.await(fiber);
        yield* SubscriptionRef.set(activeSession, Option.some(finite));

        expect(Exit.isSuccess(exit)).toBe(true);
        expect(yield* Ref.get(received)).toEqual(["last"]);
        expect(opened).toBe(1);
      }),
    );

    it.effect("a paused consumer bounds the session switch like the delivery window", () =>
      Effect.gen(function* () {
        let produced = 0;
        const { activeSession, supervisor } = yield* makeHarness();
        const delivered = yield* Deferred.make<void>();
        const paused = yield* Deferred.make<void>();
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(
            session(
              extensionClient(() =>
                // A source that produces as fast as it is pulled, with no RPC
                // window of its own: only the switch's queue can hold frames.
                Stream.forever(Stream.fromEffect(Effect.sync(() => `frame ${(produced += 1)}`))),
              ),
            ),
          ),
        );
        const fiber = yield* subscribeDynamicUntilComplete(
          WS_METHODS.subscribeExtensionApi,
          () => Effect.succeed({}) as never,
          { streamBufferSize: 1 },
        ).pipe(
          Stream.runForEach(() =>
            Deferred.succeed(delivered, undefined).pipe(Effect.andThen(Deferred.await(paused))),
          ),
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(delivered);
        for (let attempt = 0; attempt < 200; attempt += 1) yield* Effect.yieldNow;

        // One delivered, one in the switch's queue, one awaiting admission —
        // not the 16-frame default queue.
        expect(produced).toBeLessThanOrEqual(3);
        yield* Fiber.interrupt(fiber);
      }),
    );

    it.effect("fails on a domain error without resubscribing", () =>
      Effect.gen(function* () {
        const domainError = new Error("stream refused");
        let opened = 0;
        const { activeSession, supervisor } = yield* makeHarness();
        const inputs = yield* Ref.make(0);
        const received = yield* Ref.make<ReadonlyArray<string>>([]);
        const fiber = yield* run(supervisor, inputs, received);
        yield* SubscriptionRef.set(
          activeSession,
          Option.some(
            session(
              extensionClient(() => {
                opened += 1;
                return Stream.fail(domainError);
              }),
            ),
          ),
        );
        const exit = yield* Fiber.await(fiber);

        expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBe(domainError);
        expect(opened).toBe(1);
      }),
    );
  });

  it.effect("surfaces domain subscription failures without reconnecting", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.fail(domainError),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const error = yield* subscribe(WS_METHODS.subscribeTerminalEvents, {}).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error).toBe(domainError);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("keeps handled domain failures dormant until a replacement session arrives", () =>
    Effect.gen(function* () {
      const domainError = new Error("terminal subscription rejected");
      const subscriptions: string[] = [];
      const observedFailures: Error[] = [];
      const firstClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("first");
          return Stream.fail(domainError);
        },
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          subscriptions.push("second");
          return Stream.never;
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: (cause) =>
            Effect.sync(() => {
              observedFailures.push(Cause.squash(cause) as Error);
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100 && observedFailures.length < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(subscriptions).toEqual(["first"]);
      expect(observedFailures).toEqual([domainError]);

      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      for (let attempt = 0; attempt < 100 && subscriptions.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(subscriptions).toEqual(["first", "second"]);
      expect(yield* Ref.get(retryCount)).toBe(0);
    }),
  );

  it.effect("retries handled domain failures within the same session when configured", () =>
    Effect.gen(function* () {
      const domainError = new Error("thread not found yet");
      const subscriptionCount = yield* Ref.make(0);
      const expectedFailureCount = yield* Ref.make(0);
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () =>
          Stream.unwrap(
            Ref.getAndUpdate(subscriptionCount, (count) => count + 1).pipe(
              Effect.map((count) => (count === 0 ? Stream.fail(domainError) : Stream.never)),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const subscriptionFiber = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () => Ref.update(expectedFailureCount, (count) => count + 1),
          retryExpectedFailureAfter: "100 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(expectedFailureCount)) >= 1) {
          break;
        }
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(subscriptionCount)).toBe(1);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);

      yield* TestClock.adjust("100 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(subscriptionFiber);

      expect(yield* Ref.get(subscriptionCount)).toBe(2);
      expect(yield* Ref.get(expectedFailureCount)).toBe(1);
    }),
  );

  it.effect.each(["input", "stream"] as const)(
    "does not classify %s subscription defects as expected failures",
    (where) =>
      Effect.gen(function* () {
        const defect = new Error("subscription invariant failed");
        let expectedFailureCount = 0;
        let inputs = 0;
        let streams = 0;
        const observedDefects: unknown[] = [];
        const client = {
          [WS_METHODS.subscribeTerminalEvents]: () => {
            streams += 1;
            return where === "stream" ? Stream.die(defect) : Stream.never;
          },
        } as unknown as WsRpcProtocolClient;
        const { activeSession, supervisor } = yield* makeHarness();

        yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
        const exit = yield* subscribeDynamicWithSession(
          WS_METHODS.subscribeTerminalEvents,
          () =>
            Effect.sync(() => {
              inputs += 1;
            }).pipe(Effect.andThen(where === "input" ? Effect.die(defect) : Effect.succeed({}))),
          {
            onDefect: (cause) =>
              Effect.sync(() => {
                observedDefects.push(Cause.squash(cause));
              }),
            onExpectedFailure: () =>
              Effect.sync(() => {
                expectedFailureCount += 1;
              }),
            retryExpectedFailureAfter: "250 millis",
          },
        ).pipe(
          Stream.runDrain,
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasDies(exit.cause)).toBe(true);
          expect(Cause.squash(exit.cause)).toBe(defect);
        }
        expect(inputs).toBe(1);
        expect(streams).toBe(where === "input" ? 0 : 1);
        expect(expectedFailureCount).toBe(0);
        expect(observedDefects).toEqual([defect]);
      }),
  );

  it.effect("reports an initializer defect once after an expected failure retries", () =>
    Effect.gen(function* () {
      const defect = new Error("Synthetic retry initializer defect");
      const expectedFailure = yield* Deferred.make<void>();
      const observations: string[] = [];
      const observedDefects: unknown[] = [];
      let inputs = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => {
          observations.push("stream");
          return Stream.fail(new Error("subscription not ready"));
        },
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const fiber = yield* subscribeDynamicWithSession(
        WS_METHODS.subscribeTerminalEvents,
        () =>
          Effect.sync(() => {
            inputs += 1;
            observations.push(`input ${inputs}`);
            return inputs;
          }).pipe(
            Effect.flatMap((attempt) => (attempt === 1 ? Effect.succeed({}) : Effect.die(defect))),
          ),
        {
          onDefect: (cause) =>
            Effect.sync(() => {
              observations.push("defect");
              observedDefects.push(Cause.squash(cause));
            }),
          onExpectedFailure: () =>
            Effect.sync(() => {
              observations.push("expected failure");
            }).pipe(Effect.andThen(Deferred.succeed(expectedFailure, undefined)), Effect.asVoid),
          retryExpectedFailureAfter: "250 millis",
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(expectedFailure);
      yield* TestClock.adjust("250 millis");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        expect(Cause.squash(exit.cause)).toBe(defect);
      }
      expect(observations).toEqual(["input 1", "stream", "expected failure", "input 2", "defect"]);
      expect(observedDefects).toEqual([defect]);
    }),
  );
});
