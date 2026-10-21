import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

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
  readonly canReorder: boolean;
  readonly index: number;
  readonly isEditing?: boolean;
  readonly queuedCount: number;
  readonly text: string;
}): ThreadQueueRowControls {
  const mutationEnabled = !input.busy;
  const isEditing = input.isEditing === true;

  return {
    canDismiss: !input.busy,
    // Re-opening the row already in the composer would reload it and throw
    // away whatever has been typed since.
    canEdit: mutationEnabled && !isEditing,
    canMoveDown: mutationEnabled && input.canReorder && input.index < input.queuedCount - 1,
    canMoveUp: mutationEnabled && input.canReorder && input.index > 0,
    canSend: mutationEnabled && (input.canPromoteToSteer || input.canSendNow) && !isEditing,
    dismissAccessibilityLabel: REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    // Editing and sending keep the original text so quoted citations stay linked.
    displayText: assistantCitationsToPlainText(input.text),
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

export function resolveQueueDragBeforeRunId(
  rows: ReadonlyArray<{ id: RunId; y?: number; height?: number }>,
  runId: RunId,
  translationY: number,
): RunId | null | undefined {
  const sourceIndex = rows.findIndex((row) => row.id === runId);
  const source = rows[sourceIndex];
  if (!source || rows.some((row) => row.y === undefined || row.height === undefined)) return;
  const center = source.y! + source.height! / 2 + translationY;
  const remaining = rows.filter((row) => row.id !== runId);
  return remaining.find((row) => center < row.y! + row.height! / 2)?.id ?? null;
}

export function resolveQueueDropBeforeRunId(
  rows: ReadonlyArray<{ id: RunId; y?: number; height?: number }>,
  runId: RunId,
  translationY: number,
): RunId | null | undefined {
  const before = resolveQueueDragBeforeRunId(rows, runId, translationY);
  if (before === undefined) return;
  const sourceIndex = rows.findIndex((row) => row.id === runId);
  return before === (rows[sourceIndex + 1]?.id ?? null) ? undefined : before;
}
