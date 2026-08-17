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
