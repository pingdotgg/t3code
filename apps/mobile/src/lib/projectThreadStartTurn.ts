import {
  CommandId,
  MessageId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

import {
  appendComposerImageAnnotationPrompts,
  toUploadChatImageAttachments,
  type DraftComposerImageAttachment,
} from "./composerImages";

function compactThreadTitle(value: string): string {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

export function deriveThreadTitleFromPrompt(
  value: string,
  attachments: ReadonlyArray<DraftComposerImageAttachment> = [],
): string {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    return compactThreadTitle(trimmed);
  }

  for (const attachment of attachments) {
    for (const callout of attachment.markup?.annotation.callouts ?? []) {
      if (callout.comment.trim().length > 0) {
        return compactThreadTitle(callout.comment);
      }
    }
    const legacyComment = attachment.markup?.annotation.comment.trim() ?? "";
    if (legacyComment.length > 0) {
      return compactThreadTitle(legacyComment);
    }
  }

  const firstAttachment = attachments[0];
  if (firstAttachment) {
    return compactThreadTitle(
      `Review ${firstAttachment.markup?.original.name || firstAttachment.name || "attached image"}`,
    );
  }
  return "New thread";
}

export interface ProjectThreadStartTurnSpec {
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly threadId: string;
  readonly commandId: string;
  readonly messageId: string;
  readonly createdAt: string;
  readonly text: string;
  readonly attachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceMode: "local" | "worktree";
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly startFromOrigin: boolean;
  /** Generated temp branch for worktree mode; unused for local mode. */
  readonly worktreeBranchName: string;
}

/**
 * Single source of the `thread.turn.start` bootstrap payload used to create a
 * thread from a project draft — shared by the immediate send path and the
 * offline outbox drain so both deliver identical commands.
 */
export function buildProjectThreadStartTurnInput(spec: ProjectThreadStartTurnSpec) {
  const title = deriveThreadTitleFromPrompt(spec.text, spec.attachments);
  const deliveryText = appendComposerImageAnnotationPrompts(spec.text, spec.attachments);
  const isWorktree = spec.workspaceMode === "worktree";
  return {
    commandId: CommandId.make(spec.commandId),
    threadId: ThreadId.make(spec.threadId),
    message: {
      messageId: MessageId.make(spec.messageId),
      role: "user" as const,
      text: deliveryText,
      attachments: toUploadChatImageAttachments(spec.attachments),
    },
    modelSelection: spec.modelSelection,
    titleSeed: title,
    runtimeMode: spec.runtimeMode,
    interactionMode: spec.interactionMode,
    bootstrap: {
      createThread: {
        projectId: spec.projectId,
        title,
        modelSelection: spec.modelSelection,
        runtimeMode: spec.runtimeMode,
        interactionMode: spec.interactionMode,
        branch: spec.branch,
        worktreePath: isWorktree ? null : spec.worktreePath,
        createdAt: spec.createdAt,
      },
      ...(isWorktree
        ? {
            prepareWorktree: {
              projectCwd: spec.projectCwd,
              baseBranch: spec.branch!,
              branch: spec.worktreeBranchName,
              ...(spec.startFromOrigin ? { startFromOrigin: true } : {}),
            },
            runSetupScript: true,
          }
        : {}),
    },
    createdAt: spec.createdAt,
  };
}
