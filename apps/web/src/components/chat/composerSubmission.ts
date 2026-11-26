import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import { msg } from "gt-react";

import { getActiveLocale, m, type MessageResolver } from "../../i18n/messages";

type ComposerSubmitEvent = { preventDefault: () => void };

type ComposerSubmissionInput = {
  prompt: string;
  providerInput?: string;
  submissionTarget: "provider-turn" | "pending-user-input";
};

export function getComposerPromptLengthValidationMessage(
  prompt: string,
  resolve: MessageResolver = m,
  locale: string = getActiveLocale(),
): string | null {
  const normalizedPrompt = prompt.trim();
  const inputLength = Math.max(
    normalizedPrompt.length,
    expandAssistantCitationsForProvider(normalizedPrompt).length,
  );
  const excessCharacters = inputLength - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  return resolve(
    msg(
      "{count, plural, one {Prompt is {excess} character over the {limit}-character limit. Shorten or split it before sending.} other {Prompt is {excess} characters over the {limit}-character limit. Shorten or split it before sending.}}",
      {
        count: excessCharacters,
        excess: excessCharacters.toLocaleString(locale),
        limit: PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString(locale),
      },
    ),
  );
}

export function getComposerSubmissionValidationMessage(
  options: ComposerSubmissionInput,
  resolve: MessageResolver = m,
): string | null {
  return options.submissionTarget === "provider-turn"
    ? getComposerPromptLengthValidationMessage(options.providerInput ?? options.prompt, resolve)
    : null;
}

// Answering a question responds to the open request instead of starting a provider turn, so
// provider and turn-send state must not block it. Its own attachments and connection still do.
export function isComposerSubmissionBlocked(input: {
  submissionTarget: ComposerSubmissionInput["submissionTarget"];
  noProviderAvailable: boolean;
  sendDisabledReason: string | null;
  attachmentBlockReason: string | null;
  environmentUnavailable: boolean;
}): boolean {
  return input.submissionTarget === "pending-user-input"
    ? input.attachmentBlockReason !== null || input.environmentUnavailable
    : input.noProviderAvailable || input.sendDisabledReason !== null;
}

export function submitComposerDraft(
  options: ComposerSubmissionInput & {
    event: ComposerSubmitEvent | undefined;
    onSend: (event?: ComposerSubmitEvent) => boolean | void;
  },
): { validationMessage: string | null; didDispatch: boolean } {
  const validationMessage = getComposerSubmissionValidationMessage(options);
  if (validationMessage) {
    options.event?.preventDefault();
    return { validationMessage, didDispatch: false };
  }

  if (options.onSend(options.event) === false) {
    options.event?.preventDefault();
    return { validationMessage: null, didDispatch: false };
  }
  return { validationMessage: null, didDispatch: true };
}
