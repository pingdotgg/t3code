import { parseSideChatCommand } from "@t3tools/shared/composerTrigger";

import type { DictationSendDraft } from "../../speech/useEnvironmentSpeechInput";

/**
 * Answers the shown question once the transcript lands. `/side` beats the question on send, and
 * the transcript can introduce it, so routing waits for the committed text.
 */
export function submitDictatedAnswer(input: {
  readonly answer: { readonly draft: DictationSendDraft; readonly submit: () => void };
  readonly submitAfterDictation: (
    submit: (text: string) => void,
    send: { readonly draft: DictationSendDraft; readonly cancel: () => void },
  ) => void;
  /** Side chats can start from this send; decided now, like the side chat it binds. */
  readonly sideChatUsable: boolean;
  /** Binds the send now; it opens the side chat with the text, or stops on null. */
  readonly sendSideChat: (transcript: Promise<string | null>) => void;
  readonly onSubmitted: () => void;
}) {
  let resolveSideChat: (text: string | null) => void = () => {};
  const sideChat = new Promise<string | null>((resolve) => {
    resolveSideChat = resolve;
  });
  input.submitAfterDictation(
    (text) => {
      if (input.sideChatUsable && parseSideChatCommand(text)) {
        resolveSideChat(text);
      } else {
        resolveSideChat(null);
        input.answer.submit();
      }
      input.onSubmitted();
    },
    { draft: input.answer.draft, cancel: () => resolveSideChat(null) },
  );
  if (input.sideChatUsable) input.sendSideChat(sideChat);
}
