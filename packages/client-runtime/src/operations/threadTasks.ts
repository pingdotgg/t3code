import type {
  CommandId,
  IsoDateTime,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";

import type { InterruptThreadTurnInput, StartThreadTurnInput } from "./commands.ts";

export interface ThreadTaskCommandMetadata {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly createdAt: IsoDateTime;
}

export interface LocalProjectTaskWorkspace {
  readonly mode: "local";
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface WorktreeProjectTaskWorkspace {
  readonly mode: "worktree";
  readonly projectCwd: string;
  readonly baseBranch: string;
  readonly worktreeBranch: string;
  readonly startFromOrigin: boolean;
}

export type ProjectTaskWorkspace = LocalProjectTaskWorkspace | WorktreeProjectTaskWorkspace;

export interface StartProjectTaskSpec extends ThreadTaskCommandMetadata {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly titleSeed: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspace: ProjectTaskWorkspace;
}

export interface FollowUpThreadSpec extends ThreadTaskCommandMetadata {
  readonly thread: Pick<
    OrchestrationThreadShell,
    "id" | "title" | "modelSelection" | "runtimeMode" | "interactionMode"
  >;
  readonly text: string;
  readonly attachments: ReadonlyArray<UploadChatAttachment>;
}

export interface InterruptThreadSpec {
  readonly commandId: CommandId;
  readonly createdAt: IsoDateTime;
  readonly thread: Pick<OrchestrationThreadShell, "id" | "session">;
}

type RequiredCommandMetadata<T> = Omit<T, "commandId" | "createdAt"> & {
  readonly commandId: CommandId;
  readonly createdAt: IsoDateTime;
};

type BuiltThreadTaskSettings = {
  readonly modelSelection: ModelSelection;
  readonly titleSeed: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};

type BuiltStartProjectTaskBase = RequiredCommandMetadata<StartThreadTurnInput> &
  BuiltThreadTaskSettings & {
    readonly bootstrap: {
      readonly createThread: NonNullable<
        NonNullable<StartThreadTurnInput["bootstrap"]>["createThread"]
      >;
    };
  };

export type BuiltLocalStartProjectTaskInput = BuiltStartProjectTaskBase & {
  readonly bootstrap: BuiltStartProjectTaskBase["bootstrap"] & {
    readonly prepareWorktree?: never;
    readonly runSetupScript?: never;
  };
};

export type BuiltWorktreeStartProjectTaskInput = BuiltStartProjectTaskBase & {
  readonly bootstrap: BuiltStartProjectTaskBase["bootstrap"] & {
    readonly prepareWorktree: NonNullable<
      NonNullable<StartThreadTurnInput["bootstrap"]>["prepareWorktree"]
    >;
    readonly runSetupScript: true;
  };
};

export type BuiltStartProjectTaskInput =
  | BuiltLocalStartProjectTaskInput
  | BuiltWorktreeStartProjectTaskInput;

export type BuiltFollowUpThreadInput = RequiredCommandMetadata<StartThreadTurnInput> &
  BuiltThreadTaskSettings & {
    readonly bootstrap?: never;
  };

export type BuiltInterruptThreadInput = RequiredCommandMetadata<InterruptThreadTurnInput>;

function copyUploadAttachments(
  attachments: ReadonlyArray<UploadChatAttachment>,
): ReadonlyArray<UploadChatAttachment> {
  return attachments.map((attachment) => ({
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    dataUrl: attachment.dataUrl,
  }));
}

/** Builds the atomic create-thread-and-start-turn command used by every client. */
export function buildStartProjectTaskInput(
  spec: StartProjectTaskSpec & { readonly workspace: LocalProjectTaskWorkspace },
): BuiltLocalStartProjectTaskInput;
export function buildStartProjectTaskInput(
  spec: StartProjectTaskSpec & { readonly workspace: WorktreeProjectTaskWorkspace },
): BuiltWorktreeStartProjectTaskInput;
export function buildStartProjectTaskInput(spec: StartProjectTaskSpec): BuiltStartProjectTaskInput;
export function buildStartProjectTaskInput(spec: StartProjectTaskSpec): BuiltStartProjectTaskInput {
  const createThread = {
    projectId: spec.projectId,
    title: spec.title,
    modelSelection: spec.modelSelection,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    branch: spec.workspace.mode === "local" ? spec.workspace.branch : spec.workspace.baseBranch,
    worktreePath: spec.workspace.mode === "local" ? spec.workspace.worktreePath : null,
    createdAt: spec.createdAt,
  };

  const input = {
    commandId: spec.commandId,
    threadId: spec.threadId,
    message: {
      messageId: spec.messageId,
      role: "user",
      text: spec.text,
      attachments: copyUploadAttachments(spec.attachments),
    },
    modelSelection: spec.modelSelection,
    titleSeed: spec.titleSeed,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    createdAt: spec.createdAt,
  } satisfies Omit<BuiltStartProjectTaskBase, "bootstrap">;

  if (spec.workspace.mode === "local") {
    return { ...input, bootstrap: { createThread } };
  }
  return {
    ...input,
    bootstrap: {
      createThread,
      prepareWorktree: {
        projectCwd: spec.workspace.projectCwd,
        baseBranch: spec.workspace.baseBranch,
        branch: spec.workspace.worktreeBranch,
        ...(spec.workspace.startFromOrigin ? { startFromOrigin: true } : {}),
      },
      runSetupScript: true,
    },
  };
}

/**
 * Builds a same-thread follow-up without allowing an ambient voice/model
 * selection to switch the thread's provider, runtime, or interaction mode.
 */
export function buildFollowUpThreadInput(spec: FollowUpThreadSpec): BuiltFollowUpThreadInput {
  return {
    commandId: spec.commandId,
    threadId: spec.thread.id,
    message: {
      messageId: spec.messageId,
      role: "user",
      text: spec.text,
      attachments: copyUploadAttachments(spec.attachments),
    },
    modelSelection: spec.thread.modelSelection,
    titleSeed: spec.thread.title,
    runtimeMode: spec.thread.runtimeMode,
    interactionMode: spec.thread.interactionMode,
    createdAt: spec.createdAt,
  };
}

/** Captures the active turn when present so callers can bind confirmation UI to it. */
export function buildThreadTurnInterruptInput(
  spec: InterruptThreadSpec,
): BuiltInterruptThreadInput {
  const activeTurnId =
    spec.thread.session?.status === "running" || spec.thread.session?.status === "starting"
      ? spec.thread.session.activeTurnId
      : null;
  return {
    commandId: spec.commandId,
    threadId: spec.thread.id,
    ...(activeTurnId !== null ? { turnId: activeTurnId } : {}),
    createdAt: spec.createdAt,
  };
}
