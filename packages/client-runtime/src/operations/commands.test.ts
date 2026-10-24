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
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import {
  archiveThread,
  interruptThreadTurn,
  revertThreadCheckpoint,
  resumeThreadQueue,
  startThreadTurn,
  runProjectPrompt,
} from "./commands.ts";

const layerTestCrypto = Layer.succeed(
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

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (input: {
  readonly commands: OrchestrationV2Command[];
  readonly projects: ProjectMutation[];
  readonly launches?: OrchestrationV2ThreadLaunchInput[];
  readonly projection?: OrchestrationV2ThreadProjection;
  readonly projectionRequests?: ThreadId[];
  readonly advertiseServerResolvedCommandContext?: boolean;
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
          ...(input.advertiseServerResolvedCommandContext === false
            ? {}
            : { serverResolvedCommandContext: true }),
        },
      },
    } as never),
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
    }).pipe(Effect.provide(layerTestCrypto)),
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
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("resolves run ordinal zero to the persisted thread-start checkpoint", () =>
    Effect.gen(function* () {
      const scopeId = CheckpointScopeId.make("checkpoint-scope-root");
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
    }).pipe(Effect.provide(layerTestCrypto)),
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
    }).pipe(Effect.provide(layerTestCrypto)),
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
    }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("retains projection-shaped delivery for servers without command context support", () =>
    Effect.gen(function* () {
      const activeRunId = RunId.make("legacy-active-run");
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        runs: [
          {
            id: activeRunId,
            threadId: v2ThreadId,
            ordinal: 1,
            providerInstanceId: v2Projection.thread.providerInstanceId,
            modelSelection: v2Projection.thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("legacy-active-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: v2Now,
            startedAt: v2Now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
      };
      const commands: OrchestrationV2Command[] = [];
      const projectionRequests: ThreadId[] = [];
      const supervisor = yield* makeSupervisor({
        commands,
        projects: [],
        projection,
        projectionRequests,
        advertiseServerResolvedCommandContext: false,
      });

      for (const [mode, expectedMode] of [
        ["auto", { type: "queue_after_active" }],
        ["queue", { type: "queue_after_active" }],
        ["steer", { type: "steer_active", targetRunId: activeRunId }],
        ["restart", { type: "restart_active", targetRunId: activeRunId }],
      ] as const) {
        yield* startThreadTurn({
          commandId: CommandId.make(`legacy-command-${mode}`),
          threadId: v2ThreadId,
          message: {
            messageId: MessageId.make(`legacy-message-${mode}`),
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
          dispatchMode: expectedMode,
        });
        expect(commands.at(-1)).not.toHaveProperty("deliveryIntent");
      }
      expect(projectionRequests).toEqual([v2ThreadId, v2ThreadId, v2ThreadId, v2ThreadId]);
    }).pipe(Effect.provide(layerTestCrypto)),
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
    }).pipe(Effect.provide(layerTestCrypto)),
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
      }).pipe(Effect.provide(layerTestCrypto)),
  );

  it.effect("validates identified checkpoints locally for older servers", () =>
    Effect.gen(function* () {
      const checkpointId = CheckpointId.make("legacy-checkpoint");
      const scopeId = CheckpointScopeId.make("legacy-checkpoint-scope");
      for (const status of ["ready", "missing", "error", "stale", null] as const) {
        const commands: OrchestrationV2Command[] = [];
        const projectionRequests: ThreadId[] = [];
        const supervisor = yield* makeSupervisor({
          commands,
          projects: [],
          projectionRequests,
          advertiseServerResolvedCommandContext: false,
          projection: {
            ...v2Projection,
            checkpoints:
              status === null
                ? []
                : [
                    {
                      id: checkpointId,
                      threadId: v2ThreadId,
                      scopeId,
                      runId: null,
                      nodeId: NodeId.make("legacy-checkpoint-node"),
                      parentCheckpointId: null,
                      ordinalWithinScope: 0,
                      appRunOrdinal: null,
                      ref: CheckpointRef.make("refs/t3/legacy-checkpoint"),
                      status,
                      files: [],
                      capturedAt: v2Now,
                    },
                  ],
          },
        });
        const rollback = revertThreadCheckpoint({
          commandId: CommandId.make(`legacy-rollback-${status}`),
          threadId: v2ThreadId,
          checkpointId,
          scopeId,
        }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

        if (status === "ready") {
          yield* rollback;
          expect(commands).toEqual([
            {
              type: "checkpoint.rollback",
              commandId: "legacy-rollback-ready",
              threadId: v2ThreadId,
              checkpointId,
              scopeId,
            },
          ]);
        } else {
          const error = yield* rollback.pipe(Effect.flip);
          expect(error._tag).toBe("OrchestrationV2CheckpointUnavailableError");
          expect(commands).toEqual([]);
        }
        expect(projectionRequests).toEqual([v2ThreadId]);
      }
    }).pipe(Effect.provide(layerTestCrypto)),
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
      }).pipe(Effect.provide(layerTestCrypto)),
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
      }).pipe(Effect.provide(layerTestCrypto)),
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
    }).pipe(Effect.provide(layerTestCrypto)),
  );
});

