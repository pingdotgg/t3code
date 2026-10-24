import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent } from "react";
import { create } from "zustand";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";

interface ThreadSuggestion {
  readonly afterMessageId: MessageId;
  /** Empty while the request runs, after it fails, or when the model had nothing to suggest. */
  readonly text: string;
}

// Keyed by thread, so returning to a thread shows its suggestion without another model call, and
// each agent reply is asked about once.
const useSuggestionStore = create<Readonly<Record<string, ThreadSuggestion>>>()(() => ({}));

/**
 * Asks the text generation model for the user's next message once per settled agent reply.
 * Returns null until a suggestion for `afterMessageId` exists.
 */
export function useNextMessageSuggestion(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly afterMessageId: MessageId | null;
  readonly enabled: boolean;
}): string | null {
  const { environmentId, threadId, afterMessageId } = input;
  const key = threadId === null ? null : `${environmentId}:${threadId}`;
  const canSuggest = useAtomValue(
    orchestrationEnvironment.suggestNextMessage.permissionAtom(environmentId),
  );
  const suggestNextMessage = useAtomCommand(orchestrationEnvironment.suggestNextMessage, {
    reportFailure: false,
  });
  const suggestion = useSuggestionStore((state) => (key === null ? undefined : state[key]));
  const active = input.enabled && canSuggest;

  const request = useEffectEvent(
    (target: { key: string; threadId: ThreadId; afterMessageId: MessageId }) => {
      if (useSuggestionStore.getState()[target.key]?.afterMessageId === target.afterMessageId) {
        return;
      }
      const pending: ThreadSuggestion = { afterMessageId: target.afterMessageId, text: "" };
      useSuggestionStore.setState({ [target.key]: pending });
      void suggestNextMessage({
        environmentId,
        input: { threadId: target.threadId, afterMessageId: target.afterMessageId },
      }).then((result) => {
        if (result._tag !== "Success" || result.value.suggestion === "") return;
        const text = result.value.suggestion;
        useSuggestionStore.setState((state) =>
          state[target.key] === pending ? { [target.key]: { ...pending, text } } : state,
        );
      });
    },
  );

  useEffect(() => {
    if (!active || key === null || threadId === null || afterMessageId === null) return;
    request({ key, threadId, afterMessageId });
  }, [active, key, threadId, afterMessageId]);

  return active && suggestion?.afterMessageId === afterMessageId && suggestion.text !== ""
    ? suggestion.text
    : null;
}
