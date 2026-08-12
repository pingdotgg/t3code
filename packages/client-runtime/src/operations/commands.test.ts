import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

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
  archiveThread,
  createProject,
  settleThread,
  startThreadTurn,
  type StartThreadTurnInput,
  stopThreadSession,
  unsettleThread,
} from "./commands.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);

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

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (
  dispatched: ClientOrchestrationCommand[],
) {
  const client = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

const makeSingleShotDisconnectHarness = Effect.fn(
  "TestEnvironmentCommands.makeSingleShotDisconnectHarness",
)(function* (replacementServerRunId = "server-run-1") {
  const firstAttempted = Latch.makeUnsafe();
  const firstClosed = Latch.makeUnsafe();
  const firstAttempts: ClientOrchestrationCommand[] = [];
  const replacementAttempts: ClientOrchestrationCommand[] = [];
  const firstClient = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.sync(() => {
        firstAttempts.push(command);
        firstAttempted.openUnsafe();
      }).pipe(Effect.andThen(Effect.never)),
  } as unknown as WsRpcProtocolClient;
  const replacementClient = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.sync(() => {
        replacementAttempts.push(command);
        return { sequence: 2 };
      }),
  } as unknown as WsRpcProtocolClient;
  const firstSession: RpcSession.RpcSession = {
    client: firstClient,
    initialConfig: Effect.succeed({
      serverRunId: "server-run-1",
    } as Effect.Success<RpcSession.RpcSession["initialConfig"]>),
    ready: Effect.void,
    probe: Effect.void,
    closed: firstClosed.await.pipe(
      Effect.andThen(
        Effect.fail(
          new ConnectionTransientError({
            reason: "transport",
            detail: "Test environment disconnected.",
          }),
        ),
      ),
    ),
  };
  const replacementSession: RpcSession.RpcSession = {
    client: replacementClient,
    initialConfig: Effect.succeed({
      serverRunId: replacementServerRunId,
    } as Effect.Success<RpcSession.RpcSession["initialConfig"]>),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const activeSession = yield* SubscriptionRef.make(Option.some(firstSession));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED_CONNECTION_STATE),
    session: activeSession,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    firstAttempted,
    firstAttempts,
    firstClosed,
    replacementAttempts,
    replacementSession,
    supervisor,
  };
});

describe("environment commands", () => {
  it.effect("adds generated command metadata", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      const result = yield* createProject({
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        createdAt: "2026-06-06T00:00:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ sequence: 1 });
      expect(dispatched).toEqual([
        {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/workspace/project",
          createdAt: "2026-06-06T00:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("preserves caller metadata for idempotent queued commands", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* stopThreadSession({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-06-06T00:01:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.session.stop",
          commandId: "queued-command",
          threadId: "thread-1",
          createdAt: "2026-06-06T00:01:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("does not add timestamps to commands without createdAt", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* archiveThread({
        commandId: CommandId.make("archive-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.archive",
          commandId: "archive-command",
          threadId: "thread-1",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("dispatches settle and unsettle commands without timestamps", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* settleThread({
        commandId: CommandId.make("settle-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* unsettleThread({
        commandId: CommandId.make("unsettle-command"),
        threadId: ThreadId.make("thread-1"),
        reason: "user",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.settle",
          commandId: "settle-command",
          threadId: "thread-1",
        },
        {
          type: "thread.unsettle",
          commandId: "unsettle-command",
          threadId: "thread-1",
          reason: "user",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("replays attachment turns with the same command after their session closes", () =>
    Effect.gen(function* () {
      const harness = yield* makeSingleShotDisconnectHarness();
      const input: StartThreadTurnInput = {
        commandId: CommandId.make("attachment-turn"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-attachment"),
          role: "user",
          text: "Inspect this image",
          attachments: [
            {
              type: "image",
              name: "proof.png",
              mimeType: "image/png",
              sizeBytes: 1,
              dataUrl: "data:image/png;base64,AA==",
            },
          ],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [],
        },
        titleSeed: "Image turn",
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-06-06T00:02:00.000Z",
      };
      const resultFiber = yield* startThreadTurn(input).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, harness.supervisor),
        Effect.forkChild,
      );

      yield* harness.firstAttempted.await;
      harness.firstClosed.openUnsafe();
      yield* SubscriptionRef.set(harness.activeSession, Option.some(harness.replacementSession));

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 2 });
      expect(harness.firstAttempts).toEqual([
        expect.objectContaining({ commandId: input.commandId }),
      ]);
      expect(harness.replacementAttempts).toEqual([
        expect.objectContaining({ commandId: input.commandId }),
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("replays restart-safe bootstrap turns after a server restart", () =>
    Effect.gen(function* () {
      const input: StartThreadTurnInput = {
        commandId: CommandId.make("bootstrap-turn"),
        threadId: ThreadId.make("thread-bootstrap"),
        message: {
          messageId: MessageId.make("message-bootstrap"),
          role: "user",
          text: "Start the project",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-1"),
            title: "Bootstrap turn",
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.6-sol",
              options: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-06-06T00:03:00.000Z",
          },
        },
        createdAt: "2026-06-06T00:03:00.000Z",
      };
      const harness = yield* makeSingleShotDisconnectHarness("server-run-2");
      const resultFiber = yield* startThreadTurn(input).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, harness.supervisor),
        Effect.forkChild,
      );

      yield* harness.firstAttempted.await;
      harness.firstClosed.openUnsafe();
      yield* SubscriptionRef.set(harness.activeSession, Option.some(harness.replacementSession));

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 2 });
      expect(harness.firstAttempts).toHaveLength(1);
      expect(harness.replacementAttempts).toEqual(harness.firstAttempts);
      expect(harness.replacementAttempts[0]).not.toHaveProperty("expectedServerRunId");
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("keeps worktree bootstrap replay bound to one server process", () =>
    Effect.gen(function* () {
      const input: StartThreadTurnInput = {
        commandId: CommandId.make("worktree-bootstrap-turn"),
        threadId: ThreadId.make("thread-worktree-bootstrap"),
        message: {
          messageId: MessageId.make("message-worktree-bootstrap"),
          role: "user",
          text: "Start the worktree project",
          attachments: [],
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
          options: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        bootstrap: {
          prepareWorktree: {
            projectCwd: "/repo",
            baseBranch: "main",
            branch: "t3code/restart-test",
          },
          runSetupScript: true,
        },
        createdAt: "2026-06-06T00:04:00.000Z",
      };
      const harness = yield* makeSingleShotDisconnectHarness("server-run-2");
      const resultFiber = yield* startThreadTurn(input).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, harness.supervisor),
        Effect.forkChild,
      );

      yield* harness.firstAttempted.await;
      harness.firstClosed.openUnsafe();
      yield* SubscriptionRef.set(harness.activeSession, Option.some(harness.replacementSession));

      expect(yield* Fiber.join(resultFiber)).toEqual({ sequence: 2 });
      expect(harness.firstAttempts).toHaveLength(1);
      expect(harness.replacementAttempts).toEqual([
        { ...harness.firstAttempts[0], expectedServerRunId: "server-run-1" },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