it.effect(
  "runs a saved project prompt through normal dispatch in the invoking thread and worktree",
  () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const launches: OrchestrationV2ThreadLaunchInput[] = [];
      const projection: OrchestrationV2ThreadProjection = {
        ...v2Projection,
        thread: {
          ...v2Projection.thread,
          worktreePath: "/workspace/research-worktree",
          modelSelection: {
            instanceId: ProviderInstanceId.make("custom-provider"),
            model: "deepseek/deepseek-v4.1-flash:free",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          runtimeMode: "full-access",
        },
      };
      const supervisor = yield* makeSupervisor({ commands, projects: [], launches, projection });
      const action = {
        id: "status",
        name: "Status",
        type: "prompt",
        prompt: "Read project instructions.\nInspect results without edits.",
        icon: "play",
        runOnWorktreeCreate: false,
      } as const;
      const selectedModel = {
        instanceId: ProviderInstanceId.make("custom-provider"),
        model: "deepseek/deepseek-v4.1-flash:free",
        options: [{ id: "reasoningEffort", value: "max" }],
      };
      yield* runProjectPrompt({
        commandId: CommandId.make("project-prompt"),
        threadId: projection.thread.id,
        action,
        modelSelection: selectedModel,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      expect(launches).toEqual([]);
      expect(commands).toHaveLength(4);
      expect(commands.map((command) => command.commandId)).toEqual([
        "project-prompt:model-selection",
        "project-prompt:runtime-mode",
        "project-prompt:interaction-mode",
        "project-prompt",
      ]);
      expect(commands[0]).toMatchObject({
        type: "thread.model-selection.set",
        modelSelection: selectedModel,
      });
      expect(commands[1]).toMatchObject({
        type: "thread.runtime-mode.set",
        runtimeMode: "approval-required",
      });
      expect(commands[2]).toMatchObject({
        type: "thread.interaction-mode.set",
        interactionMode: "plan",
      });
      expect(commands[3]).toMatchObject({
        type: "message.dispatch",
        threadId: projection.thread.id,
        text: action.prompt,
        attachments: [],
        createdBy: "user",
        dispatchMode: { type: "queue_after_active" },
      });
      expect(commands[3]).not.toHaveProperty("runtimeMode");
      expect(commands[3]).not.toHaveProperty("worktreePath");
      expect(projection.thread.worktreePath).toBe("/workspace/research-worktree");
    }).pipe(Effect.provide(layerTestCrypto)),
);

it.effect("prefers a saved prompt action's model over the composer and thread selections", () =>
  Effect.gen(function* () {
    const commands: OrchestrationV2Command[] = [];
    const currentModel = {
      instanceId: ProviderInstanceId.make("custom-provider"),
      model: "deepseek/deepseek-v4.1-flash:free",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const actionModel = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-4-1",
      options: [{ id: "effort", value: "max" }],
    };
    const composerModel = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.1-codex",
    };
    const projection: OrchestrationV2ThreadProjection = {
      ...v2Projection,
      thread: { ...v2Projection.thread, modelSelection: currentModel },
    };
    const supervisor = yield* makeSupervisor({ commands, projects: [], projection });
    yield* runProjectPrompt({
      threadId: projection.thread.id,
      action: {
        id: "status",
        name: "Status",
        type: "prompt",
        prompt: "Inspect results.",
        modelSelection: actionModel,
        icon: "play",
        runOnWorktreeCreate: false,
      },
      modelSelection: composerModel,
    }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
    expect(commands[0]).toMatchObject({
      type: "thread.model-selection.set",
      modelSelection: actionModel,
    });
    expect(commands[1]).toMatchObject({
      type: "message.dispatch",
      text: "Inspect results.",
      modelSelection: actionModel,
    });
  }).pipe(Effect.provide(layerTestCrypto)),
);

it.effect("reports an unavailable environment when running a saved prompt", () =>
  Effect.gen(function* () {
    const commands: OrchestrationV2Command[] = [];
    const supervisor = yield* makeSupervisor({ commands, projects: [] });
    yield* SubscriptionRef.set(supervisor.session, Option.none());
    const result = yield* runProjectPrompt({
      threadId: v2ThreadId,
      action: {
        id: "status",
        name: "Status",
        type: "prompt",
        prompt: "Inspect results.",
        icon: "play",
        runOnWorktreeCreate: false,
      },
    }).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
    expect(commands).toEqual([]);
  }).pipe(Effect.provide(layerTestCrypto)),
);

it.effect("keeps persisted thread settings when a prompt has no composer overrides", () =>
  Effect.gen(function* () {
    const commands: OrchestrationV2Command[] = [];
    const projection: OrchestrationV2ThreadProjection = {
      ...v2Projection,
      thread: {
        ...v2Projection.thread,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.1-codex",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      },
    };
    const supervisor = yield* makeSupervisor({ commands, projects: [], projection });
    yield* runProjectPrompt({
      threadId: projection.thread.id,
      action: {
        id: "status",
        name: "Status",
        type: "prompt",
        prompt: "Inspect results.",
        icon: "play",
        runOnWorktreeCreate: false,
      },
    }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "message.dispatch", text: "Inspect results." });
  }).pipe(Effect.provide(layerTestCrypto)),
);
