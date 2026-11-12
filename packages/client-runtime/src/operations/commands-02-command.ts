import {
  type ThreadLinkedPullRequest,
  CommandId,
  CheckpointId,
  CheckpointScopeId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2CheckpointUnavailableError,
  WS_METHODS,
  type ChatAttachment,
  MessageId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2CreationSource,
  type PlanId,
  type ProjectId,
  type ProjectIconOverride,
  type ProjectScript,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  type RunId,
  type RuntimeMode,
  type RuntimeRequestId,
  type ThreadId,
  type ThreadEnvMode,
  type UploadChatAttachment,
  type GuestMessageId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import { getInitialServerConfig, request } from "../rpc/client.ts";

export interface CommandMetadata {
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
  readonly autoPull?: boolean;
  readonly projectIcon?: ProjectIconOverride | null;
  readonly faviconPath?: string | null;
  readonly defaultThreadEnvMode?: ThreadEnvMode | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
  readonly pinned?: boolean;
  readonly archived?: boolean;
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

export interface DeleteThreadInput extends ThreadCommandInput {
  /** The server deletes only a thread with no runs and no messages. */
  readonly onlyIfUnused?: boolean;
}
export type ArchiveThreadInput = ThreadCommandInput;
export type UnarchiveThreadInput = ThreadCommandInput;
export type SettleThreadInput = ThreadCommandInput;

export interface UnsettleThreadInput extends ThreadCommandInput {
  readonly reason: "user";
}

export interface PinThreadInput extends ThreadCommandInput {
  readonly orderKey?: string;
}
export type UnpinThreadInput = ThreadCommandInput;

export interface ReorderPinnedThreadInput extends ThreadCommandInput {
  readonly orderKey: string;
}

export interface ReorderActiveThreadInput extends ThreadCommandInput {
  readonly orderKey: string;
}

export interface SnoozeThreadInput extends ThreadCommandInput {
  readonly snoozedUntil: string;
}

export interface UnsnoozeThreadInput extends ThreadCommandInput {
  readonly reason: "user";
}

export interface VisitThreadInput extends ThreadCommandInput {
  readonly visitedAt: string;
  /** Counts toward search frecency; `searchQuery` is the palette query that picked it. */
  readonly opened?: boolean;
  readonly searchQuery?: string;
}

export type MarkThreadUnreadInput = ThreadCommandInput;

export interface UpdateThreadMetadataInput extends ThreadCommandInput {
  readonly limitRecovery?: import("@t3tools/contracts").OrchestrationV2LimitRecoveryUpdate | null;
  readonly title?: string;
  readonly modelSelection?: ModelSelection;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly regenerateTitle?: boolean;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null;
  readonly expectedEmpty?: boolean;
}

export interface SetThreadRuntimeModeInput extends ThreadCommandInput {
  readonly runtimeMode: RuntimeMode;
}

export interface SetThreadInteractionModeInput extends ThreadCommandInput {
  readonly interactionMode: ProviderInteractionMode;
}

export interface StartThreadBootstrap {
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
    readonly requireWorktree?: boolean;
    readonly projectCwd: string;
    readonly baseBranch: string;
    readonly branch?: string;
    readonly startFromOrigin?: boolean;
  };
  readonly runSetupScript?: boolean;
}

export interface StartThreadTurnInput extends ThreadCommandInput {
  readonly manualContinuationOfRunId?: RunId;
  readonly message: {
    readonly messageId: MessageId;
    readonly role: "user";
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
    readonly context?: import("@t3tools/contracts").OrchestrationMessageContext;
    readonly idleCompaction?: import("@t3tools/contracts").OrchestrationV2IdleCompaction;
  };
  readonly modelSelection?: ModelSelection;
  readonly titleSeed?: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly bootstrap?: StartThreadBootstrap;
  readonly sourceProposedPlan?: { readonly threadId: ThreadId; readonly planId: PlanId };
  readonly dispatchMode?: "auto" | "queue" | "steer" | "restart" | "start";
}

export interface InterruptThreadTurnInput extends ThreadCommandInput {
  readonly runId?: RunId;
  readonly subagentId?: NodeId;
  readonly turnId?: string;
}

export interface RespondToThreadApprovalInput extends ThreadCommandInput {
  readonly requestId: RuntimeRequestId;
  readonly decision: ProviderApprovalDecision;
  readonly feedback?: string;
}

export interface RespondToThreadUserInputInput extends ThreadCommandInput {
  readonly requestId: RuntimeRequestId;
  readonly answers: ProviderUserInputAnswers;
  readonly attachmentsByQuestionId?: import("@t3tools/contracts").UserInputAttachments;
}

export interface DismissThreadUserInputInput extends ThreadCommandInput {
  readonly requestId: RuntimeRequestId;
}

export interface RevertThreadCheckpointInput extends ThreadCommandInput {
  readonly restoreFiles?: boolean;
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

export interface ForkSideChatInput extends CommandMetadata {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly title?: string;
}

export interface MergeThreadBackInput extends CommandMetadata {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly runId: RunId;
}

export interface ResumeThreadQueueInput extends ThreadCommandInput {
  readonly runId?: RunId;
}

export interface PromoteQueuedRunInput extends ThreadCommandInput {
  readonly queuedRunId: RunId;
  readonly targetRunId: RunId;
}

export interface CancelQueuedRunInput extends ThreadCommandInput {
  readonly runId: RunId;
}

export interface RetryWorkspacePreparationInput extends ThreadCommandInput {
  readonly runId: RunId;
}

export interface EditQueuedRunInput extends ThreadCommandInput {
  readonly runId: RunId;
  readonly text: string;
  /**
   * Full replacement attachment list for the queued message. Omitted =
   * text-only edit that leaves attachments untouched.
   */
  readonly edit?: {
    readonly messageId: MessageId;
    readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
    readonly context?: import("@t3tools/contracts").OrchestrationMessageContext;
  };
}

export const allocateCommandId = Effect.fn("EnvironmentCommands.allocateCommandId")(function* (
  input: CommandMetadata,
) {
  if (input.commandId !== undefined) return input.commandId;
  const random = yield* SecureRandom.SecureRandom;
  return CommandId.make(yield* random.uuidV4());
});

export const dispatch = (command: OrchestrationV2Command) =>
  request(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, command);

export const getProjection = (threadId: ThreadId) =>
  request(ORCHESTRATION_V2_WS_METHODS.getThreadProjection, { threadId });

export const persistAttachments = Effect.fn("EnvironmentCommands.persistAttachments")(function* (
  threadId: ThreadId,
  messageId: MessageId,
  attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>,
) {
  const stored = attachments.filter(
    (attachment): attachment is ChatAttachment => !("dataUrl" in attachment),
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
    if (!("dataUrl" in attachment)) return [attachment];
    const persisted = byUpload.get(attachment);
    return persisted === undefined ? [] : [persisted];
  });
});

export const mutateProject = Effect.fn("EnvironmentCommands.mutateProject")(function* (
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
    ...(input.autoPull === undefined ? {} : { autoPull: input.autoPull }),
    ...(input.projectIcon === undefined ? {} : { projectIcon: input.projectIcon }),
    ...(input.faviconPath === undefined ? {} : { faviconPath: input.faviconPath }),
    ...(input.defaultThreadEnvMode === undefined
      ? {}
      : { defaultThreadEnvMode: input.defaultThreadEnvMode }),
    ...(input.scripts === undefined ? {} : { scripts: input.scripts }),
    ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
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

export function simpleThreadCommand(
  type:
    | "thread.archive"
    | "thread.unarchive"
    | "thread.settle"
    | "thread.pin"
    | "thread.unpin"
    | "thread.guest-share.close",
  input: ThreadCommandInput,
) {
  return allocateCommandId(input).pipe(
    Effect.flatMap((commandId) => dispatch({ type, commandId, threadId: input.threadId })),
  );
}

export const deleteThread = Effect.fn("EnvironmentCommands.deleteThread")(function* (
  input: DeleteThreadInput,
) {
  return yield* dispatch({
    type: "thread.delete",
    commandId: yield* allocateCommandId(input),
    threadId: input.threadId,
    ...(input.onlyIfUnused === undefined ? {} : { onlyIfUnused: input.onlyIfUnused }),
  });
});

export type CloseGuestShareInput = ThreadCommandInput;
export const closeGuestShare = Effect.fn("EnvironmentCommands.closeGuestShare")(function* (
  input: CloseGuestShareInput,
) {
  return yield* simpleThreadCommand("thread.guest-share.close", input);
});

export interface ResolveGuestMessageInput extends ThreadCommandInput {
  readonly guestMessageId: GuestMessageId;
  readonly decision: "send" | "dismiss";
  readonly creationSource?: "web" | "mobile";
}
/** Send runs the guest's text as a normal turn; the server supplies the text, not the client. */
export const resolveGuestMessage = Effect.fn("EnvironmentCommands.resolveGuestMessage")(function* (
  input: ResolveGuestMessageInput,
) {
  const commandId = yield* allocateCommandId(input);
  if (input.decision === "dismiss") {
    return yield* dispatch({
      type: "thread.guest-message.dismiss",
      commandId,
      threadId: input.threadId,
      guestMessageId: input.guestMessageId,
    });
  }
  return yield* dispatch({
    type: "message.dispatch",
    commandId,
    threadId: input.threadId,
    messageId: MessageId.make(commandId),
    guestMessageId: input.guestMessageId,
    text: "",
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    createdBy: "user",
    creationSource: input.creationSource ?? "web",
  });
});

export interface SetThreadAutoSettleInput extends ThreadCommandInput {
  readonly enabled: boolean;
}
export type LinkThreadPullRequestInput = Omit<
  Extract<OrchestrationV2Command, { type: "thread.pull-request.link" }>,
  "type" | "commandId"
> &
  CommandMetadata;
export type UnlinkThreadPullRequestInput = Omit<
  Extract<OrchestrationV2Command, { type: "thread.pull-request.unlink" }>,
  "type" | "commandId"
> &
  CommandMetadata;
export type WatchThreadPullRequestInput = Omit<
  Extract<OrchestrationV2Command, { type: "thread.pull-request.watch" }>,
  "type" | "commandId"
> &
  CommandMetadata;
