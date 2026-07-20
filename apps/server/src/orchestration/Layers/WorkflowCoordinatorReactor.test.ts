import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  WorkflowArtifactId,
  WorkflowNodeId,
  WorkflowRunId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type WorkflowArtifact,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  ProjectionWorkflowRepository,
  type ProjectionWorkflowRepositoryShape,
  type ProjectionWorkflowRun,
} from "../../persistence/Services/ProjectionWorkflows.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { projectEvent } from "../projector.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { WorkflowCoordinatorReactor } from "../Services/WorkflowCoordinatorReactor.ts";
import { WorkflowCoordinatorReactorLive } from "./WorkflowCoordinatorReactor.ts";

const now = "2026-07-17T20:00:00.000Z";
const runId = WorkflowRunId.make("workflow-run");
const nodeId = WorkflowNodeId.make("worker");
const parentThreadId = ThreadId.make("parent-thread");
const inputArtifactId = WorkflowArtifactId.make("workflow-input");

const inputArtifact: WorkflowArtifact = {
  id: inputArtifactId,
  runId,
  nodeId,
  producerThreadId: parentThreadId,
  payload: {
    kind: "input-context",
    contextPolicy: "summary",
    parentThreadId,
    messages: [],
    summary: "Investigate the reported behavior.",
    truncated: false,
  },
  createdAt: now,
};

const run: ProjectionWorkflowRun = {
  id: runId,
  workflowId: "generic-worker",
  parentThreadId,
  status: "pending",
  nodes: [
    {
      nodeId,
      status: "pending",
      inputArtifactId,
    },
  ],
  createdAt: now,
  updatedAt: now,
  definition: {
    id: "generic-worker",
    name: "Generic worker",
    nodes: [
      {
        id: nodeId,
        title: "Investigate",
        prompt: "Investigate the scoped task and return a concise result.",
        contextPolicy: "summary",
      },
    ],
  },
  workerConfig: {
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5",
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
  },
};

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  projects: [],
  workflowRuns: [run],
  threads: [
    {
      id: parentThreadId,
      projectId: ProjectId.make("project"),
      parentThreadId: null,
      title: "Parent",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
      },
      runtimeMode: "full-access",
      pendingRuntimeMode: null,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      reviewResult: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      queuedTurns: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: now,
};

