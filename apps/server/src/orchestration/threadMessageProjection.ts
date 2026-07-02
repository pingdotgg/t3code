import type { TurnId } from "@t3tools/contracts";

export interface ThreadMessageProjectionSlice {
  readonly text: string;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
}

export interface ThreadMessageProjectionIncoming {
  readonly text: string;
  readonly turnId: TurnId | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function assistantMessageTurnChanged(
  previousMessage: ThreadMessageProjectionSlice | undefined,
  nextTurnId: TurnId | null,
): boolean {
  if (!previousMessage) {
    return false;
  }
  return previousMessage.turnId !== nextTurnId;
}

export function mergeThreadMessageProjection(
  previousMessage: ThreadMessageProjectionSlice | undefined,
  incoming: ThreadMessageProjectionIncoming,
): ThreadMessageProjectionSlice & { readonly updatedAt: string } {
  const turnChanged = assistantMessageTurnChanged(previousMessage, incoming.turnId);

  const nextText = (() => {
    if (!previousMessage || turnChanged) {
      if (incoming.streaming || incoming.text.length > 0) {
        return incoming.text;
      }
      return turnChanged ? "" : previousMessage.text;
    }

    if (incoming.streaming) {
      return `${previousMessage.text}${incoming.text}`;
    }
    if (incoming.text.length === 0) {
      return previousMessage.text;
    }
    return incoming.text;
  })();

  return {
    text: nextText,
    turnId: incoming.turnId,
    createdAt: turnChanged ? incoming.createdAt : (previousMessage?.createdAt ?? incoming.createdAt),
    updatedAt: incoming.updatedAt,
  };
}
