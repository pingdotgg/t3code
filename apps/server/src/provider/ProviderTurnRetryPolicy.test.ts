import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { ProviderAdapterRequestError } from "./Errors.ts";
import {
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
});
