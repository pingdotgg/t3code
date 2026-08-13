import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  OrchestrationCommandDeduplicationWindowChangedError,
  ThreadId,
  type ClientOrchestrationCommand,
  type RelayClientInstallProgressEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  EnvironmentRpcRequestObserver,
  isRetryableRpcTransportError,
  request,
  requestIdempotent,
  requestSingleShot,
  runStream,
  subscribe,
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

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "connected",
  attempt: 1,
  generation: 1,
};

const BACKOFF_STATE: SupervisorConnectionState = {
  ...CONNECTED_STATE,
  phase: "backoff",
  generation: 1,
};

const TEST_COMMAND: ClientOrchestrationCommand = {
  type: "thread.archive",
  commandId: CommandId.make("command-reconnect"),
  threadId: ThreadId.make("thread-1"),
};

const TEST_BOOTSTRAP_COMMAND: ClientOrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("command-bootstrap-reconnect"),
  threadId: ThreadId.make("thread-bootstrap"),
  message: {
    messageId: MessageId.make("message-bootstrap"),
    role: "user",
    text: "hello",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: { runSetupScript: true },
  createdAt: "2026-08-12T00:00:00.000Z",
};

const socketCloseError = () =>
  new RpcClientError.RpcClientError({
    reason: new Socket.SocketCloseError({ code: 1006 }),
  });

