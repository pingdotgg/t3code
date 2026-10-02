import {
  EnvironmentId,
  CommandId,
  MessageId,
  PreviewTabId,
  ThreadId,
  ORCHESTRATION_WS_METHODS,
  type ServerConfig,
  type CapabilityClientOrchestrationCommand,
  type PreviewAutomationStreamEvent,
  type RelayClientInstallProgressEvent,
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
  requiredRpcCapabilities,
  runStream,
  subscribe,
} from "./client.ts";
import { TEST_SERVER_CONFIG } from "../../test/fixtures.ts";
import { EnvironmentRpcDiagnostics, type RpcDiagnostic } from "./diagnostics.ts";

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

function session(
  client: WsRpcProtocolClient,
  config: ServerConfig = TEST_SERVER_CONFIG,
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(config),
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
  it.effect("re-registers a completed preview host without replaying its timed-out action", () =>
    Effect.gen(function* () {
      const firstCompleted = yield* Deferred.make<void>();
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
          return Effect.void;
        }),
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* Deferred.await(firstCompleted);
      yield* TestClock.adjust("999 millis");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (attempts >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(attempts).toBe(2);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (connections.length >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(connections).toEqual(["connection-1", "connection-2"]);
      expect(requests).toEqual(["timed-out-action"]);
      yield* Fiber.interrupt(consumer);
    }),
  );

  it("preserves inline images and requires explicit capabilities for stored attachments", () => {
    const capabilitiesFor = (attachments: ReadonlyArray<unknown>) =>
      requiredRpcCapabilities(ORCHESTRATION_WS_METHODS.dispatchCommand, {
        type: "thread.turn.start",
        message: { attachments },
      });

    expect(capabilitiesFor([{ type: "image", dataUrl: "data:image/png;base64,AA==" }])).toEqual([]);
    expect(capabilitiesFor([{ type: "image", id: "image-1" }])).toEqual(["attachmentUploads"]);
    expect(capabilitiesFor([{ type: "file", id: "file-1" }])).toEqual([
      "attachmentUploads",
      "fileAttachments",
    ]);
    expect(
      requiredRpcCapabilities(WS_METHODS.assetsCreateUrl, {
        resource: { _tag: "native-app-icon" },
      }),
    ).toEqual(["nativeAppIcons"]);
  });

  it("gates new shared settings without blocking existing fork preferences", () => {
    expect(
      requiredRpcCapabilities(WS_METHODS.serverUpdateSettings, {
        patch: { sidebarAutoSettleAfterDays: 7 },
      }),
    ).toEqual(["threadAutoSettlement"]);
    expect(
      requiredRpcCapabilities(WS_METHODS.serverUpdateSettings, {
        patch: { autoArchiveSettledAfterDays: 2 },
      }),
    ).toEqual(["threadAutoSettlement"]);
    expect(
      requiredRpcCapabilities(WS_METHODS.serverUpdateSettings, {
        patch: { enableAssistantStreaming: false, defaultThreadEnvMode: "local" },
      }),
    ).toEqual([]);
  });

  it.effect("rejects optional methods before touching the wire when capability is absent", () =>
    Effect.gen(function* () {
      let calls = 0;
      let dispatches = 0;
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: () =>
          Effect.sync(() => {
            dispatches += 1;
            return { sequence: 7 };
          }),
        [WS_METHODS.attachmentsDelete]: () =>
          Effect.sync(() => {
            calls += 1;
            return { deleted: true };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const result = yield* request(WS_METHODS.attachmentsDelete, { attachmentId: "file-1" }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(result).toMatchObject({
        _tag: "EnvironmentRpcUnsupportedError",
        capability: "attachmentUploads",
      });
      expect(calls).toBe(0);
      const command: CapabilityClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-1"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "Inspect this file",
          attachments: [
            {
              type: "file",
              id: "file-1",
              name: "notes.txt",
              mimeType: "text/plain",
              sizeBytes: 12,
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      const dispatchFailure = yield* request(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(dispatchFailure).toMatchObject({
        _tag: "EnvironmentRpcUnsupportedError",
        capability: "attachmentUploads",
      });
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(
          session(client, {
            ...TEST_SERVER_CONFIG,
            environment: {
              ...TEST_SERVER_CONFIG.environment,
              capabilities: {
                ...TEST_SERVER_CONFIG.environment.capabilities,
                attachmentUploads: true,
              },
            },
          }),
        ),
      );
      yield* request(WS_METHODS.attachmentsDelete, { attachmentId: "file-1" }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(calls).toBe(1);
      const filesUnsupported = yield* request(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        command,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(filesUnsupported).toMatchObject({
        _tag: "EnvironmentRpcUnsupportedError",
        capability: "fileAttachments",
      });
      expect(dispatches).toBe(0);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(
          session(client, {
            ...TEST_SERVER_CONFIG,
            environment: {
              ...TEST_SERVER_CONFIG.environment,
              capabilities: {
                ...TEST_SERVER_CONFIG.environment.capabilities,
                attachmentUploads: true,
                fileAttachments: { maxUploadBytes: 1024 },
              },
            },
          }),
        ),
      );
      yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, command).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );
      expect(dispatches).toBe(1);
    }),
  );
  it.effect("observes unary requests until they complete", () =>
    Effect.gen(function* () {
      const observations: string[] = [];
      const diagnosticEvents: RpcDiagnostic[] = [];
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed({ status: "available", version: "2026.6.0" }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const result = yield* request(WS_METHODS.cloudGetRelayClientStatus, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(EnvironmentRpcDiagnostics, {
          record: (event) =>
            Effect.sync(() => {
              diagnosticEvents.push(event);
            }),
        }),
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
      expect(diagnosticEvents.map((event) => event.phase)).toEqual(["started", "succeeded"]);
      expect(diagnosticEvents[1]).toMatchObject({
        environmentId: TARGET.environmentId,
        generation: 0,
        method: WS_METHODS.cloudGetRelayClientStatus,
        durationMs: 0,
      });
      expect(observations).toEqual([
        `start:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
        `finish:${TARGET.environmentId}:${WS_METHODS.cloudGetRelayClientStatus}`,
      ]);
    }),
  );

  it.effect("records a failed attempt with command identity even when no session exists", () =>
    Effect.gen(function* () {
      const events: RpcDiagnostic[] = [];
      const { supervisor } = yield* makeHarness();
      const command = {
        type: "thread.archive" as const,
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
      };
      yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, command).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(EnvironmentRpcDiagnostics, {
          record: (event) =>
            Effect.sync(() => {
              events.push(event);
            }),
        }),
        Effect.exit,
      );
      expect(events.map((event) => event.phase)).toEqual(["started", "failed"]);
      expect(events[1]).toMatchObject({ commandId: "queued-command", threadId: "thread-1" });
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

  it.effect("does not classify subscription defects as expected failures", () =>
    Effect.gen(function* () {
      const defect = new Error("subscription invariant failed");
      let expectedFailureCount = 0;
      const client = {
        [WS_METHODS.subscribeTerminalEvents]: () => Stream.die(defect),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));
      const exit = yield* subscribe(
        WS_METHODS.subscribeTerminalEvents,
        {},
        {
          onExpectedFailure: () =>
            Effect.sync(() => {
              expectedFailureCount += 1;
            }),
        },
      ).pipe(
        Stream.runDrain,
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
      expect(expectedFailureCount).toBe(0);
    }),
  );
});
