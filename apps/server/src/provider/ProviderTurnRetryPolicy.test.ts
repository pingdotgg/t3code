import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterValidationError,
} from "./Errors.ts";
import {
  isProviderFailureEvent,
  isProviderTurnTerminalEvent,
  retryableProviderRuntimeFailure,
  retryableProviderServiceFailure,
} from "./ProviderTurnRetryPolicy.ts";

const eventBase = {
  eventId: EventId.make("retry-policy-event"),
  provider: ProviderDriverKind.make("codex"),
  threadId: ThreadId.make("retry-policy-thread"),
  turnId: TurnId.make("retry-policy-turn"),
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

describe("ProviderTurnRetryPolicy", () => {
  it.each([
    "OpenAI is currently over capacity",
    "HTTP 429: Too many requests",
    "503 Service Unavailable",
    "API Error: overloaded_error",
    "Claude runtime stream failed.",
    "WebSocket connection reset by peer",
  ])("retries transient runtime failures: %s", (message) => {
    const event: ProviderRuntimeEvent = {
      ...eventBase,
      type: "turn.completed",
      payload: { state: "failed", errorMessage: message },
    };

    expect(retryableProviderRuntimeFailure(event)?.message).toBe(message);
  });

  it.each([
    "401 Unauthorized: invalid API key",
    "Billing quota exceeded",
    "Invalid request: context window exceeded",
    "Model not found",
    "Request cancelled by user",
  ])("does not retry permanent runtime failures: %s", (message) => {
    const event: ProviderRuntimeEvent = {
      ...eventBase,
      type: "turn.completed",
      payload: { state: "failed", errorMessage: message },
    };

    expect(retryableProviderRuntimeFailure(event)).toBeUndefined();
  });

  it("retries transport errors without provider-specific message matching", () => {
    const event: ProviderRuntimeEvent = {
      ...eventBase,
      type: "runtime.error",
      payload: {
        class: "transport_error",
        message: "The provider connection disappeared.",
      },
    };

    expect(retryableProviderRuntimeFailure(event)?.message).toBe(
      "The provider connection disappeared.",
    );
  });

  it("retries recoverable session exits unless the user stopped the turn", () => {
    const exited = (reason: string): ProviderRuntimeEvent => ({
      ...eventBase,
      type: "session.exited",
      payload: {
        recoverable: true,
        exitKind: "error",
        reason,
      },
    });

    expect(retryableProviderRuntimeFailure(exited("Provider process disappeared"))).toBeDefined();
    expect(retryableProviderRuntimeFailure(exited("Interrupted by user"))).toBeUndefined();
  });

  it("uses the nested adapter cause when the facade error is generic", () => {
    const error = new ProviderAdapterRequestError({
      provider: "claudeAgent",
      method: "turn/start",
      detail: "turn/start failed",
      cause: new Error("API Error: 529 overloaded_error"),
    });

    expect(retryableProviderServiceFailure(error)?.message).toContain("529 overloaded_error");
  });

  it("does not retry permanent adapter failures", () => {
    const requestError = new ProviderAdapterRequestError({
      provider: "codex",
      method: "turn/start",
      detail: "401 Unauthorized: invalid API key",
    });
    const validationError = new ProviderAdapterValidationError({
      provider: "codex",
      operation: "sendTurn",
      issue: "Invalid request",
    });
    const permanentlyClosedSession = new ProviderAdapterSessionClosedError({
      provider: "codex",
      threadId: "retry-policy-thread",
      cause: new Error("401 Unauthorized: invalid API key"),
    });
    const transientlyClosedSession = new ProviderAdapterSessionClosedError({
      provider: "codex",
      threadId: "retry-policy-thread",
    });

    expect(retryableProviderServiceFailure(requestError)).toBeUndefined();
    expect(retryableProviderServiceFailure(validationError)).toBeUndefined();
    expect(retryableProviderServiceFailure(permanentlyClosedSession)).toBeUndefined();
    expect(retryableProviderServiceFailure(transientlyClosedSession)).toBeDefined();
  });

  it("classifies provider failures independently from terminal turn events", () => {
    const permanentFailure: ProviderRuntimeEvent = {
      ...eventBase,
      type: "turn.completed",
      payload: {
        state: "failed",
        errorMessage: "401 Unauthorized: invalid API key",
      },
    };
    const successfulCompletion: ProviderRuntimeEvent = {
      ...eventBase,
      type: "turn.completed",
      payload: { state: "completed" },
    };
    const sessionError: ProviderRuntimeEvent = {
      ...eventBase,
      type: "session.state.changed",
      payload: {
        state: "error",
        reason: "503 Service Unavailable",
      },
    };
    const abortedTurn: ProviderRuntimeEvent = {
      ...eventBase,
      type: "turn.aborted",
      payload: { reason: "Interrupted by user" },
    };

    expect(isProviderFailureEvent(permanentFailure)).toBe(true);
    expect(isProviderTurnTerminalEvent(permanentFailure)).toBe(true);
    expect(isProviderFailureEvent(successfulCompletion)).toBe(false);
    expect(isProviderTurnTerminalEvent(successfulCompletion)).toBe(true);
    expect(isProviderFailureEvent(sessionError)).toBe(true);
    expect(isProviderTurnTerminalEvent(sessionError)).toBe(false);
    expect(isProviderFailureEvent(abortedTurn)).toBe(true);
    expect(isProviderTurnTerminalEvent(abortedTurn)).toBe(true);
  });
});
