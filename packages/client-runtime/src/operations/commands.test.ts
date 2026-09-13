import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  TaskId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  createTask,
  createThread,
  startThreadTurn,
  updateTaskMetadata,
  deleteTask,
  setThreadTask,
  archiveThread,
  createProject,
  revertThreadCheckpoint,
  reorderActiveThread,
  settleThread,
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

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (
  dispatched: ClientOrchestrationCommand[],
  tasks?: boolean,
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
    initialConfig: Effect.succeed({ environment: { capabilities: { tasks } } } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
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

describe("environment commands", () => {
  it.effect("dispatches task metadata and membership using the selected environment", () =>
    Effect.gen(function* () {
      const first: ClientOrchestrationCommand[] = [];
      const second: ClientOrchestrationCommand[] = [];
      const firstSupervisor = yield* makeSupervisor(first, true);
      const secondSupervisor = yield* makeSupervisor(second, true);
      const taskId = TaskId.make("same-task");
      yield* createTask({
        taskId,
        name: "Task",
        primaryProjectId: ProjectId.make("project-1"),
        createdAt: "2026-06-06T00:00:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, firstSupervisor));
      yield* updateTaskMetadata({ taskId, description: null }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, firstSupervisor),
      );
      yield* setThreadTask({ threadId: ThreadId.make("member"), taskId }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, secondSupervisor),
      );
      yield* deleteTask({ taskId, threads: "keep" }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, secondSupervisor),
      );
      expect(first).toMatchObject([
        { type: "task.create", taskId, createdAt: "2026-06-06T00:00:00.000Z" },
        { type: "task.meta.update", taskId, description: null },
      ]);
      expect(first[1]).not.toHaveProperty("name");
      expect(second).toMatchObject([
        { type: "thread.task.set", threadId: "member", taskId },
        { type: "task.delete", taskId, threads: "keep" },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect.each([undefined, false])("rejects task operations when capability is %s", (tasks) =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched, tasks);
      const result = yield* setThreadTask({ threadId: ThreadId.make("member"), taskId: null }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(result._tag).toBe("EnvironmentRpcUnavailableError");
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect(
    "rejects membership on older servers before dispatching bootstrap or direct creation",
    () =>
      Effect.gen(function* () {
        for (const tasks of [undefined, false]) {
          const dispatched: ClientOrchestrationCommand[] = [];
          const supervisor = yield* makeSupervisor(dispatched, tasks);
          const create = {
            projectId: ProjectId.make("project"),
            taskId: TaskId.make("parent"),
            title: "Member",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
            runtimeMode: "full-access" as const,
            interactionMode: "default" as const,
            branch: null,
            worktreePath: null,
            createdAt: "2026-06-06T00:00:00.000Z",
          };
          const threadId = ThreadId.make("member");
          for (const command of [
            createThread({ ...create, threadId }),
            setThreadTask({ threadId, taskId: create.taskId }),
            startThreadTurn({
              threadId,
              message: {
                messageId: MessageId.make("message"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: create.modelSelection,
              runtimeMode: create.runtimeMode,
              interactionMode: create.interactionMode,
              bootstrap: { createThread: create },
            }),
          ]) {
            const error = yield* command.pipe(
              Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
              Effect.flip,
            );
            expect(error).toMatchObject({
              _tag: "OrchestrationDispatchCommandError",
              taskMembershipRejection: "unsupported",
            });
          }
          expect(dispatched).toEqual([]);
        }
      }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("keeps a disconnected membership attempt retryable", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched, true);
      yield* SubscriptionRef.set(supervisor.session, Option.none());
      const error = yield* setThreadTask({
        threadId: ThreadId.make("member"),
        taskId: TaskId.make("parent"),
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(error._tag).toBe("EnvironmentRpcUnavailableError");
      expect(error).not.toHaveProperty("taskMembershipRejection");
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

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

  it.effect("uses a distinct command when keeping workspace changes", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      for (const restoreFiles of [undefined, true, false]) {
        yield* revertThreadCheckpoint({
          commandId: CommandId.make("rewind-command"),
          threadId: ThreadId.make("thread-1"),
          turnCount: 0,
          ...(restoreFiles !== undefined ? { restoreFiles } : {}),
          createdAt: "2026-06-06T00:01:00.000Z",
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      }
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.checkpoint.revert",
        "thread.checkpoint.revert",
        "thread.conversation.revert",
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

  it.effect("sends an active order key without changing activity timestamps", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      yield* reorderActiveThread({
        commandId: CommandId.make("reorder-command"),
        threadId: ThreadId.make("thread-1"),
        orderKey: "mf",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(dispatched).toEqual([
        {
          type: "thread.active.reorder",
          commandId: "reorder-command",
          threadId: "thread-1",
          orderKey: "mf",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );
});
