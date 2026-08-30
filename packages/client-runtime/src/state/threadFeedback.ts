import {
  MessageId,
  type OrchestrationMessage,
  type ProviderUploadFeedbackResult,
} from "@t3tools/contracts";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "./runtime.ts";

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

export function codexFeedbackMessage(
  submission: CodexFeedbackSubmission,
  role: "user" | "assistant" = "user",
): OrchestrationMessage {
  const text =
    role === "user"
      ? submission.command
      : submission.status === "sent"
        ? `Feedback sent to OpenAI.\n\nThread ID: \`${submission.feedbackId}\``
        : submission.status === "failed"
          ? `Could not send feedback to OpenAI.\n\n${submission.errorMessage}`
          : "Sending feedback to OpenAI...";

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

export async function submitCodexFeedback<E>(input: {
  readonly submission: CodexFeedbackSubmissionDetails;
  readonly clearDraft: () => void;
  readonly onUpdate: (submission: CodexFeedbackSubmission) => void;
  readonly upload: () => Promise<AtomCommandResult<ProviderUploadFeedbackResult, E>>;
}): Promise<AtomCommandResult<ProviderUploadFeedbackResult, E>> {
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
      errorMessage: error instanceof Error ? error.message : "An error occurred.",
    });
  }

  return result;
}
