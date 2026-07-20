import {
  CommandId,
  MessageId,
  ThreadId,
  WorkflowArtifactId,
  WorkflowDefinition,
  WorkflowRunId,
  type WorkflowArtifact,
  type WorkflowNodeRun,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import {
  ProjectionWorkflowRepository,
  type ProjectionWorkflowRun,
} from "../../persistence/Services/ProjectionWorkflows.ts";
import { renderWorkflowContextArtifact } from "../workflowContext.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  WorkflowCoordinatorReactor,
  type WorkflowCoordinatorReactorShape,
} from "../Services/WorkflowCoordinatorReactor.ts";

const MAX_FINAL_ARTIFACT_BODY_CHARS = 4_000;

function coordinatorCommandId(runId: WorkflowRunId, nodeId: string, action: string): CommandId {
  return CommandId.make(`workflow:${runId}:node:${nodeId}:${action}`);
}

function workerThreadId(runId: WorkflowRunId, nodeId: string): ThreadId {
  return ThreadId.make(`workflow:${runId}:node:${nodeId}:worker`);
}

function workerMessageId(runId: WorkflowRunId, nodeId: string): MessageId {
  return MessageId.make(`workflow:${runId}:node:${nodeId}:input`);
}

function workerResultArtifactId(runId: WorkflowRunId, nodeId: string): WorkflowArtifactId {
  return WorkflowArtifactId.make(`workflow:${runId}:node:${nodeId}:result`);
}

function finalArtifactId(runId: WorkflowRunId): WorkflowArtifactId {
  return WorkflowArtifactId.make(`workflow:${runId}:final`);
}

function compactSummary(body: string, fallback: string): string {
  const firstLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return (firstLine ?? fallback).slice(0, 500).trim() || fallback;
}

function compactBody(body: string): string {
  if (body.length <= MAX_FINAL_ARTIFACT_BODY_CHARS) {
    return body;
  }
  return `${body.slice(0, MAX_FINAL_ARTIFACT_BODY_CHARS).trimEnd()}\n\n[Worker result truncated]`;
}

function isCoordinatorRelevantEvent(type: string): boolean {
  return (
    type.startsWith("workflow.") ||
    type === "thread.message-sent" ||
    type === "thread.session-set" ||
    type === "thread.deleted"
  );
}

const makeWorkflowCoordinatorReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const workflowRepository = yield* ProjectionWorkflowRepository;
  let reconciling = false;
  let reconciliationQueued = false;

  const recordWorkerResult = Effect.fn("WorkflowCoordinatorReactor.recordWorkerResult")(
    function* (input: {
      readonly runId: WorkflowRunId;
      readonly node: WorkflowNodeRun;
      readonly workerThreadId: ThreadId;
      readonly status: "completed" | "failed";
      readonly body: string;
      readonly messageId?: MessageId;
    }) {
      const nodeId = input.node.nodeId;
      const createdAt = new Date().toISOString();
      const artifact: WorkflowArtifact = {
        id: workerResultArtifactId(input.runId, nodeId),
        runId: input.runId,
        nodeId,
        producerThreadId: input.workerThreadId,
        payload: {
          kind: "worker-result",
          status: input.status,
          summary: compactSummary(
            input.body,
            input.status === "completed" ? "Worker completed." : "Worker failed.",
          ),
          body: input.body,
          evidence: [
            {
              label: "Worker thread",
              threadId: input.workerThreadId,
              ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
            },
          ],
          changedPaths: [],
        },
        createdAt,
      };
      yield* orchestrationEngine.dispatch({
        type: "workflow.worker-result.record",
        commandId: coordinatorCommandId(input.runId, nodeId, "record-result"),
        runId: input.runId,
        artifact,
        completedAt: createdAt,
      });
    },
  );

  const startWorker = Effect.fn("WorkflowCoordinatorReactor.startWorker")(function* (input: {
    readonly runId: WorkflowRunId;
    readonly parentThreadId: ThreadId;
    readonly definition: WorkflowDefinition;
    readonly workerConfig: ProjectionWorkflowRun["workerConfig"];
    readonly node: WorkflowNodeRun;
  }) {
    const definitionNode = input.definition.nodes.find((node) => node.id === input.node.nodeId);
    if (!definitionNode) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const parent = readModel.threads.find(
      (thread) => thread.id === input.parentThreadId && thread.deletedAt === null,
    );
    const nodeId = input.node.nodeId;
    if (!parent) {
      const createdAt = new Date().toISOString();
      const body = "Parent thread was deleted before the worker started.";
      yield* orchestrationEngine.dispatch({
        type: "workflow.run.finalize",
        commandId: coordinatorCommandId(input.runId, nodeId, "finalize-missing-parent"),
        runId: input.runId,
        parentThreadId: input.parentThreadId,
        artifact: {
          id: finalArtifactId(input.runId),
          runId: input.runId,
          producerThreadId: input.parentThreadId,
          payload: {
            kind: "final-result",
            summary: body,
            body,
            evidence: [],
          },
          createdAt,
        },
        status: "failed",
        completedAt: createdAt,
      });
      return;
    }

    const childThreadId = workerThreadId(input.runId, nodeId);
    const createdAt = new Date().toISOString();
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: coordinatorCommandId(input.runId, nodeId, "create-worker"),
      threadId: childThreadId,
      projectId: parent.projectId,
      parentThreadId: parent.id,
      title: definitionNode.title,
      modelSelection: input.workerConfig.modelSelection,
      runtimeMode: input.workerConfig.runtimeMode,
      interactionMode: input.workerConfig.interactionMode,
      branch: input.workerConfig.branch,
      worktreePath: input.workerConfig.worktreePath,
      ...(input.workerConfig.reviewSnapshot !== undefined
        ? { reviewSnapshot: input.workerConfig.reviewSnapshot }
        : {}),
      createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "workflow.node.worker.start",
      commandId: coordinatorCommandId(input.runId, nodeId, "start-worker"),
      runId: input.runId,
      nodeId,
      workerThreadId: childThreadId,
      startedAt: createdAt,
    });
    yield* dispatchWorkerTurn({
      runId: input.runId,
      parentThreadId: input.parentThreadId,
      definition: input.definition,
      workerConfig: input.workerConfig,
      node: {
        ...input.node,
        status: "running",
        workerThreadId: childThreadId,
      },
    });
  });

  const dispatchWorkerTurn = Effect.fn("WorkflowCoordinatorReactor.dispatchWorkerTurn")(
    function* (input: {
      readonly runId: WorkflowRunId;
      readonly parentThreadId: ThreadId;
      readonly definition: WorkflowDefinition;
      readonly workerConfig: ProjectionWorkflowRun["workerConfig"];
      readonly node: WorkflowNodeRun;
    }) {
      const definitionNode = input.definition.nodes.find((node) => node.id === input.node.nodeId);
      if (
        !definitionNode ||
        input.node.inputArtifactId === undefined ||
        input.node.workerThreadId === undefined
      ) {
        return;
      }
      const inputArtifact = yield* workflowRepository.getArtifactById({
        artifactId: input.node.inputArtifactId,
      });
      if (Option.isNone(inputArtifact) || inputArtifact.value.payload.kind !== "input-context") {
        return;
      }
      const readModel = yield* orchestrationEngine.getReadModel();
      const parent = readModel.threads.find(
        (thread) => thread.id === input.parentThreadId && thread.deletedAt === null,
      );
      if (!parent) {
        return;
      }
      const createdAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: coordinatorCommandId(input.runId, input.node.nodeId, "start-turn"),
        threadId: input.node.workerThreadId,
        message: {
          messageId: workerMessageId(input.runId, input.node.nodeId),
          role: "user",
          text: `${definitionNode.prompt}\n\n${renderWorkflowContextArtifact(inputArtifact.value.payload)}`,
          attachments: [],
        },
        runtimeMode: input.workerConfig.runtimeMode,
        interactionMode: input.workerConfig.interactionMode,
        createdAt,
      });
    },
  );

  const finalizeRun = Effect.fn("WorkflowCoordinatorReactor.finalizeRun")(function* (input: {
    readonly runId: WorkflowRunId;
    readonly parentThreadId: ThreadId;
    readonly node: WorkflowNodeRun;
  }) {
    if (input.node.resultArtifactId === undefined) {
      return;
    }
    const resultArtifact = yield* workflowRepository.getArtifactById({
      artifactId: input.node.resultArtifactId,
    });
    if (Option.isNone(resultArtifact) || resultArtifact.value.payload.kind !== "worker-result") {
      return;
    }
    const createdAt = new Date().toISOString();
    const result = resultArtifact.value.payload;
    const artifact: WorkflowArtifact = {
      id: finalArtifactId(input.runId),
      runId: input.runId,
      producerThreadId: resultArtifact.value.producerThreadId,
      payload: {
        kind: "final-result",
        summary: result.summary,
        body: compactBody(result.body),
        evidence: result.evidence,
      },
      createdAt,
    };
    yield* orchestrationEngine.dispatch({
      type: "workflow.run.finalize",
      commandId: coordinatorCommandId(input.runId, input.node.nodeId, "finalize"),
      runId: input.runId,
      parentThreadId: input.parentThreadId,
      artifact,
      status: result.status,
      completedAt: createdAt,
    });
  });

  const reconcileRun = Effect.fn("WorkflowCoordinatorReactor.reconcileRun")(function* (
    run: ProjectionWorkflowRun,
  ) {
    const node = run.nodes[0];
    if (!node) {
      return;
    }
    if (node.status === "pending") {
      yield* startWorker({
        runId: run.id,
        parentThreadId: run.parentThreadId,
        definition: run.definition,
        workerConfig: run.workerConfig,
        node,
      });
      return;
    }
    if (node.status === "completed" || node.status === "failed") {
      yield* finalizeRun({
        runId: run.id,
        parentThreadId: run.parentThreadId,
        node,
      });
      return;
    }
    if (node.status !== "running" || node.workerThreadId === undefined) {
      return;
    }

    yield* dispatchWorkerTurn({
      runId: run.id,
      parentThreadId: run.parentThreadId,
      definition: run.definition,
      workerConfig: run.workerConfig,
      node,
    });

    const readModel = yield* orchestrationEngine.getReadModel();
    const worker = readModel.threads.find((thread) => thread.id === node.workerThreadId);
    if (!worker || worker.deletedAt !== null) {
      yield* recordWorkerResult({
        runId: run.id,
        node,
        workerThreadId: node.workerThreadId,
        status: "failed",
        body: "Worker thread was deleted before it produced a result.",
      });
      return;
    }
    const session = worker.session;
    if (session === null || session.activeTurnId !== null || session.status === "starting") {
      return;
    }
    const latestTurn = worker.latestTurn;
    if (latestTurn?.state === "completed") {
      const completedMessage =
        latestTurn.assistantMessageId === null
          ? undefined
          : worker.messages.find((message) => message.id === latestTurn.assistantMessageId);
      yield* recordWorkerResult({
        runId: run.id,
        node,
        workerThreadId: node.workerThreadId,
        status: "completed",
        body: completedMessage?.text || "Worker completed without a textual response.",
        ...(completedMessage === undefined ? {} : { messageId: completedMessage.id }),
      });
      return;
    }
    if (latestTurn?.state === "error" || latestTurn?.state === "interrupted") {
      yield* recordWorkerResult({
        runId: run.id,
        node,
        workerThreadId: node.workerThreadId,
        status: "failed",
        body:
          session.lastError ?? `Worker turn was ${latestTurn.state} before it produced a result.`,
      });
      return;
    }
    if (
      session.status === "error" ||
      session.status === "interrupted" ||
      session.status === "stopped"
    ) {
      yield* recordWorkerResult({
        runId: run.id,
        node,
        workerThreadId: node.workerThreadId,
        status: "failed",
        body:
          session.lastError ??
          (session.status === "error"
            ? "Worker session failed before producing a result."
            : `Worker session was ${session.status} before it produced a result.`),
      });
    }
  });

  const reconcile = Effect.fn("WorkflowCoordinatorReactor.reconcile")(function* () {
    if (reconciling) {
      reconciliationQueued = true;
      return;
    }
    reconciling = true;
    try {
      do {
        reconciliationQueued = false;
        const runs = yield* workflowRepository.listIncomplete();
        yield* Effect.forEach(runs, reconcileRun, { concurrency: 1 });
      } while (reconciliationQueued);
    } finally {
      reconciling = false;
    }
  });

  const reconcileSafely = reconcile().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("workflow coordinator reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const start: WorkflowCoordinatorReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        isCoordinatorRelevantEvent(event.type) ? reconcileSafely : Effect.void,
      ),
    );
    yield* reconcileSafely;
  });

  return {
    start,
    drain: reconcileSafely,
  } satisfies WorkflowCoordinatorReactorShape;
});

export const WorkflowCoordinatorReactorLive = Layer.effect(
  WorkflowCoordinatorReactor,
  makeWorkflowCoordinatorReactor,
);