describe("WorkflowCoordinatorReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<WorkflowCoordinatorReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("recovers a pending node with stable idempotency keys", async () => {
    const commands: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(readModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      streamDomainEvents: Stream.empty,
    };
    const workflows: ProjectionWorkflowRepositoryShape = {
      upsertRun: () => Effect.void,
      getByRunId: () => Effect.succeed(Option.some(run)),
      listIncomplete: () => Effect.succeed([run]),
      listAll: () => Effect.succeed([run]),
      listShellSnapshot: () => Effect.succeed({ runs: [], artifacts: [] }),
      upsertArtifact: () => Effect.void,
      getArtifactById: () => Effect.succeed(Option.some(inputArtifact)),
      listAllArtifacts: () => Effect.succeed([inputArtifact]),
      setNodeInputArtifact: () => Effect.void,
      startNode: () => Effect.void,
      recordNodeResult: () => Effect.void,
      finalizeRun: () => Effect.void,
    };

    runtime = ManagedRuntime.make(
      WorkflowCoordinatorReactorLive.pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provideMerge(Layer.succeed(ProjectionWorkflowRepository, workflows)),
      ),
    );
    const coordinator = await runtime.runPromise(Effect.service(WorkflowCoordinatorReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(coordinator.start().pipe(Scope.provide(scope)));

    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "workflow.node.worker.start",
      "thread.turn.start",
    ]);
    expect(commands[2]).toMatchObject({
      type: "thread.turn.start",
      message: {
        messageId: MessageId.make("workflow:workflow-run:node:worker:input"),
      },
    });
    expect(commands[0]).toMatchObject({
      type: "thread.create",
      modelSelection: run.workerConfig.modelSelection,
      runtimeMode: run.workerConfig.runtimeMode,
      interactionMode: run.workerConfig.interactionMode,
      branch: run.workerConfig.branch,
      worktreePath: run.workerConfig.worktreePath,
    });

    await runtime.runPromise(coordinator.drain);
    expect(commands.slice(0, 3).map((command) => command.commandId)).toEqual(
      commands.slice(3).map((command) => command.commandId),
    );

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("fails a pending run when its parent thread was deleted", async () => {
    const commands: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () =>
        Effect.succeed({
          ...readModel,
          threads: readModel.threads.map((thread) => ({ ...thread, deletedAt: now })),
        }),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      streamDomainEvents: Stream.empty,
    };
    const workflows: ProjectionWorkflowRepositoryShape = {
      upsertRun: () => Effect.void,
      getByRunId: () => Effect.succeed(Option.some(run)),
      listIncomplete: () => Effect.succeed([run]),
      listAll: () => Effect.succeed([run]),
      listShellSnapshot: () => Effect.succeed({ runs: [], artifacts: [] }),
      upsertArtifact: () => Effect.void,
      getArtifactById: () => Effect.succeed(Option.some(inputArtifact)),
      listAllArtifacts: () => Effect.succeed([inputArtifact]),
      setNodeInputArtifact: () => Effect.void,
      startNode: () => Effect.void,
      recordNodeResult: () => Effect.void,
      finalizeRun: () => Effect.void,
    };

    runtime = ManagedRuntime.make(
      WorkflowCoordinatorReactorLive.pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provideMerge(Layer.succeed(ProjectionWorkflowRepository, workflows)),
      ),
    );
    const coordinator = await runtime.runPromise(Effect.service(WorkflowCoordinatorReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(coordinator.start().pipe(Scope.provide(scope)));

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "workflow.run.finalize",
      status: "failed",
      artifact: {
        payload: {
          kind: "final-result",
          body: "Parent thread was deleted before the worker started.",
        },
      },
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("retries the worker turn after recovering a node already marked running", async () => {
    const childThreadId = ThreadId.make("workflow:workflow-run:node:worker:worker");
    const parent = readModel.threads[0];
    if (!parent) {
      throw new Error("Expected a parent thread fixture.");
    }
    const runningRun: ProjectionWorkflowRun = {
      ...run,
      status: "running",
      nodes: [
        {
          nodeId,
          status: "running",
          inputArtifactId,
          workerThreadId: childThreadId,
          startedAt: now,
        },
      ],
    };
    const runningModel: OrchestrationReadModel = {
      ...readModel,
      workflowRuns: [runningRun],
      threads: [
        ...readModel.threads,
        {
          ...parent,
          id: childThreadId,
          parentThreadId,
          title: "Investigate",
        },
      ],
    };
    const commands: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(runningModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      streamDomainEvents: Stream.empty,
    };
    const workflows: ProjectionWorkflowRepositoryShape = {
      upsertRun: () => Effect.void,
      getByRunId: () => Effect.succeed(Option.some(runningRun)),
      listIncomplete: () => Effect.succeed([runningRun]),
      listAll: () => Effect.succeed([runningRun]),
      listShellSnapshot: () => Effect.succeed({ runs: [], artifacts: [] }),
      upsertArtifact: () => Effect.void,
      getArtifactById: () => Effect.succeed(Option.some(inputArtifact)),
      listAllArtifacts: () => Effect.succeed([inputArtifact]),
      setNodeInputArtifact: () => Effect.void,
      startNode: () => Effect.void,
      recordNodeResult: () => Effect.void,
      finalizeRun: () => Effect.void,
    };

    runtime = ManagedRuntime.make(
      WorkflowCoordinatorReactorLive.pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provideMerge(Layer.succeed(ProjectionWorkflowRepository, workflows)),
      ),
    );
    const coordinator = await runtime.runPromise(Effect.service(WorkflowCoordinatorReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(coordinator.start().pipe(Scope.provide(scope)));

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      type: "thread.turn.start",
      commandId: CommandId.make("workflow:workflow-run:node:worker:start-turn"),
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("does not record a finalized assistant segment while the worker turn is active", async () => {
    const childThreadId = ThreadId.make("workflow:workflow-run:node:worker:worker");
    const parent = readModel.threads[0];
    if (!parent) {
      throw new Error("Expected a parent thread fixture.");
    }
    const runningRun: ProjectionWorkflowRun = {
      ...run,
      status: "running",
      nodes: [
        {
          nodeId,
          status: "running",
          inputArtifactId,
          workerThreadId: childThreadId,
          startedAt: now,
        },
      ],
    };
    const runningModel: OrchestrationReadModel = {
      ...readModel,
      workflowRuns: [runningRun],
      threads: [
        ...readModel.threads,
        {
          ...parent,
          id: childThreadId,
          parentThreadId,
          title: "Investigate",
          messages: [
            {
              id: MessageId.make("approval-segment"),
              role: "assistant",
              text: "I need approval before continuing.",
              turnId: null,
              streaming: false,
              createdAt: now,
              updatedAt: now,
            },
          ],
          session: {
            threadId: childThreadId,
            status: "running",
            providerName: "Codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("active-turn"),
            lastError: null,
            updatedAt: now,
          },
        },
      ],
    };
    const commands: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(runningModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      streamDomainEvents: Stream.empty,
    };
    const workflows: ProjectionWorkflowRepositoryShape = {
      upsertRun: () => Effect.void,
      getByRunId: () => Effect.succeed(Option.some(runningRun)),
      listIncomplete: () => Effect.succeed([runningRun]),
      listAll: () => Effect.succeed([runningRun]),
      listShellSnapshot: () => Effect.succeed({ runs: [], artifacts: [] }),
      upsertArtifact: () => Effect.void,
      getArtifactById: () => Effect.succeed(Option.some(inputArtifact)),
      listAllArtifacts: () => Effect.succeed([inputArtifact]),
      setNodeInputArtifact: () => Effect.void,
      startNode: () => Effect.void,
      recordNodeResult: () => Effect.void,
      finalizeRun: () => Effect.void,
    };

    runtime = ManagedRuntime.make(
      WorkflowCoordinatorReactorLive.pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provideMerge(Layer.succeed(ProjectionWorkflowRepository, workflows)),
      ),
    );
    const coordinator = await runtime.runPromise(Effect.service(WorkflowCoordinatorReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(coordinator.start().pipe(Scope.provide(scope)));

    expect(commands.map((command) => command.type)).toEqual(["thread.turn.start"]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("records a tool-only result after an idle runtime completes its turn", async () => {
    const childThreadId = ThreadId.make("workflow:workflow-run:node:worker:worker");
    const completedTurnId = TurnId.make("completed-turn");
    const parent = readModel.threads[0];
    if (!parent) {
      throw new Error("Expected a parent thread fixture.");
    }
    const runningRun: ProjectionWorkflowRun = {
      ...run,
      status: "running",
      nodes: [
        {
          nodeId,
          status: "running",
          inputArtifactId,
          workerThreadId: childThreadId,
          startedAt: now,
        },
      ],
    };
    const completedModel: OrchestrationReadModel = {
      ...readModel,
      workflowRuns: [runningRun],
      threads: [
        ...readModel.threads,
        {
          ...parent,
          id: childThreadId,
          parentThreadId,
          title: "Investigate",
          messages: [],
          latestTurn: {
            turnId: completedTurnId,
            state: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            assistantMessageId: null,
          },
          session: {
            threadId: childThreadId,
            status: "running",
            providerName: "Codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ],
    };
    const commands: OrchestrationCommand[] = [];
    const engine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(completedModel),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: commands.length };
        }),
      streamDomainEvents: Stream.empty,
    };
    const workflows: ProjectionWorkflowRepositoryShape = {
      upsertRun: () => Effect.void,
      getByRunId: () => Effect.succeed(Option.some(runningRun)),
      listIncomplete: () => Effect.succeed([runningRun]),
      listAll: () => Effect.succeed([runningRun]),
      listShellSnapshot: () => Effect.succeed({ runs: [], artifacts: [] }),
      upsertArtifact: () => Effect.void,
      getArtifactById: () => Effect.succeed(Option.some(inputArtifact)),
      listAllArtifacts: () => Effect.succeed([inputArtifact]),
      setNodeInputArtifact: () => Effect.void,
      startNode: () => Effect.void,
      recordNodeResult: () => Effect.void,
      finalizeRun: () => Effect.void,
    };

    runtime = ManagedRuntime.make(
      WorkflowCoordinatorReactorLive.pipe(
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provideMerge(Layer.succeed(ProjectionWorkflowRepository, workflows)),
      ),
    );
    const coordinator = await runtime.runPromise(Effect.service(WorkflowCoordinatorReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(coordinator.start().pipe(Scope.provide(scope)));

    expect(commands.map((command) => command.type)).toEqual([
      "thread.turn.start",
      "workflow.worker-result.record",
    ]);
    expect(commands[1]).toMatchObject({
      type: "workflow.worker-result.record",
      artifact: {
        payload: {
          kind: "worker-result",
          status: "completed",
          body: "Worker completed without a textual response.",
        },
      },
    });

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("reduces a one-node run through result and compact final artifact events", async () => {
    let model: OrchestrationReadModel = {
      ...readModel,
      workflowRuns: [],
    };
    let sequence = 0;
    const applyDecided = async (
      decided:
        | Omit<OrchestrationEvent, "sequence">
        | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
    ) => {
      const events = Array.isArray(decided) ? decided : [decided];
      for (const event of events) {
        sequence += 1;
        model = await Effect.runPromise(projectEvent(model, { ...event, sequence }));
      }
    };

    await applyDecided(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "workflow.run.request",
            commandId: CommandId.make("request-run"),
            runId,
            parentThreadId,
            definition: run.definition,
            workerConfig: run.workerConfig,
            inputArtifact,
            createdAt: now,
          },
          readModel: model,
        }),
      ),
    );
    expect(model.workflowRuns?.[0]).toMatchObject({
      status: "pending",
      nodes: [{ inputArtifactId, status: "pending" }],
    });

    const workerThreadId = ThreadId.make("workflow:workflow-run:node:worker:worker");
    await applyDecided(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "workflow.node.worker.start",
            commandId: CommandId.make("start-worker"),
            runId,
            nodeId,
            workerThreadId,
            startedAt: now,
          },
          readModel: model,
        }),
      ),
    );

    const resultArtifact: WorkflowArtifact = {
      id: WorkflowArtifactId.make("workflow-result"),
      runId,
      nodeId,
      producerThreadId: workerThreadId,
      payload: {
        kind: "worker-result",
        status: "completed",
        summary: "Completed the task.",
        body: "Completed the task with a concise outcome.",
        evidence: [{ label: "Worker thread", threadId: workerThreadId }],
        changedPaths: [],
      },
      createdAt: now,
    };
    await applyDecided(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "workflow.worker-result.record",
            commandId: CommandId.make("record-result"),
            runId,
            artifact: resultArtifact,
            completedAt: now,
          },
          readModel: model,
        }),
      ),
    );
    const finalArtifact: WorkflowArtifact = {
      id: WorkflowArtifactId.make("workflow-final"),
      runId,
      payload: {
        kind: "final-result",
        summary: "Completed the task.",
        body: "Compact result.",
        evidence: [{ label: "Worker thread", threadId: workerThreadId }],
      },
      createdAt: now,
    };
    await applyDecided(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "workflow.run.finalize",
            commandId: CommandId.make("finalize-run"),
            runId,
            parentThreadId,
            artifact: finalArtifact,
            status: "completed",
            completedAt: now,
          },
          readModel: model,
        }),
      ),
    );

    expect(model.workflowRuns?.[0]).toMatchObject({
      status: "completed",
      finalArtifactId: "workflow-final",
      nodes: [{ status: "completed", resultArtifactId: "workflow-result" }],
    });
  });

  it("finalizes a still-pending run as failed when the parent was deleted", async () => {
    let model: OrchestrationReadModel = {
      ...readModel,
      workflowRuns: [],
    };
    let sequence = 0;
    const applyDecided = async (
      decided:
        | Omit<OrchestrationEvent, "sequence">
        | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
    ) => {
      const events = Array.isArray(decided) ? decided : [decided];
      for (const event of events) {
        sequence += 1;
        model = await Effect.runPromise(projectEvent(model, { ...event, sequence }));
      }
    };

    await applyDecided(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "workflow.run.request",
            commandId: CommandId.make("request-run"),
            runId,
            parentThreadId,
            definition: run.definition,
            workerConfig: run.workerConfig,
            inputArtifact,
            createdAt: now,
          },
          readModel: model,
        }),
      ),
    );
    expect(model.workflowRuns?.[0]).toMatchObject({
      status: "pending",
      nodes: [{ status: "pending" }],
    });

    const failureArtifact: WorkflowArtifact = {
      id: WorkflowArtifactId.make("workflow-final"),
      runId,
      producerThreadId: parentThreadId,
      payload: {
        kind: "final-result",
        summary: "Parent thread was deleted before the worker started.",
        body: "Parent thread was deleted before the worker started.",
        evidence: [],
      },
      createdAt: now,
    };
    await applyDecided(
      await Effect.runPromise(
        decideOrchestrationCommand({
          command: {
            type: "workflow.run.finalize",
            commandId: CommandId.make("finalize-missing-parent"),
            runId,
            parentThreadId,
            artifact: failureArtifact,
            status: "failed",
            completedAt: now,
          },
          readModel: model,
        }),
      ),
    );

    expect(model.workflowRuns?.[0]).toMatchObject({
      status: "failed",
      finalArtifactId: "workflow-final",
      nodes: [{ status: "failed" }],
    });
  });
});
