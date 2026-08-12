import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

import type { ProviderServiceError } from "./Errors.ts";

export const PROVIDER_TURN_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;

export const PROVIDER_TURN_RETRY_PROMPT =
  "Continue the task from where you left off. Do not repeat work that is already complete.";

export interface RetryableProviderFailure {
  readonly message: string;
}

const NON_RETRYABLE_FAILURE_PATTERNS = [
  /\b(?:400|401|402|403|404|405|409|410|413|415|422)\b/,
  /\b(?:auth(?:entication|orization)?|unauthori[sz]ed|forbidden|sign[ -]?in|log[ -]?in)\b/,
  /\b(?:invalid|expired|missing|revoked)\b.{0,40}\b(?:api[ -]?key|credential|token)\b/,
  /\b(?:billing|payment|insufficient (?:balance|credit)|credit balance|usage limit|quota exceeded)\b/,
  /\b(?:bad request|invalid request|invalid parameter|validation failed|malformed request)\b/,
  /\b(?:context window|context length|prompt too long|request too large|payload too large)\b/,
  /\b(?:content policy|safety policy|permission denied|not permitted|unsupported|model not found)\b/,
  /\b(?:cancelled|canceled|interrupted|aborted) by (?:the )?user\b/,
] as const;

const RETRYABLE_FAILURE_PATTERNS = [
  /\b(?:408|425|429|500|502|503|504|520|522|523|524|529)\b/,
  /\b(?:capacity|overloaded?|overload|high demand|too many requests|rate[ _-]?limit)\b/,
  /\b(?:resource exhausted|temporar(?:y|ily) unavailable|service unavailable)\b/,
  /\b(?:try again|retry(?:ing)?|backoff)\b/,
  /\b(?:timed? out|timeout|deadline exceeded)\b/,
  /\b(?:network error|fetch failed|socket hang up|websocket)\b/,
  /\b(?:connection|stream) (?:closed|failed|lost|reset|refused)\b/,
  /\b(?:econnreset|econnrefused|ehostunreach|enetunreach|enotfound)\b/,
  /\b(?:upstream|bad gateway|gateway timeout|internal server error|server error)\b/,
  /\b(?:runtime stream failed|api error|overloaded_error|unable to respond)\b/,
] as const;

function messageFromUnknown(value: unknown): string | undefined {
  if (value instanceof Error) {
    return value.message;
  }
  if (Predicate.isObject(value) && "message" in value && typeof value.message === "string") {
    return value.message;
  }
  return undefined;
}

function normalizeFailureMessage(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => part !== undefined && part.length > 0)
    .filter((part, index, all) => all.indexOf(part) === index)
    .join(": ");
}

function isRetryableFailureMessage(message: string, transportFailure = false): boolean {
  const normalized = message.toLowerCase();
  if (NON_RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return transportFailure || RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function retryableProviderServiceFailure(
  error: ProviderServiceError,
): RetryableProviderFailure | undefined {
  switch (error._tag) {
    case "ProviderAdapterSessionClosedError": {
      const message = normalizeFailureMessage([messageFromUnknown(error.cause), error.message]);
      return isRetryableFailureMessage(message, true) ? { message } : undefined;
    }
    case "ProviderAdapterProcessError": {
      const message = normalizeFailureMessage([
        error.detail,
        messageFromUnknown(error.cause),
        error.message,
      ]);
      return isRetryableFailureMessage(message, true) ? { message } : undefined;
    }
    case "ProviderAdapterRequestError": {
      const message = normalizeFailureMessage([
        error.detail,
        messageFromUnknown(error.cause),
        error.message,
      ]);
      return isRetryableFailureMessage(message) ? { message } : undefined;
    }
    default:
      return undefined;
  }
}

export function retryableProviderRuntimeFailure(
  event: ProviderRuntimeEvent,
): RetryableProviderFailure | undefined {
  switch (event.type) {
    case "runtime.error": {
      if (
        event.payload.class === "permission_error" ||
        event.payload.class === "validation_error"
      ) {
        return undefined;
      }
      const transportFailure = event.payload.class === "transport_error";
      return isRetryableFailureMessage(event.payload.message, transportFailure)
        ? { message: event.payload.message }
        : undefined;
    }
    case "turn.completed": {
      if (event.payload?.state !== "failed" || event.payload.errorMessage === undefined) {
        return undefined;
      }
      return isRetryableFailureMessage(event.payload.errorMessage)
        ? { message: event.payload.errorMessage }
        : undefined;
    }
    case "turn.aborted": {
      return event.payload?.reason !== undefined && isRetryableFailureMessage(event.payload.reason)
        ? { message: event.payload.reason }
        : undefined;
    }
    case "session.state.changed": {
      if (event.payload?.state !== "error" || event.payload.reason === undefined) {
        return undefined;
      }
      return isRetryableFailureMessage(event.payload.reason)
        ? { message: event.payload.reason }
        : undefined;
    }
    case "session.exited": {
      const message = event.payload?.reason ?? "Provider session exited unexpectedly.";
      if (event.payload?.recoverable === true) {
        return isRetryableFailureMessage(message, true) ? { message } : undefined;
      }
      return event.payload?.exitKind === "error" && isRetryableFailureMessage(message)
        ? { message }
        : undefined;
    }
    default:
      return undefined;
  }
}

export function isProviderFailureEvent(event: ProviderRuntimeEvent): boolean {
  switch (event.type) {
    case "runtime.error":
    case "turn.aborted":
      return true;
    case "turn.completed":
      return event.payload?.state === "failed";
    case "session.state.changed":
      return event.payload?.state === "error";
    case "session.exited":
      return event.payload?.exitKind === "error" || event.payload?.recoverable === true;
    default:
      return false;
  }
}

export function isProviderTurnTerminalEvent(event: ProviderRuntimeEvent): boolean {
  return (
    event.type === "turn.completed" ||
    event.type === "turn.aborted" ||
    event.type === "session.exited"
  );
}
