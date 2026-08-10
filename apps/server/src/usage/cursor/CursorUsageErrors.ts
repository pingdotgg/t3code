/**
 * Internal errors for the Cursor usage collection pipeline.
 *
 * Distinct from the wire-facing errors in `@t3tools/contracts` `cursorUsage`
 * module: those are what RPC callers see, these are what `CursorUsageClient`
 * and `CursorUsageSyncService` produce internally before being mapped onto
 * the contract at the RPC boundary.
 *
 * @module CursorUsageErrors
 */
import * as Schema from "effect/Schema";

const context = {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
};

/** Neither a Cursor Admin API key nor a Cursor session token is configured. */
export class CursorUsageClientNotConfiguredError extends Schema.TaggedErrorClass<CursorUsageClientNotConfiguredError>()(
  "CursorUsageClientNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Cursor usage tracking requires a Cursor Admin API key or session token.";
  }
}

/** The configured Admin API key or session token was rejected. */
export class CursorUsageClientAuthError extends Schema.TaggedErrorClass<CursorUsageClientAuthError>()(
  "CursorUsageClientAuthError",
  { ...context },
) {
  override get message(): string {
    return `Cursor usage authentication expired: ${this.detail}`;
  }
}

/** The Admin API responded, but not in a shape this client understands. */
export class CursorUsageClientEndpointError extends Schema.TaggedErrorClass<CursorUsageClientEndpointError>()(
  "CursorUsageClientEndpointError",
  { ...context },
) {
  override get message(): string {
    return `Cursor usage endpoint is currently unavailable: ${this.detail}`;
  }
}

/** The Admin API is rate limiting requests. */
export class CursorUsageClientRateLimitError extends Schema.TaggedErrorClass<CursorUsageClientRateLimitError>()(
  "CursorUsageClientRateLimitError",
  {},
) {
  override get message(): string {
    return "Cursor usage temporarily rate limited.";
  }
}

/** A request-level failure: timeout, network error, non-2xx status, etc. */
export class CursorUsageClientRequestError extends Schema.TaggedErrorClass<CursorUsageClientRequestError>()(
  "CursorUsageClientRequestError",
  { ...context },
) {
  override get message(): string {
    return `Cursor usage request failed: ${this.detail}`;
  }
}

/** The result exceeded the bounded pagination budget and is incomplete. */
export class CursorUsageClientPaginationLimitError extends Schema.TaggedErrorClass<CursorUsageClientPaginationLimitError>()(
  "CursorUsageClientPaginationLimitError",
  {},
) {
  override get message(): string {
    return "Cursor usage result exceeded the pagination limit and was not fully fetched.";
  }
}

export const CursorUsageClientError = Schema.Union([
  CursorUsageClientNotConfiguredError,
  CursorUsageClientAuthError,
  CursorUsageClientEndpointError,
  CursorUsageClientRateLimitError,
  CursorUsageClientRequestError,
  CursorUsageClientPaginationLimitError,
]);
export type CursorUsageClientError = typeof CursorUsageClientError.Type;
