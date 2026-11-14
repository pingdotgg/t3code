import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EnvironmentId,
  MessageId,
  NodeId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadLaunchInput,
  type OrchestrationV2ThreadProjection,
  type ProjectMutation,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import {
  archiveThread,
  interruptThreadTurn,
  revertThreadCheckpoint,
  resumeThreadQueue,
  startThreadTurn,
} from "./commands.ts";

const layerTestRandom = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => new Uint8Array(size)),
);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
};

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (input: {
  readonly commands: OrchestrationV2Command[];
  readonly projects: ProjectMutation[];
  readonly launches?: OrchestrationV2ThreadLaunchInput[];
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly projectionRequests?: ThreadId[];
  readonly advertiseThreadStop?: boolean;
}) {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        input.commands.push(command);
        return { sequence: input.commands.length };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: (requestInput: {
      readonly threadId: ThreadId;
    }) =>
      Effect.sync(() => {
        input.projectionRequests?.push(requestInput.threadId);
        return input.projection ?? v2Projection;
      }),
    [ORCHESTRATION_V2_WS_METHODS.launchThread]: (launchInput: OrchestrationV2ThreadLaunchInput) =>
      Effect.sync(() => {
        input.launches?.push(launchInput);
        return {
          threadId: launchInput.threadId ?? v2ThreadId,
          projection: input.projection ?? v2Projection,
          resumed: false,
        };
      }),
    [WS_METHODS.projectsMutate]: (mutation: ProjectMutation) =>
      Effect.sync(() => {
        input.projects.push(mutation);
        return {
          id: mutation.projectId,
          title: mutation.type === "project.create" ? mutation.title : "Project",
          workspaceRoot:
            mutation.type === "project.create" ? mutation.workspaceRoot : "/workspace/project",
          repositoryIdentity: null,
          faviconPath: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-06-06T00:00:00.000Z",
          updatedAt: "2026-06-06T00:00:00.000Z",
          deletedAt: null,
        };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: {
        capabilities: {
          repositoryIdentity: true,
          ...(input.advertiseThreadStop === true ? { threadStop: true } : {}),
        },
      },
    } as never),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(CONNECTED_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("V2 environment commands", () => {
  it.effect("distinguishes sending a selected queued message from resuming queue order", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const threadId = ThreadId.make("thread-1");
      yield* resumeThreadQueue({
        commandId: CommandId.make("send-selected"),
        threadId,
        runId: RunId.make("selected"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* resumeThreadQueue({
        commandId: CommandId.make("resume-queue"),
        threadId,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        { type: "queued-run.start", commandId: "send-selected", threadId, runId: "selected" },
        { type: "queue.resume", commandId: "resume-queue", threadId },
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("preserves caller command ids for idempotent V2 commands", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });

      yield* archiveThread({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        { type: "thread.archive", commandId: "queued-command", threadId: "thread-1" },
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("resolves run ordinal zero to the persisted thread-start checkpoint", () =>
    Effect.gen(function* () {
      const scopeId = CheckpointScopeId.make("checkpoint-scope-root");
      const repositoryScopeId = CheckpointScopeId.make("checkpoint-scope-repository");
      const checkpointId = CheckpointId.make("checkpoint-thread-start");
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        checkpoints: [
          {
            id: checkpointId,
            threadId: v2ThreadId,
            scopeId,
            runId: null,
            nodeId: NodeId.make("node-run-1"),
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make("refs/t3/thread-start"),
            status: "ready",
            files: [],
            capturedAt: v2Now,
          },
          // A tracked repository's first baseline, recorded after the thread's own.
          {
            id: CheckpointId.make("checkpoint-repository-start"),
            threadId: v2ThreadId,
            scopeId: repositoryScopeId,
            runId: null,
            nodeId: NodeId.make("node-run-1"),
            parentCheckpointId: null,
            ordinalWithinScope: 0,
            appRunOrdinal: null,
            ref: CheckpointRef.make("refs/t3/repository-start"),
            status: "ready",
            files: [],
            capturedAt: v2Now,
          },
        ],
        checkpointScopes: [
          {
            id: repositoryScopeId,
            threadId: v2ThreadId,
            runId: null,
            nodeId: NodeId.make("node-run-1"),
            parentScopeId: scopeId,
            providerThreadId: null,
            kind: "manual",
            ordinalWithinParent: 1,
            advancesAppRunCount: false,
            cwd: "/workspace/api",
            label: "api",
            repositoryPath: "/workspace/api",
            createdAt: v2Now,
          },
        ],
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      yield* revertThreadCheckpoint({
        commandId: CommandId.make("rollback-thread-start"),
        threadId: v2ThreadId,
        turnCount: 0,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(commands).toEqual([
        {
          type: "checkpoint.rollback",
          commandId: "rollback-thread-start",
          threadId: v2ThreadId,
          scopeId,
          checkpointId,
        },
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("preserves an existing worktree and branch during first-message launch", () =>
    Effect.gen(function* () {
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const supervisor = yield* makeSupervisor({ commands: [], projects: [], launches });

      yield* startThreadTurn({
        commandId: CommandId.make("launch-existing-worktree"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-existing-worktree"),
          role: "user",
          text: "Continue here",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        titleSeed: "Continue here",
        bootstrap: {
          createThread: {
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: v2Projection.thread.modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: "/workspace/project-worktrees/feature",
            createdAt: "2026-06-20T00:00:00.000Z",
          },
        },
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(launches[0]).toMatchObject({
        threadId: v2ThreadId,
        title: "Continue here",
        generateTitle: true,
        workspaceStrategy: {
          type: "existing_worktree",
          worktreePath: "/workspace/project-worktrees/feature",
          branch: "feature",
        },
      });
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("uses server-resolved delivery intent without fetching the full projection", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projectionRequests });

      for (const [mode, expectedType] of [
        ["queue", "queue_after_active"],
        ["auto", "start_immediately"],
        ["steer", "start_immediately"],
        ["restart", "start_immediately"],
      ] as const) {
        yield* startThreadTurn({
          commandId: CommandId.make(`command-${mode}`),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make(`message-${mode}`),
            role: "user",
            text: mode,
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          dispatchMode: mode,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

        expect(commands.at(-1)).toMatchObject({
          type: "message.dispatch",
          dispatchMode: { type: expectedType },
          ...(mode === "queue" ? {} : { deliveryIntent: mode }),
        });
      }
      expect(projectionRequests).toEqual([]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  // A dead socket reaches the caller as a protocol error, or as an interrupt when
  // the supervisor closes the session before the protocol reports the error.
  it.effect.each([
    [
      "protocol error",
      new RpcClientError.RpcClientError({
        reason: new RpcClientError.RpcClientDefect({
          message: "socket closed",
          cause: new Error("socket closed"),
        }),
      }),
    ],
    ["session close", Effect.failCause(Cause.interrupt())],
  ] as const)("retries a message dispatch lost to a %s with the same command id", ([, loss]) =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const firstAttemptLost = yield* Deferred.make<void>();
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* Deferred.succeed(firstAttemptLost, undefined);
            return yield* loss;
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: lostClient }),
      );

      const sendFiber = yield* startThreadTurn({
        commandId: CommandId.make("command-lost-ack"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-lost-ack"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttemptLost);
      yield* SubscriptionRef.set(supervisor.session, Option.some(healthySession));
      const exit = yield* Fiber.await(sendFiber);

      expect(commands.map((command) => [command.type, command.commandId])).toEqual([
        ["message.dispatch", "command-lost-ack"],
        ["message.dispatch", "command-lost-ack"],
      ]);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("stops resending a message whose dispatch keeps losing the socket", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const dyingClient: WsRpcProtocolClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(
              supervisor.session,
              Option.some({ ...healthySession, client: dyingClient }),
            );
            return yield* new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            });
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: dyingClient }),
      );

      const error = yield* startThreadTurn({
        commandId: CommandId.make("command-socket-killer"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-socket-killer"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(commands.map((command) => command.commandId)).toEqual([
        "command-socket-killer",
        "command-socket-killer",
        "command-socket-killer",
      ]);
      expect(error._tag).toBe("RpcClientError");
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("fails a message dispatch the host never answers on a live socket", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const silentClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.sync(() => commands.push(command)).pipe(Effect.andThen(Effect.never)),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: silentClient }),
      );

      const sendFiber = yield* startThreadTurn({
        commandId: CommandId.make("command-unanswered"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-unanswered"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 minute");

      expect(sendFiber.pollUnsafe()).toBeDefined();
      expect((yield* Fiber.join(sendFiber))._tag).toBe("EnvironmentRpcUnavailableError");
      expect(commands.map((command) => command.commandId)).toEqual(["command-unanswered"]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("holds a lost message through reconnect backoff until disconnect", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [] });
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            return yield* new RpcClientError.RpcClientError({
              reason: new RpcClientError.RpcClientDefect({
                message: "socket closed",
                cause: new Error("socket closed"),
              }),
            });
          }),
      } as unknown as WsRpcProtocolClient;
      const send = (resendAfterSocketLoss: boolean) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(
            supervisor.session,
            Option.some({ ...healthySession, client: lostClient }),
          );
          return yield* startThreadTurn({
            commandId: CommandId.make(`command-host-gone-${resendAfterSocketLoss}`),
            threadId: v2ThreadId,
            message: {
              messageId: MessageId.make(`message-host-gone-${resendAfterSocketLoss}`),
              role: "user",
              text: "hello",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            resendAfterSocketLoss,
          }).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.flip,
            Effect.forkChild,
          );
        });

      const optedOut = yield* send(false);
      expect((yield* Fiber.join(optedOut))._tag).toBe("RpcClientError");

      const waiting = yield* send(true);
      yield* SubscriptionRef.set(supervisor.state, {
        ...CONNECTED_STATE,
        phase: "backoff" as const,
      });
      yield* TestClock.adjust("2 minutes");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* SubscriptionRef.set(supervisor.state, AVAILABLE_CONNECTION_STATE);
      expect((yield* Fiber.join(waiting))._tag).toBe("RpcClientError");
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-host-gone-false",
        "command-host-gone-true",
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("Stop with no run left ends the thread's pull request watches", () =>
    Effect.gen(function* () {
      const link = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        url: "https://github.com/pingdotgg/t3code/pull/7",
        source: "agent" as const,
        linkedAt: "2026-10-05T00:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const watch = {
        startedAt: "2026-10-05T00:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-10-05T00:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      };
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        thread: {
          ...v2Projection.thread,
          pullRequests: [
            { ...link, number: 7, watch },
            { ...link, number: 8 },
            { ...link, number: 9, source: "stack-dismissed", watch },
          ],
        },
      };
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

      yield* interruptThreadTurn({ threadId: v2ThreadId }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      );

      expect(commands).toEqual([
        {
          type: "thread.pull-request.watch",
          commandId: expect.any(String),
          threadId: v2ThreadId,
          host: "github.com",
          repository: "pingdotgg/t3code",
          number: 7,
          watching: false,
        },
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect.each(["waiting", "completed", "rolled_back"] as const)(
    "dispatches Stop for %s runs with background commands except rollback",
    (status) =>
      Effect.gen(function* () {
        const waitingRunId = RunId.make("run-waiting");
        const projection: OrchestrationV2ThreadProjection = {
          ...v2Projection,
          runs: [
            {
              id: waitingRunId,
              threadId: v2ThreadId,
              ordinal: 1,
              providerInstanceId: v2Projection.thread.providerInstanceId,
              modelSelection: v2Projection.thread.modelSelection,
              providerThreadId: null,
              userMessageId: MessageId.make("message-waiting"),
              rootNodeId: null,
              activeAttemptId: null,
              status,
              requestedAt: v2Now,
              startedAt: v2Now,
              completedAt: null,
              checkpointId: null,
              contextHandoffId: null,
            },
          ],
          turnItems: [
            {
              id: TurnItemId.make("background-command"),
              threadId: v2ThreadId,
              runId: waitingRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "running",
              title: null,
              startedAt: v2Now,
              completedAt: null,
              updatedAt: v2Now,
              type: "command_execution",
              input: "vp run dev",
            },
          ],
        };
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({ commands, projects: [], projection });

        const result = yield* interruptThreadTurn({ threadId: v2ThreadId }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        );

        expect(result).toEqual({ sequence: status === "rolled_back" ? 0 : 1 });
        expect(commands).toEqual(
          status === "rolled_back"
            ? []
            : [
                {
                  type: "run.interrupt",
                  commandId: expect.any(String),
                  threadId: v2ThreadId,
                  runId: waitingRunId,
                  holdQueue: true,
                },
              ],
        );
      }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect(
    "a native subagent stop targets its owning run rather than holding the parent queue",
    () =>
      Effect.gen(function* () {
        const subagentId = NodeId.make("native-subagent");
        const runId = RunId.make("settled-owner-run");
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({
          commands,
          projects: [],
          projection: {
            ...v2Projection,
            subagents: [
              {
                id: subagentId,
                threadId: v2ThreadId,
                runId,
                parentNodeId: NodeId.make("owner-node"),
                origin: "provider_native",
                createdBy: "agent",
                driver: ProviderDriverKind.make("claudeAgent"),
                providerInstanceId: ProviderInstanceId.make("claudeAgent"),
                providerThreadId: null,
                childThreadId: ThreadId.make("native-child-thread"),
                nativeTaskRef: null,
                prompt: "Work",
                title: null,
                model: null,
                result: null,
                status: "running",
                startedAt: v2Now,
                completedAt: null,
                updatedAt: v2Now,
              },
            ],
          },
        });
        yield* interruptThreadTurn({
          commandId: CommandId.make("native-stop"),
          threadId: v2ThreadId,
          subagentId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(commands).toEqual([
          {
            type: "subagent.stop",
            commandId: "native-stop",
            threadId: v2ThreadId,
            runId,
            subagentId,
          },
        ]);
      }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect(
    "an app-owned subagent stop asks the parent to clear an orphan, then stops the child",
    () =>
      Effect.gen(function* () {
        const subagentId = NodeId.make("app-owned-subagent");
        const runId = RunId.make("parent-run");
        const childThreadId = ThreadId.make("app-owned-child-thread");
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor({
          commands,
          projects: [],
          advertiseThreadStop: true,
          projection: {
            ...v2Projection,
            subagents: [
              {
                id: subagentId,
                threadId: v2ThreadId,
                runId,
                parentNodeId: NodeId.make("owner-node"),
                origin: "app_owned",
                createdBy: "agent",
                driver: ProviderDriverKind.make("codex"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                providerThreadId: null,
                childThreadId,
                nativeTaskRef: null,
                prompt: "Work",
                title: null,
                model: null,
                result: null,
                status: "running",
                startedAt: v2Now,
                completedAt: null,
                updatedAt: v2Now,
              },
            ],
          },
        });
        yield* interruptThreadTurn({
          commandId: CommandId.make("lineage-stop"),
          threadId: v2ThreadId,
          subagentId,
          // A parent run must not be interrupted on the child thread.
          runId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
        expect(commands).toEqual([
          {
            type: "subagent.stop",
            commandId: expect.any(String),
            threadId: v2ThreadId,
            runId,
            subagentId,
          },
          { type: "thread.stop", commandId: "lineage-stop", threadId: childThreadId },
        ]);
      }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("stops a thread without relying on background work in the history window", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projectionRequests,
        advertiseThreadStop: true,
      });

      const result = yield* interruptThreadTurn({
        commandId: CommandId.make("stop-outside-history-window"),
        threadId: v2ThreadId,
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ sequence: 1 });
      expect(projectionRequests).toEqual([]);
      expect(commands).toEqual([
        {
          type: "thread.stop",
          commandId: "stop-outside-history-window",
          threadId: v2ThreadId,
        },
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );
});
