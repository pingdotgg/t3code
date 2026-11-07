import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";

export const REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL = "Remove queued message";

export interface ThreadQueueRowControls {
  readonly canDismiss: boolean;
  readonly canEdit: boolean;
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly canSend: boolean;
  readonly dismissAccessibilityLabel: string;
  readonly displayText: string;
  readonly isEditing: boolean;
}

export function resolveThreadQueueRowControls(input: {
  readonly busy: boolean;
  readonly canPromoteToSteer: boolean;
  readonly canSendNow: boolean;
  /** Something else holds the composer, such as an open question. */
  readonly editBlocked?: boolean;
  readonly index?: number;
  readonly isEditing?: boolean;
  /** A guest's message keeps the guest's words; the owner can cancel it, not rewrite it. */
  readonly isGuestMessage?: boolean;
  readonly queueLength?: number;
  readonly text: string;
}): ThreadQueueRowControls {
  const mutationEnabled = !input.busy;
  const isEditing = input.isEditing === true;
  const index = input.index ?? 0;
  const queueLength = input.queueLength ?? 0;
  const canReorder = mutationEnabled && !isEditing && queueLength > 1;

  return {
    canDismiss: !input.busy,
    // Re-opening the row already in the composer would reload it and throw
    // away whatever has been typed since.
    canEdit:
      mutationEnabled && !isEditing && input.isGuestMessage !== true && input.editBlocked !== true,
    canMoveUp: canReorder && index > 0,
    canMoveDown: canReorder && index < queueLength - 1,
    canSend: mutationEnabled && (input.canPromoteToSteer || input.canSendNow) && !isEditing,
    dismissAccessibilityLabel: REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    // Editing and sending keep the original text so quoted citations stay linked.
    displayText: isAttachmentOnlyBootstrapPrompt(input.text)
      ? ""
      : assistantCitationsToPlainText(input.text),
    isEditing,
  };
}

export function buildCancelQueuedRunCommand(input: {
  readonly environmentId: EnvironmentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}): {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly runId: RunId;
    readonly threadId: ThreadId;
  };
} {
  return {
    environmentId: input.environmentId,
    input: {
      runId: input.runId,
      threadId: input.threadId,
    },
  };
}

export function buildReorderQueuedRunCommand(input: {
  readonly beforeRunId: RunId | null;
  readonly environmentId: EnvironmentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}): {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly beforeRunId: RunId | null;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  };
} {
  return {
    environmentId: input.environmentId,
    input: {
      beforeRunId: input.beforeRunId,
      runId: input.runId,
      threadId: input.threadId,
    },
  };
}
