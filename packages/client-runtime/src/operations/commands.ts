import {
  CommandId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2CheckpointUnavailableError,
  WS_METHODS,
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2CreationSource,
  type PlanId,
  type ProjectId,
  type ProjectScript,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  type ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { request } from "../rpc/client.ts";

interface CommandMetadata {
  readonly commandId?: CommandId;
  readonly createdAt?: string;
  readonly creationSource?: OrchestrationV2CreationSource;
}

export interface CreateProjectInput extends CommandMetadata {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createWorkspaceRootIfMissing?: boolean;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface UpdateProjectInput extends CommandMetadata {
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface DeleteProjectInput extends CommandMetadata {
  readonly projectId: ProjectId;
  readonly force?: boolean;
}

export interface CreateThreadInput extends CommandMetadata {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface ThreadCommandInput extends CommandMetadata {
  readonly threadId: ThreadId;
}

export type DeleteThreadInput = ThreadCommandInput;
export type ArchiveThreadInput = ThreadCommandInput;
export type UnarchiveThreadInput = ThreadCommandInput;

export interface UpdateThreadMetadataInput extends ThreadCommandInput {
  readonly title?: string;
  readonly modelSelection?: ModelSelection;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export interface SetThreadRuntimeModeInput extends ThreadCommandInput {
  readonly runtimeMode: RuntimeMode;
}

export interface SetThreadInteractionModeInput extends ThreadCommandInput {
  readonly interactionMode: ProviderInteractionMode;
}

interface StartThreadBootstrap {
  readonly createThread?: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly createdAt: string;
  };
  readonly prepareWorktree?: {
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly branch?: string;
    readonly startFromOrigin?: boolean;
  };
  readonly runSetupScript?: boolean;
}

export interface StartThreadTurnInput extends ThreadCommandInput {
  readonly message: {
    readonly messageId: MessageId;
    readonly role: "user";
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  };
  readonly modelSelection?: ModelSelection;
  readonly titleSeed?: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly bootstrap?: StartThreadBootstrap;
  readonly sourceProposedPlan?: { readonly threadId: ThreadId; readonly planId: PlanId };
  readonly dispatchMode?: "auto" | "queue" | "steer" | "restart";
}

export interface InterruptThreadTurnInput extends ThreadCommandInput {
  readonly runId?: RunId;
  /** Temporary caller compatibility while UI naming moves from turns to runs. */
  readonly turnId?: string;
}

export interface RespondToThreadApprovalInput extends ThreadCommandInput {
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
}

export interface RespondToThreadUserInputInput extends ThreadCommandInput {
  readonly requestId: RuntimeRequestId;
  readonly answers: ProviderUserInputAnswers;
}

export interface RevertThreadCheckpointInput extends ThreadCommandInput {
  readonly checkpointId?: string;
  readonly scopeId?: string;
  readonly turnCount?: number;
}

export type StopThreadSessionInput = ThreadCommandInput;

export interface ForkThreadFromRunInput extends CommandMetadata {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly runId: RunId;
  readonly title?: string;
}

export interface MergeThreadBackInput extends CommandMetadata {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly runId: RunId;
}

export interface ReorderQueuedRunInput extends ThreadCommandInput {
  readonly runId: RunId;
  readonly beforeRunId: RunId | null;
}

export interface PromoteQueuedRunInput extends ThreadCommandInput {
  readonly queuedRunId: RunId;
  readonly targetRunId: RunId;
}

const allocateCommandId = Effect.fn("EnvironmentCommands.allocateCommandId")(function* (
  input: CommandMetadata,
) {
  if (input.commandId !== undefined) return input.commandId;
  const crypto = yield* Crypto.Crypto;
  return CommandId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie));
});

const dispatch = (command: OrchestrationV2Command) =>
  request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);

const getProjection = (threadId: ThreadId) =>
  request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, { threadId });

const persistAttachments = Effect.fn("EnvironmentCommands.persistAttachments")(function* (
  threadId: ThreadId,
  messageId: MessageId,
  attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>,
) {
  const stored = attachments.filter(
    (attachment): attachment is ChatAttachment => "id" in attachment,
  );
  const uploads = attachments.filter(
    (attachment): attachment is UploadChatAttachment => "dataUrl" in attachment,
  );
  if (uploads.length === 0) return stored;
  const result = yield* request(WS_METHODS.assetsPersistChatAttachments, {
    threadId,
    messageId,
    attachments: uploads,
  });
  if (stored.length === 0) return result.attachments;
  const byUpload = new Map(
    uploads.map((attachment, index) => [attachment, result.attachments[index]]),
  );
  return attachments.flatMap((attachment) => {
    if ("id" in attachment) return [attachment];
    const persisted = byUpload.get(attachment);
    return persisted === undefined ? [] : [persisted];
  });
});

