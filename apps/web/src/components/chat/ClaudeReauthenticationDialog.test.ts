import { ServerProviderReauthenticateAttemptId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  statusFailureMessage,
  transitionClaudeReauthenticationState,
  type ClaudeReauthenticationAttempt,
  type ClaudeReauthenticationDialogState,
  type ClaudeReauthenticationStatus,
} from "./ClaudeReauthenticationDialog";

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
    ...overrides,
  };
}

describe("ClaudeReauthenticationDialog state", () => {
  it("moves from startup to code entry when the server publishes a URL", () => {
    const next = transitionClaudeReauthenticationState({
      previous: { phase: "starting", attempt: { ...attempt, authorizationUrl: null } },
      attempt: { ...attempt, authorizationUrl: null },
      status: status(),
    });

    expect(next).toEqual({ phase: "waiting", attempt });
  });

  it("preserves the submitting state while polling an in-flight code submission", () => {
    const next = transitionClaudeReauthenticationState({
      previous: { phase: "submitting", attempt },
      attempt,
      status: status({ status: "starting", authorizationUrl: null }),
    });

    expect(next).toEqual({ phase: "submitting", attempt });
  });

  it("resolves browser-only sign-in from a succeeded status", () => {
    const next = transitionClaudeReauthenticationState({
      previous: { phase: "waiting", attempt },
      attempt,
      status: status({ status: "succeeded" }),
    });

    expect(next).toEqual({ phase: "success" });
  });

  it("stops at a terminal failure and keeps the URL available for retry context", () => {
    const next = transitionClaudeReauthenticationState({
      previous: { phase: "waiting", attempt },
      attempt,
      status: status({ status: "failed", error: "Claude rejected the sign-in." }),
    });

    expect(next).toEqual({
      phase: "failure",
      message: "Claude rejected the sign-in.",
      attempt,
    });
  });

  it("uses safe messages for cancellation and expiration", () => {
    const cancelled = statusFailureMessage(status({ status: "cancelled", error: null }));
    const expired = statusFailureMessage(status({ status: "expired", error: null }));

    expect(cancelled).toBe("The Claude sign-in attempt was cancelled.");
    expect(expired).toBe("The Claude sign-in attempt expired. Try again.");
  });

  it("does not expose an attempt when a terminal status never had a URL", () => {
    const noUrlAttempt = { ...attempt, authorizationUrl: null };
    const previous: ClaudeReauthenticationDialogState = {
      phase: "starting",
      attempt: noUrlAttempt,
    };
    const next = transitionClaudeReauthenticationState({
      previous,
      attempt: noUrlAttempt,
      status: status({ status: "expired", authorizationUrl: null, error: null }),
    });

    expect(next).toEqual({
      phase: "failure",
      message: "The Claude sign-in attempt expired. Try again.",
    });
  });
});
