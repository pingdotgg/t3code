import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage } from "../../types";

type SuggestionMessage = Pick<ChatMessage, "id" | "role" | "streaming">;

export interface ObservedTurn {
  readonly threadId: ThreadId | null;
  readonly turnRunning: boolean;
  /** The agent reply that settled when the last watched turn ended. */
  readonly settledReplyId: MessageId | null;
}

/**
 * Tracks which agent reply settled at the end of a turn watched in the open thread. Only
 * that reply earns a suggestion: a reply exposed by a rollback or edit, or one that
 * finished while another thread was open, never does. Any thread switch forgets the turn.
 * Returns `observed` itself when nothing changed.
 */
export function observeTurn(
  observed: ObservedTurn | null,
  threadId: ThreadId | null,
  idle: boolean,
  lastMessage: SuggestionMessage | undefined,
): ObservedTurn {
  if (observed === null || observed.threadId !== threadId) {
    return { threadId, turnRunning: !idle, settledReplyId: null };
  }
  if (!idle) {
    return observed.turnRunning ? observed : { threadId, turnRunning: true, settledReplyId: null };
  }
  if (!observed.turnRunning || (lastMessage?.role === "assistant" && lastMessage.streaming)) {
    return observed;
  }
  return {
    threadId,
    turnRunning: false,
    settledReplyId: lastMessage?.role === "assistant" ? lastMessage.id : null,
  };
}

/**
 * The prompt the user is most likely to send next, once the agent has settled on a reply.
 * Requested once per agent reply; anything after it (a new message, streaming) hides it.
 * Only replies that finish while the thread is open qualify, so browsing old threads never
 * runs a model. `dismiss` hides the current suggestion until the agent replies again.
 */
export function useNextPromptSuggestion(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly enabled: boolean;
  readonly idle: boolean;
  readonly messages: ReadonlyArray<SuggestionMessage>;
}): { readonly suggestion: string | null; readonly dismiss: () => void } {
  const suggest = useAtomCommand(orchestrationEnvironment.suggestNextPrompt, {
    reportFailure: false,
  });
  const canSuggest = useAtomValue(
    orchestrationEnvironment.suggestNextPrompt.permissionAtom(input.environmentId),
  );
  const [result, setResult] = useState<{
    readonly messageId: MessageId;
    readonly suggestion: string | null;
  } | null>(null);

  const lastMessage = input.messages.at(-1);
  const [observed, setObserved] = useState(() =>
    observeTurn(null, input.threadId, input.idle, lastMessage),
  );
  const nextObserved = observeTurn(observed, input.threadId, input.idle, lastMessage);
  if (nextObserved !== observed) {
    setObserved(nextObserved);
  }

  const afterMessageId =
    input.enabled &&
    canSuggest &&
    input.threadId !== null &&
    nextObserved.settledReplyId !== null &&
    nextObserved.settledReplyId === lastMessage?.id
      ? nextObserved.settledReplyId
      : null;

  const request = useEffectEvent(
    (target: { readonly threadId: ThreadId; readonly afterMessageId: MessageId }) =>
      suggest({ environmentId: input.environmentId, input: target }),
  );

  useEffect(() => {
    const threadId = input.threadId;
    if (afterMessageId === null || threadId === null) return;
    let cancelled = false;
    void request({ threadId, afterMessageId }).then((response) => {
      if (cancelled) return;
      setResult({
        messageId: afterMessageId,
        suggestion: response._tag === "Success" ? response.value.suggestion : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [afterMessageId, input.threadId]);

  return {
    suggestion:
      afterMessageId !== null && result?.messageId === afterMessageId ? result.suggestion : null,
    dismiss: () =>
      setResult((current) => (current === null ? null : { ...current, suggestion: null })),
  };
}
