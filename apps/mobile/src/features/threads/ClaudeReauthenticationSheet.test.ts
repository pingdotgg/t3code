import { ServerProviderReauthenticateAttemptId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  statusFailureMessage,
  taskContinuationMessage,
  transitionClaudeReauthenticationState,
  type ClaudeReauthenticationAttempt,
  type ClaudeReauthenticationSheetState,
  type ClaudeReauthenticationStatus,
} from "./ClaudeReauthenticationState";

const attempt: ClaudeReauthenticationAttempt = {
  attemptId: ServerProviderReauthenticateAttemptId.make("attempt-1"),
  authorizationUrl: "https://claude.ai/oauth/authorize?state=test",
};

function status(
  overrides: Partial<ClaudeReauthenticationStatus> = {},
): ClaudeReauthenticationStatus {
  return {
    status: "awaiting_code",
    authorizationUrl: attempt.authorizationUrl,
    error: null,
    continuation: null,
    continuationError: null,
    ...overrides,
  };
}

describe("ClaudeReauthenticationSheet state", () => {
  it("moves from startup to code entry when the server publishes a URL", () => {
    const next = transitionClaudeReauthenticationState({
      previous: { phase: "starting", attempt: { ...attempt, authorizationUrl: null } },
      attempt: { ...attempt, authorizationUrl: null },
      status: status(),
    });

    expect(next).toEqual({ phase: "waiting", attempt });
  });

  it("keeps the submitting state while a code submission is in flight", () => {
    const next = transitionClaudeReauthenticationState({
      previous: { phase: "submitting", attempt },
      attempt,
      status: status({ status: "starting", authorizationUrl: null }),
    });

    expect(next).toEqual({ phase: "submitting", attempt });
  });

  it("reports authentication and task continuation separately", () => {
    const next = transitionClaudeReauthenticationState({
      previous: { phase: "waiting", attempt },
      attempt,
      status: status({ status: "succeeded", continuation: "resumed" }),
    });

    expect(next).toEqual({
      phase: "success",
      continuation: "resumed",
      continuationError: null,
    });
    expect(taskContinuationMessage("resumed", null)).toBe("Task resumed.");
    expect(taskContinuationMessage("skipped", null)).toContain("Send your message again.");
    expect(taskContinuationMessage("failed", "The retry was rejected.")).toBe(
      "Task could not be resumed: The retry was rejected.",
    );
  });

  it("stops at a terminal failure and keeps the URL available for retry context", () => {
    const next = transitionClaudeReauthenticationState({
      previous: { phase: "waiting", attempt },
      attempt,
      status: status({ status: "failed", error: "Claude rejected the sign-in." }),
    });

    expect(next).toEqual({
      phase: "error",
      message: "Claude rejected the sign-in.",
      attempt,
    });
  });

  it("uses safe messages for cancellation and expiration", () => {
    expect(statusFailureMessage(status({ status: "cancelled", error: null }))).toBe(
      "The Claude sign-in attempt was cancelled.",
    );
    expect(statusFailureMessage(status({ status: "expired", error: null }))).toBe(
      "The Claude sign-in attempt expired. Try again.",
    );
  });

  it("does not expose an attempt when a terminal status never had a URL", () => {
    const noUrlAttempt = { ...attempt, authorizationUrl: null };
    const previous: ClaudeReauthenticationSheetState = {
      phase: "starting",
      attempt: noUrlAttempt,
    };
    const next = transitionClaudeReauthenticationState({
      previous,
      attempt: noUrlAttempt,
      status: status({ status: "expired", authorizationUrl: null, error: null }),
    });

    expect(next).toEqual({
      phase: "error",
      message: "The Claude sign-in attempt expired. Try again.",
    });
  });
});