const mutateProject = Effect.fn("EnvironmentCommands.mutateProject")(function* (
  mutation:
    | {
        readonly type: "project.create";
        readonly commandId: CommandId;
        readonly projectId: ProjectId;
        readonly title: string;
        readonly workspaceRoot: string;
        readonly createWorkspaceRootIfMissing?: boolean;
        readonly defaultModelSelection?: ModelSelection | null;
        readonly scripts?: ReadonlyArray<ProjectScript>;
      }
    | {
        readonly type: "project.update";
        readonly commandId: CommandId;
        readonly projectId: ProjectId;
        readonly title?: string;
        readonly workspaceRoot?: string;
        readonly defaultModelSelection?: ModelSelection | null;
        readonly scripts?: ReadonlyArray<ProjectScript>;
      }
    | {
        readonly type: "project.delete";
        readonly commandId: CommandId;
        readonly projectId: ProjectId;
        readonly force?: boolean;
      },
) {
  return yield* request(WS_METHODS.projectsMutate, mutation);
});

export const createProject = Effect.fn("EnvironmentCommands.createProject")(function* (
  input: CreateProjectInput,
) {
  return yield* mutateProject({
    type: "project.create",
    commandId: yield* allocateCommandId(input),
    projectId: input.projectId,
    title: input.title,
    workspaceRoot: input.workspaceRoot,
    ...(input.createWorkspaceRootIfMissing === undefined
      ? {}
      : { createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing }),
    ...(input.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: input.defaultModelSelection }),
    ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
  });
});

export const updateProject = Effect.fn("EnvironmentCommands.updateProject")(function* (
  input: UpdateProjectInput,
) {
  return yield* mutateProject({
    type: "project.update",
    commandId: yield* allocateCommandId(input),
    projectId: input.projectId,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    ...(input.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: input.defaultModelSelection }),
    ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
  });
});

export const deleteProject = Effect.fn("EnvironmentCommands.deleteProject")(function* (
  input: DeleteProjectInput,
) {
  return yield* mutateProject({
    type: "project.delete",
    commandId: yield* allocateCommandId(input),
    projectId: input.projectId,
    ...(input.force === undefined ? {} : { force: input.force }),
  });
});

export const createThread = Effect.fn("EnvironmentCommands.createThread")(function* (
  input: CreateThreadInput,
) {
  return yield* dispatch({
    type: "thread.create",
    commandId: yield* allocateCommandId(input),
    createdBy: "user",
    creationSource: input.creationSource ?? "web",
    threadId: input.threadId,
    projectId: input.projectId,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    branch: input.branch,
    worktreePath: input.worktreePath,
  });
});

function simpleThreadCommand(
  type: "thread.delete" | "thread.archive" | "thread.unarchive",
  input: ThreadCommandInput,
) {
  return allocateCommandId(input).pipe(
    Effect.flatMap((commandId) => dispatch({ type, commandId, threadId: input.threadId })),
  );
}

export const deleteThread = Effect.fn("EnvironmentCommands.deleteThread")(function* (
  input: DeleteThreadInput,
) {
  return yield* simpleThreadCommand("thread.delete", input);
});

export const archiveThread = Effect.fn("EnvironmentCommands.archiveThread")(function* (
  input: ArchiveThreadInput,
) {
  return yield* simpleThreadCommand("thread.archive", input);
});

export const unarchiveThread = Effect.fn("EnvironmentCommands.unarchiveThread")(function* (
  input: UnarchiveThreadInput,
) {
  return yield* simpleThreadCommand("thread.unarchive", input);
});

export const updateThreadMetadata = Effect.fn("EnvironmentCommands.updateThreadMetadata")(
  function* (input: UpdateThreadMetadataInput) {
    const commandId = yield* allocateCommandId(input);
    let result = null;
    if (
      input.title !== undefined ||
      input.branch !== undefined ||
      input.worktreePath !== undefined
    ) {
      result = yield* dispatch({
        type: "thread.metadata.update",
        commandId,
        threadId: input.threadId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.branch === undefined ? {} : { branch: input.branch }),
        ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
      });
    }
    if (input.modelSelection !== undefined) {
      const projection = yield* getProjection(input.threadId);
      const type =
        projection.thread.providerInstanceId === input.modelSelection.instanceId
          ? ("thread.model-selection.set" as const)
          : ("provider.switch" as const);
      result = yield* dispatch({
        type,
        commandId: result === null ? commandId : CommandId.make(`${commandId}:model-selection`),
        threadId: input.threadId,
        modelSelection: input.modelSelection,
      });
    }
    return result ?? { sequence: 0 };
  },
);

export const setThreadRuntimeMode = Effect.fn("EnvironmentCommands.setThreadRuntimeMode")(
  function* (input: SetThreadRuntimeModeInput) {
    return yield* dispatch({
      type: "thread.runtime-mode.set",
      commandId: yield* allocateCommandId(input),
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
    });
  },
);

