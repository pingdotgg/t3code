import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

export const AUTOMATIC_COMPLETION_DELIVERY_LABEL = "Automatic completion delivery";
export const DISMISS_AUTOMATIC_COMPLETION_ACCESSIBILITY_LABEL =
  "Dismiss automatic completion delivery";
export const REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL = "Remove queued message";

export function collectAutomaticCompletionMessageIds(
  messages: ReadonlyArray<{
    readonly id: string;
    readonly delegatedCompletion?: unknown;
  }>,
): ReadonlySet<string> {
  return new Set(
    messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
}

export interface ThreadQueueRowControls {
  readonly automaticCompletion: boolean;
  readonly canDismiss: boolean;
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly canSteer: boolean;
  readonly dismissAccessibilityLabel: string;
  readonly displayText: string;
}

export function resolveThreadQueueRowControls(input: {
  readonly automaticCompletionMessageIds: ReadonlySet<string>;
  readonly busy: boolean;
  readonly canPromoteToSteer: boolean;
  readonly canReorder: boolean;
  readonly index: number;
  readonly queuedCount: number;
  readonly text: string;
  readonly userMessageId: string;
}): ThreadQueueRowControls {
  const automaticCompletion = input.automaticCompletionMessageIds.has(input.userMessageId);
  const mutationEnabled = !input.busy && !automaticCompletion;

  return {
    automaticCompletion,
    canDismiss: !input.busy,
    canMoveDown: mutationEnabled && input.canReorder && input.index < input.queuedCount - 1,
    canMoveUp: mutationEnabled && input.canReorder && input.index > 0,
    canSteer: mutationEnabled && input.canPromoteToSteer,
    dismissAccessibilityLabel: automaticCompletion
      ? DISMISS_AUTOMATIC_COMPLETION_ACCESSIBILITY_LABEL
      : REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    displayText: automaticCompletion ? AUTOMATIC_COMPLETION_DELIVERY_LABEL : input.text,
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