function session(
  client: WsRpcProtocolClient,
  closed: RpcSession.RpcSession["closed"] = Effect.never,
  serverRunId?: string,
  initialConfigFailure?: ConnectionTransientError,
  probe: RpcSession.RpcSession["probe"] = Effect.void,
): RpcSession.RpcSession {
  return {
    client,
    initialConfig:
      initialConfigFailure !== undefined
        ? Effect.fail(initialConfigFailure)
        : serverRunId === undefined
          ? Effect.never
          : Effect.succeed({ serverRunId } as Effect.Success<
              RpcSession.RpcSession["initialConfig"]
            >),
    ready: Effect.void,
    probe,
    closed,
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
  it("classifies only socket transport failures as retryable", () => {
    const cause = new Error("transport failed");
    const retryable = [
      new Socket.SocketReadError({ cause }),
      new Socket.SocketWriteError({ cause }),
      new Socket.SocketOpenError({ kind: "Timeout", cause }),
      new Socket.SocketCloseError({ code: 1006 }),
    ].map((reason) => new RpcClientError.RpcClientError({ reason }));

    expect(retryable.every(isRetryableRpcTransportError)).toBe(true);
    expect(
      isRetryableRpcTransportError(
        new RpcClientError.RpcClientError({
          reason: new RpcClientError.RpcClientDefect({ message: "bad response", cause }),
        }),
      ),
    ).toBe(false);
    expect(isRetryableRpcTransportError(new Error("domain failure"))).toBe(false);
  });

  it.effect("replays an idempotent request on a replacement session with the same input", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.fail(socketCloseError()))),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 42 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      const firstSession = session(firstClient);
      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_COMMAND,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      for (let attempt = 0; attempt < 100 && (yield* Ref.get(retryCount)) < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(supervisor.state, BACKOFF_STATE);
      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 42 });
      expect(yield* Ref.get(retryCount)).toBe(1);
      expect(received).toHaveLength(2);
      expect(received[0]).toBe(TEST_COMMAND);
      expect(received[1]).toBe(TEST_COMMAND);
    }),
  );

  it.effect("replays when a closed session leaves the unary request pending", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const firstClosed = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 43 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      const firstSession = session(
        firstClient,
        firstClosed.await.pipe(
          Effect.andThen(
            Effect.fail(
              new ConnectionTransientError({
                reason: "transport",
                detail: "Test environment disconnected.",
              }),
            ),
          ),
        ),
      );
      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_COMMAND,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      firstClosed.openUnsafe();
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(supervisor.state, BACKOFF_STATE);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 43 });
      expect(received).toHaveLength(2);
      expect(received[0]).toBe(TEST_COMMAND);
      expect(received[1]).toBe(TEST_COMMAND);
    }),
  );

  it.effect("keeps a healthy lease for process-local work beyond the initial timeout", () =>
    Effect.gen(function* () {
      const attempted = Latch.makeUnsafe();
      const response = yield* Latch.make();
      const received: ClientOrchestrationCommand[] = [];
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            attempted.openUnsafe();
          }).pipe(Effect.andThen(response.await), Effect.as({ sequence: 43 })),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(client, Effect.never, "server-run-1")),
      );
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_BOOTSTRAP_COMMAND,
        { sameServerProcess: true },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* attempted.await;
      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(retryCount)).toBe(0);
      expect(received).toEqual([TEST_BOOTSTRAP_COMMAND]);
      response.openUnsafe();

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 43 });
      expect(yield* Ref.get(retryCount)).toBe(0);
      expect(received).toHaveLength(1);
    }),
  );

  it.effect("replaces a half-open session once when its health probe hangs", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const replacementResponse = yield* Latch.make();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => received.push(command)).pipe(
            Effect.andThen(replacementResponse.await),
            Effect.as({ sequence: 44 }),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(firstClient, Effect.never, "server-run-1", undefined, Effect.never)),
      );
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_BOOTSTRAP_COMMAND,
        { sameServerProcess: true },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      yield* TestClock.adjust("12 seconds");
      for (let attempt = 0; attempt < 100 && (yield* Ref.get(retryCount)) < 1; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(secondClient, Effect.never, "server-run-1")),
      );
      for (let attempt = 0; attempt < 100 && received.length < 2; attempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(retryCount)).toBe(1);
      expect(received).toHaveLength(2);
      replacementResponse.openUnsafe();

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 44 });
      expect(yield* Ref.get(retryCount)).toBe(1);
      expect(received).toEqual([
        TEST_BOOTSTRAP_COMMAND,
        { ...TEST_BOOTSTRAP_COMMAND, expectedServerRunId: "server-run-1" },
      ]);
    }),
  );

  it.effect("replays process-local work after a WebSocket replacement in the same server run", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const firstClosed = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 46 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(
          session(
            firstClient,
            firstClosed.await.pipe(
              Effect.andThen(
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "transport",
                    detail: "Test environment disconnected.",
                  }),
                ),
              ),
            ),
            "server-run-1",
          ),
        ),
      );
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_BOOTSTRAP_COMMAND,
        { sameServerProcess: true },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      firstClosed.openUnsafe();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(secondClient, Effect.never, "server-run-1")),
      );

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 46 });
      expect(received).toEqual([
        TEST_BOOTSTRAP_COMMAND,
        { ...TEST_BOOTSTRAP_COMMAND, expectedServerRunId: "server-run-1" },
      ]);
    }),
  );

  it.effect("retries process-local work when a session closes before initial config resolves", () =>
    Effect.gen(function* () {
      const initialConfigStarted = Latch.makeUnsafe();
      const firstClosed = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 45 };
          }),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 46 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      const firstSession: RpcSession.RpcSession = {
        ...session(
          firstClient,
          firstClosed.await.pipe(
            Effect.andThen(
              Effect.fail(
                new ConnectionTransientError({
                  reason: "transport",
                  detail: "Test environment disconnected.",
                }),
              ),
            ),
          ),
        ),
        initialConfig: Effect.sync(() => initialConfigStarted.openUnsafe()).pipe(
          Effect.andThen(Effect.never),
        ),
      };
      yield* SubscriptionRef.set(activeSession, Option.some(firstSession));
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_BOOTSTRAP_COMMAND,
        { sameServerProcess: true },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* initialConfigStarted.await;
      firstClosed.openUnsafe();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(secondClient, Effect.never, "server-run-1")),
      );

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 46 });
      expect(received).toEqual([
        { ...TEST_BOOTSTRAP_COMMAND, expectedServerRunId: "server-run-1" },
      ]);
    }),
  );

  it.effect("preserves the initial-config failure when process-local replay cannot start", () =>
    Effect.gen(function* () {
      const cause = new ConnectionTransientError({
        reason: "transport",
        detail: "Initial server config failed.",
      });
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: () => Effect.succeed({ sequence: 46 }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(client, Effect.never, undefined, cause)),
      );

      const failure = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_BOOTSTRAP_COMMAND,
        { sameServerProcess: true },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(failure).toMatchObject({
        _tag: "EnvironmentRpcUnavailableError",
        environmentId: TARGET.environmentId,
        cause,
      });
    }),
  );

  it.effect("does not force-replay bootstrap work against an older server without a run id", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, retryCount, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some({
          ...session(client),
          initialConfig: Effect.succeed(
            {} as Effect.Success<RpcSession.RpcSession["initialConfig"]>,
          ),
        }),
      );
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_BOOTSTRAP_COMMAND,
        { sameServerProcess: true },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      yield* TestClock.adjust("1 minute");
      expect(yield* Ref.get(retryCount)).toBe(0);
      expect(received).toEqual([TEST_BOOTSTRAP_COMMAND]);
      yield* Fiber.interrupt(resultFiber);
    }),
  );

  it.effect("lets the server recover a retained receipt after its run id rotates", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const firstClosed = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const replacementClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 47 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(
          session(
            firstClient,
            firstClosed.await.pipe(
              Effect.andThen(
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "transport",
                    detail: "Test environment disconnected.",
                  }),
                ),
              ),
            ),
            "server-run-1",
          ),
        ),
      );
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_BOOTSTRAP_COMMAND,
        { sameServerProcess: true },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      firstClosed.openUnsafe();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(replacementClient, Effect.never, "server-run-2")),
      );

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 47 });
      expect(received).toEqual([
        TEST_BOOTSTRAP_COMMAND,
        { ...TEST_BOOTSTRAP_COMMAND, expectedServerRunId: "server-run-1" },
      ]);
    }),
  );

  it.effect("replays an idempotent command after a server restart", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const firstClosed = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const replacementClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 47 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(
          session(
            firstClient,
            firstClosed.await.pipe(
              Effect.andThen(
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "transport",
                    detail: "Test environment disconnected.",
                  }),
                ),
              ),
            ),
            "server-run-1",
          ),
        ),
      );
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_BOOTSTRAP_COMMAND,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      firstClosed.openUnsafe();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(replacementClient, Effect.never, "server-run-2")),
      );

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 47 });
      expect(received).toEqual([TEST_BOOTSTRAP_COMMAND, TEST_BOOTSTRAP_COMMAND]);
    }),
  );

  it.effect("surfaces a retryable failure when guarded work is absent after restart", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const firstClosed = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const guardedCommand: ClientOrchestrationCommand = {
        ...TEST_BOOTSTRAP_COMMAND,
        bootstrap: {
          prepareWorktree: {
            projectCwd: "/repo",
            baseBranch: "main",
            branch: "t3code/restart-test",
          },
          runSetupScript: true,
        },
      };
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const replacementClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
          }).pipe(
            Effect.andThen(
              Effect.fail(new OrchestrationCommandDeduplicationWindowChangedError({})),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(
          session(
            firstClient,
            firstClosed.await.pipe(
              Effect.andThen(
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "transport",
                    detail: "Test environment disconnected.",
                  }),
                ),
              ),
            ),
            "server-run-1",
          ),
        ),
      );
      const failureFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        guardedCommand,
        { sameServerProcess: true },
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      firstClosed.openUnsafe();
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(session(replacementClient, Effect.never, "server-run-2")),
      );

      expect(yield* Fiber.join(failureFiber)).toMatchObject({
        _tag: "EnvironmentRpcUnavailableError",
        message: expect.stringContaining("restarted"),
        cause: {
          _tag: "OrchestrationCommandDeduplicationWindowChangedError",
        },
      });
      expect(received).toEqual([
        guardedCommand,
        { ...guardedCommand, expectedServerRunId: "server-run-1" },
      ]);
    }),
  );

  it.effect("fails a single-shot request on session close without replaying it", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const firstClosed = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const replacementClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 45 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(
        activeSession,
        Option.some(
          session(
            firstClient,
            firstClosed.await.pipe(
              Effect.andThen(
                Effect.fail(
                  new ConnectionTransientError({
                    reason: "transport",
                    detail: "Test environment disconnected.",
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      const failureFiber = yield* requestSingleShot(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_COMMAND,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      firstClosed.openUnsafe();
      yield* SubscriptionRef.set(activeSession, Option.some(session(replacementClient)));

      expect(yield* Fiber.join(failureFiber)).toMatchObject({
        _tag: "ConnectionTransientError",
        reason: "transport",
      });
      yield* Effect.yieldNow;
      expect(received).toEqual([TEST_COMMAND]);
    }),
  );

  it.effect("replays a non-transport failure when its session was replaced", () =>
    Effect.gen(function* () {
      const received: ClientOrchestrationCommand[] = [];
      const nonTransportFailure = new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "session teardown interrupted the request",
          cause: new Error("session replaced"),
        }),
      });
      const { activeSession, supervisor } = yield* makeHarness();
      const secondClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 44 };
          }),
      } as unknown as WsRpcProtocolClient;
      const secondSession = session(secondClient);
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => received.push(command)).pipe(
            Effect.andThen(SubscriptionRef.set(activeSession, Option.some(secondSession))),
            Effect.andThen(Effect.fail(nonTransportFailure)),
          ),
      } as unknown as WsRpcProtocolClient;

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const result = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_COMMAND,
      ).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ sequence: 44 });
      expect(received).toHaveLength(2);
      expect(received[0]).toBe(TEST_COMMAND);
      expect(received[1]).toBe(TEST_COMMAND);
    }),
  );

  it.effect("does not replay a caller-interrupted idempotent request", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const received: ClientOrchestrationCommand[] = [];
      const firstClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            firstAttempted.openUnsafe();
          }).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      const secondClient = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
          Effect.sync(() => {
            received.push(command);
            return { sequence: 44 };
          }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();

      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(activeSession, Option.some(session(firstClient)));
      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_COMMAND,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );

      yield* firstAttempted.await;
      yield* Fiber.interrupt(resultFiber);
      const interrupted = yield* Fiber.await(resultFiber);
      yield* SubscriptionRef.set(activeSession, Option.some(session(secondClient)));
      yield* Effect.yieldNow;

      expect(Exit.isFailure(interrupted)).toBe(true);
      if (Exit.isFailure(interrupted)) {
        expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
      }
      expect(received).toEqual([TEST_COMMAND]);
    }),
  );

  it.effect("waits for an initial session while the supervisor is reconnecting", () =>
    Effect.gen(function* () {
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: () => Effect.succeed({ sequence: 7 }),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, BACKOFF_STATE);

      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_COMMAND,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 7 });
    }),
  );

  it.effect("stops waiting when the environment is manually disconnected", () =>
    Effect.gen(function* () {
      const firstAttempted = Latch.makeUnsafe();
      const client = {
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: () =>
          Effect.sync(() => firstAttempted.openUnsafe()).pipe(
            Effect.andThen(Effect.fail(socketCloseError())),
          ),
      } as unknown as WsRpcProtocolClient;
      const { activeSession, supervisor } = yield* makeHarness();
      yield* SubscriptionRef.set(supervisor.state, CONNECTED_STATE);
      yield* SubscriptionRef.set(activeSession, Option.some(session(client)));

      const resultFiber = yield* requestIdempotent(
        ORCHESTRATION_WS_METHODS.dispatchCommand,
        TEST_COMMAND,
      ).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );
      yield* firstAttempted.await;
      yield* SubscriptionRef.set(activeSession, Option.none());
      yield* SubscriptionRef.set(supervisor.state, AVAILABLE_CONNECTION_STATE);

      expect(yield* Fiber.join(resultFiber)).toMatchObject({
        _tag: "EnvironmentRpcUnavailableError",
        environmentId: TARGET.environmentId,
      });
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
