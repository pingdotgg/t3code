import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

export const REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL = "Remove queued message";

export interface ThreadQueueRowControls {
  readonly canDismiss: boolean;
  readonly canEdit: boolean;
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly canSteer: boolean;
  readonly dismissAccessibilityLabel: string;
  readonly displayText: string;
  readonly isEditing: boolean;
}

export function resolveThreadQueueRowControls(input: {
  readonly busy: boolean;
  readonly canPromoteToSteer: boolean;
  readonly canReorder: boolean;
  readonly index: number;
  /** This row's message is already open in the composer. */
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
    canSteer: mutationEnabled && input.canPromoteToSteer && !isEditing,
    dismissAccessibilityLabel: REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    displayText: input.text,
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

/** Find the insertion anchor using the rows' original, untransformed layout. */
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

/** Return the insertion anchor after a drag, or undefined when the order is unchanged. */
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