export const setThreadInteractionMode = Effect.fn("EnvironmentCommands.setThreadInteractionMode")(
  function* (input: SetThreadInteractionModeInput) {
    return yield* dispatch({
      type: "thread.interaction-mode.set",
      commandId: yield* allocateCommandId(input),
      threadId: input.threadId,
      interactionMode: input.interactionMode,
    });
  },
);

export const startThreadTurn = Effect.fn("EnvironmentCommands.startThreadTurn")(function* (
  input: StartThreadTurnInput,
) {
  const commandId = yield* allocateCommandId(input);
  const attachments = yield* persistAttachments(
    input.threadId,
    input.message.messageId,
    input.message.attachments,
  );
  const bootstrap = input.bootstrap?.createThread;
  const prepareWorktree = input.bootstrap?.prepareWorktree;
  if (bootstrap !== undefined || prepareWorktree !== undefined) {
    const existingProjection =
      bootstrap === undefined ? yield* getProjection(input.threadId) : null;
    const thread = bootstrap ?? existingProjection!.thread;
    const workspaceStrategy =
      prepareWorktree !== undefined
        ? {
            type: "worktree" as const,
            baseRef: prepareWorktree.baseBranch,
            ...(prepareWorktree.branch === undefined ? {} : { branch: prepareWorktree.branch }),
            ...(prepareWorktree.startFromOrigin === undefined
              ? {}
              : { startFromOrigin: prepareWorktree.startFromOrigin }),
          }
        : bootstrap?.worktreePath
          ? {
              type: "existing_worktree" as const,
              worktreePath: bootstrap.worktreePath,
              ...(bootstrap.branch === null ? {} : { branch: bootstrap.branch }),
            }
          : {
              type: "root" as const,
              ...(bootstrap?.branch === null || bootstrap?.branch === undefined
                ? {}
                : { branch: bootstrap.branch }),
            };
    return yield* request(ORCHESTRATION_V2_WS_METHODS.launchThread, {
      commandId,
      creationSource: input.creationSource ?? "web",
      threadId: input.threadId,
      ...(bootstrap === undefined ? { reuseExistingThread: true } : {}),
      projectId: thread.projectId,
      title: thread.title,
      modelSelection: input.modelSelection ?? thread.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      workspaceStrategy,
      initialMessage: {
        messageId: input.message.messageId,
        text: input.message.text,
        attachments,
      },
    });
  }

  const projection = yield* getProjection(input.threadId);
  const activeRun = projection.runs.findLast(
    (run) =>
      run.status === "preparing" ||
      run.status === "starting" ||
      run.status === "running" ||
      run.status === "waiting",
  );
  const requestedMode = input.dispatchMode ?? "auto";
  const activeProviderThread =
    activeRun === undefined
      ? undefined
      : projection.providerThreads.find((thread) => thread.id === activeRun.providerThreadId);
  const activeProviderSession =
    activeProviderThread?.providerSessionId === null ||
    activeProviderThread?.providerSessionId === undefined
      ? undefined
      : projection.providerSessions.find(
          (session) => session.id === activeProviderThread.providerSessionId,
        );
  const turnCapabilities = activeProviderSession?.capabilities.turns;
  const dispatchMode =
    activeRun === undefined
      ? ({ type: "start_immediately" } as const)
      : requestedMode === "steer"
        ? ({ type: "steer_active", targetRunId: activeRun.id } as const)
        : requestedMode === "restart"
          ? ({ type: "restart_active", targetRunId: activeRun.id } as const)
          : requestedMode === "queue"
            ? ({ type: "queue_after_active" } as const)
            : turnCapabilities?.supportsActiveSteering === true
              ? ({ type: "steer_active", targetRunId: activeRun.id } as const)
              : turnCapabilities?.supportsQueuedMessages === true
                ? ({ type: "queue_after_active" } as const)
                : turnCapabilities?.supportsSteeringByInterruptRestart === true
                  ? ({ type: "restart_active", targetRunId: activeRun.id } as const)
                  : ({ type: "queue_after_active" } as const);
  return yield* dispatch({
    type: "message.dispatch",
    commandId,
    createdBy: "user",
    creationSource: input.creationSource ?? "web",
    threadId: input.threadId,
    messageId: input.message.messageId,
    text: input.message.text,
    attachments,
    ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
    ...(input.sourceProposedPlan === undefined ? {} : { sourcePlanRef: input.sourceProposedPlan }),
    dispatchMode,
  });
});

