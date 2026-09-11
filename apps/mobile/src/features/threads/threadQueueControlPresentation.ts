import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

export const REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL = "Remove queued message";

export interface ThreadQueueRowControls {
  readonly canDismiss: boolean;
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly canSteer: boolean;
  readonly dismissAccessibilityLabel: string;
  readonly displayText: string;
}

export function resolveThreadQueueRowControls(input: {
  readonly busy: boolean;
  readonly canPromoteToSteer: boolean;
  readonly canReorder: boolean;
  readonly index: number;
  readonly queuedCount: number;
  readonly text: string;
}): ThreadQueueRowControls {
  const mutationEnabled = !input.busy;

  return {
    canDismiss: !input.busy,
    canMoveDown: mutationEnabled && input.canReorder && input.index < input.queuedCount - 1,
    canMoveUp: mutationEnabled && input.canReorder && input.index > 0,
    canSteer: mutationEnabled && input.canPromoteToSteer,
    dismissAccessibilityLabel: REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    displayText: input.text,
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

/** Return the insertion anchor after a drag, or undefined when the order is unchanged. */
export function resolveQueueDropBeforeRunId(
  rows: ReadonlyArray<{ id: RunId; y?: number; height?: number }>,
  runId: RunId,
  translationY: number,
): RunId | null | undefined {
  const sourceIndex = rows.findIndex((row) => row.id === runId);
  const source = rows[sourceIndex];
  if (!source || rows.some((row) => row.y === undefined || row.height === undefined)) return;
  const center = source.y! + source.height! / 2 + translationY;
  const remaining = rows.filter((row) => row.id !== runId);
  const before = remaining.find((row) => center < row.y! + row.height! / 2)?.id ?? null;
  return before === (rows[sourceIndex + 1]?.id ?? null) ? undefined : before;
}
