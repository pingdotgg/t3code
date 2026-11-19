import { thrownErrorMessage } from "../errors/translatable.ts";
import { MessageId, type ProviderUploadFeedbackResult } from "@t3tools/contracts";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

type CodexFeedbackSubmissionDetails = {
  readonly id: MessageId;
  readonly command: string;
  readonly createdAt: string;
};

export type CodexFeedbackSubmission = CodexFeedbackSubmissionDetails &
  (
    | { readonly status: "uploading" | "interrupted" }
    | { readonly status: "sent"; readonly feedbackId: string }
    | { readonly status: "failed"; readonly errorMessage: string }
  );

export function parseCodexFeedbackCommand(text: string): { readonly reason?: string } | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) {
    return null;
  }
  const reason = match[1]?.trim();
  return reason ? { reason } : {};
}

export function codexFeedbackNotice(
  submission: CodexFeedbackSubmission,
  resolve: MFunctionType = mFallback,
) {
  switch (submission.status) {
    case "interrupted":
      return null;
    case "uploading":
      return { title: resolve(msg("Sending feedback to OpenAI...")), description: undefined };
    case "sent":
      return {
        title: resolve(msg("Feedback sent to OpenAI")),
        description: resolve(msg("Thread ID: {feedbackId}", { feedbackId: submission.feedbackId })),
      };
    case "failed":
      return {
        title: resolve(msg("Could not send feedback to OpenAI")),
        description: submission.errorMessage,
      };
  }
}

export interface LocalChatMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly turnId: null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function codexFeedbackMessage(
  submission: CodexFeedbackSubmission,
  role: "user" | "assistant" = "user",
  resolve: MFunctionType = mFallback,
): LocalChatMessage {
  const text =
    role === "user"
      ? submission.command
      : submission.status === "sent"
        ? resolve(
            msg("Feedback sent to OpenAI.\n\nThread ID: `{feedbackId}`", {
              feedbackId: submission.feedbackId,
            }),
          )
        : submission.status === "failed"
          ? resolve(
              msg("Could not send feedback to OpenAI.\n\n{errorMessage}", {
                errorMessage: submission.errorMessage,
              }),
            )
          : resolve(msg("Sending feedback to OpenAI..."));

  return {
    id: role === "user" ? submission.id : MessageId.make(`${submission.id}:feedback`),
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: submission.createdAt,
    updatedAt: submission.createdAt,
  };
}

export async function submitCodexFeedback<E>(
  input: {
    readonly submission: CodexFeedbackSubmissionDetails;
    readonly clearDraft: () => void;
    readonly onUpdate: (submission: CodexFeedbackSubmission) => void;
    readonly upload: () => Promise<AtomCommandResult<ProviderUploadFeedbackResult, E>>;
  },
  resolve: MFunctionType = mFallback,
): Promise<AtomCommandResult<ProviderUploadFeedbackResult, E>> {
  input.onUpdate({ ...input.submission, status: "uploading" });
  input.clearDraft();

  const result = await input.upload();
  if (result._tag === "Success") {
    input.onUpdate({
      ...input.submission,
      status: "sent",
      feedbackId: result.value.feedbackId,
    });
  } else if (isAtomCommandInterrupted(result)) {
    input.onUpdate({ ...input.submission, status: "interrupted" });
  } else {
    const error = squashAtomCommandFailure(result);
    input.onUpdate({
      ...input.submission,
      status: "failed",
      errorMessage:
        error instanceof Error
          ? (thrownErrorMessage(error, resolve) ?? error.message)
          : resolve(msg("An error occurred.")),
    });
  }

  return result;
}
