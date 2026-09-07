import type { ServerProviderReauthenticateStatusResult } from "@t3tools/contracts";

export type ClaudeReauthenticationAttempt = Pick<
  ServerProviderReauthenticateStatusResult,
  "attemptId" | "authorizationUrl"
>;

/** Status fields stay complete so a successful login cannot hide a failed retry. */
export type ClaudeReauthenticationStatus = Pick<
  ServerProviderReauthenticateStatusResult,
  "status" | "authorizationUrl" | "error" | "continuation" | "continuationError"
>;

export type ClaudeReauthenticationSheetState =
  | { readonly phase: "starting"; readonly attempt?: ClaudeReauthenticationAttempt }
  | {
      readonly phase: "waiting" | "submitting";
      readonly attempt: ClaudeReauthenticationAttempt;
    }
  | {
      readonly phase: "success";
      readonly continuation: ServerProviderReauthenticateStatusResult["continuation"];
      readonly continuationError: string | null;
    }
  | {
      readonly phase: "error";
      readonly message: string;
      readonly attempt?: ClaudeReauthenticationAttempt;
    };

export function statusFailureMessage(status: ClaudeReauthenticationStatus): string {
  if (status.status === "expired") {
    return "The Claude sign-in attempt expired. Try again.";
  }
  if (status.status === "cancelled") {
    return "The Claude sign-in attempt was cancelled.";
  }
  return status.error ?? "Claude sign-in did not complete.";
}

/** The authentication result and the failed task's continuation are separate outcomes. */
export function taskContinuationMessage(
  continuation: ServerProviderReauthenticateStatusResult["continuation"],
  continuationError: string | null,
): string {
  switch (continuation) {
    case "resumed":
      return "Task resumed.";
    case "skipped":
      return "Task was not resumed. Send your message again.";
    case "failed":
      return continuationError === null
        ? "Task could not be resumed. Send your message again."
        : `Task could not be resumed: ${continuationError}`;
    case null:
      return "T3 could not confirm whether the task resumed. Send your message again if needed.";
  }
}

/** Maps one server status receipt into the sheet state without side effects. */
export function transitionClaudeReauthenticationState(input: {
  readonly previous: ClaudeReauthenticationSheetState;
  readonly attempt: ClaudeReauthenticationAttempt;
  readonly status: ClaudeReauthenticationStatus;
}): ClaudeReauthenticationSheetState {
  const nextAttempt = {
    ...input.attempt,
    authorizationUrl: input.status.authorizationUrl ?? input.attempt.authorizationUrl,
  };

  switch (input.status.status) {
    case "succeeded":
      return {
        phase: "success",
        continuation: input.status.continuation,
        continuationError: input.status.continuationError,
      };
    case "failed":
    case "cancelled":
    case "expired":
      return {
        phase: "error",
        message: statusFailureMessage(input.status),
        ...(nextAttempt.authorizationUrl === null ? {} : { attempt: nextAttempt }),
      };
    case "starting":
      return input.previous.phase === "submitting"
        ? { phase: "submitting", attempt: nextAttempt }
        : { phase: "starting", attempt: nextAttempt };
    case "awaiting_code":
      if (nextAttempt.authorizationUrl === null) {
        return input.previous.phase === "submitting"
          ? { phase: "submitting", attempt: nextAttempt }
          : { phase: "starting", attempt: nextAttempt };
      }
      return input.previous.phase === "submitting"
        ? { phase: "submitting", attempt: nextAttempt }
        : { phase: "waiting", attempt: nextAttempt };
  }
}