export const interruptThreadTurn = Effect.fn("EnvironmentCommands.interruptThreadTurn")(function* (
  input: InterruptThreadTurnInput,
) {
  const projection = yield* getProjection(input.threadId);
  const runId =
    input.runId ??
    (input.turnId as RunId | undefined) ??
    projection.runs.findLast(
      (run) =>
        run.status === "preparing" ||
        run.status === "starting" ||
        run.status === "running" ||
        run.status === "waiting",
    )?.id;
  if (runId === undefined) return { sequence: 0 };
  return yield* dispatch({
    type: "run.interrupt",
    commandId: yield* allocateCommandId(input),
    threadId: input.threadId,
    runId,
  });
});

export const respondToThreadApproval = Effect.fn("EnvironmentCommands.respondToThreadApproval")(
  function* (input: RespondToThreadApprovalInput) {
    return yield* dispatch({
      type: "runtime-request.respond",
      commandId: yield* allocateCommandId(input),
      threadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision,
    });
  },
);

export const respondToThreadUserInput = Effect.fn("EnvironmentCommands.respondToThreadUserInput")(
  function* (input: RespondToThreadUserInputInput) {
    return yield* dispatch({
      type: "runtime-request.respond",
      commandId: yield* allocateCommandId(input),
      threadId: input.threadId,
      requestId: input.requestId,
      answers: input.answers,
    });
  },
);

export const revertThreadCheckpoint = Effect.fn("EnvironmentCommands.revertThreadCheckpoint")(
  function* (input: RevertThreadCheckpointInput) {
    const projection = yield* getProjection(input.threadId);
    const checkpoint =
      projection.checkpoints.find(
        (candidate) => candidate.id === input.checkpointId && candidate.scopeId === input.scopeId,
      ) ??
      projection.checkpoints.findLast((candidate) =>
        input.turnCount === 0
          ? candidate.ordinalWithinScope === 0 && candidate.appRunOrdinal === null
          : candidate.appRunOrdinal === input.turnCount,
      );
    if (checkpoint === undefined || checkpoint.status !== "ready") {
      const target =
        input.checkpointId === undefined
          ? `run ordinal ${input.turnCount ?? "unknown"}`
          : `checkpoint ${input.checkpointId}`;
      return yield* new OrchestrationV2CheckpointUnavailableError({
        threadId: input.threadId,
        target,
      });
    }
    return yield* dispatch({
      type: "checkpoint.rollback",
      commandId: yield* allocateCommandId(input),
      threadId: input.threadId,
      scopeId: checkpoint.scopeId,
      checkpointId: checkpoint.id,
    });
  },
);

export const stopThreadSession = Effect.fn("EnvironmentCommands.stopThreadSession")(function* (
  input: StopThreadSessionInput,
) {
  const projection = yield* getProjection(input.threadId);
  const commandId = yield* allocateCommandId(input);
  let result = { sequence: 0 };
  for (const session of projection.providerSessions) {
    result = yield* dispatch({
      type: "provider-session.detach",
      commandId: CommandId.make(`${commandId}:detach:${session.id}`),
      threadId: input.threadId,
      providerSessionId: session.id,
      reason: "client-requested",
    });
  }
  return result;
});

export const forkThreadFromRun = Effect.fn("EnvironmentCommands.forkThreadFromRun")(function* (
  input: ForkThreadFromRunInput,
) {
  return yield* dispatch({
    type: "thread.fork",
    commandId: yield* allocateCommandId(input),
    createdBy: "user",
    creationSource: input.creationSource ?? "web",
    sourceThreadId: input.sourceThreadId,
    targetThreadId: input.targetThreadId,
    sourcePoint: { type: "run", runId: input.runId },
    ...(input.title === undefined ? {} : { title: input.title }),
  });
});

export const mergeThreadBack = Effect.fn("EnvironmentCommands.mergeThreadBack")(function* (
  input: MergeThreadBackInput,
) {
  return yield* dispatch({
    type: "thread.merge_back",
    commandId: yield* allocateCommandId(input),
    createdBy: "user",
    creationSource: input.creationSource ?? "web",
    sourceThreadId: input.sourceThreadId,
    targetThreadId: input.targetThreadId,
    sourcePoint: { type: "run", runId: input.runId },
  });
});

export const reorderQueuedRun = Effect.fn("EnvironmentCommands.reorderQueuedRun")(function* (
  input: ReorderQueuedRunInput,
) {
  return yield* dispatch({
    type: "queued-run.reorder",
    commandId: yield* allocateCommandId(input),
    threadId: input.threadId,
    runId: input.runId,
    beforeRunId: input.beforeRunId,
  });
});

export const promoteQueuedRun = Effect.fn("EnvironmentCommands.promoteQueuedRun")(function* (
  input: PromoteQueuedRunInput,
) {
  return yield* dispatch({
    type: "queued-message.promote-to-steer",
    commandId: yield* allocateCommandId(input),
    threadId: input.threadId,
    queuedRunId: input.queuedRunId,
    targetRunId: input.targetRunId,
  });
});
