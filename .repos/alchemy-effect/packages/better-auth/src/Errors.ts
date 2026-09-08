import type { APIError } from "better-auth";
import * as Data from "effect/Data";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * better-call stows the response headers accumulated by the endpoint
 * (including `set-cookie` written before the failure) on the thrown
 * `APIError` under this well-known symbol. It is registered with
 * `Symbol.for`, so we can reference it without depending on `better-call`.
 */
const kAPIErrorHeaders = Symbol.for("better-call:api-error-headers");

/**
 * Structural `APIError` detection. Deliberately not `instanceof` — the
 * error may originate from a different module instance (bundled better-auth
 * vs peer) or realm.
 */
export const isAPIErrorLike = (error: unknown): error is APIError =>
  typeof error === "object" &&
  error !== null &&
  error instanceof Error &&
  error.name === "APIError" &&
  typeof (error as APIError).statusCode === "number";

/**
 * Merge an `APIError`'s visible `headers` with the hidden response headers
 * better-call carries on {@link kAPIErrorHeaders}. `set-cookie` values are
 * appended (never collapsed) so session cookies written before the failure
 * survive.
 */
export const mergeAPIErrorHeaders = (error: APIError): Headers => {
  const merged = new Headers(error.headers as HeadersInit | undefined);
  const hidden = (error as unknown as Record<symbol, unknown>)[
    kAPIErrorHeaders
  ];
  if (hidden instanceof Headers) {
    const cookies =
      typeof hidden.getSetCookie === "function" ? hidden.getSetCookie() : [];
    hidden.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") {
        merged.set(key, value);
      }
    });
    for (const cookie of cookies) {
      merged.append("set-cookie", cookie);
    }
  }
  return merged;
};

/**
 * Typed failure of an effectified `auth.api.*` call.
 *
 * Better Auth throws `APIError` from `better-call`; this error carries the
 * same information as first-class fields:
 *
 * - `status` — the better-call status KEY, e.g. `"UNAUTHORIZED"` (a string)
 * - `statusCode` — the numeric HTTP status, e.g. `401`
 * - `body` — the JSON error body (`message`, `code`, ...)
 * - `headers` — merged response headers, INCLUDING the `set-cookie`
 *   headers better-call hides on a symbol property of the thrown error
 *
 * Match on `statusCode` (or `body.code`) — `status` is a string key, not a
 * number.
 */
export class BetterAuthApiError extends Data.TaggedError("BetterAuthApiError")<{
  readonly status: string;
  readonly statusCode: number;
  readonly body:
    | ({ message?: string; code?: string } & Record<string, unknown>)
    | undefined;
  readonly headers: Headers;
  readonly cause: APIError;
}> {
  static fromAPIError(error: APIError): BetterAuthApiError {
    return new BetterAuthApiError({
      status: String(error.status),
      statusCode: error.statusCode,
      body: error.body as BetterAuthApiError["body"],
      headers: mergeAPIErrorHeaders(error),
      cause: error,
    });
  }

  override get message(): string {
    return this.body?.message ?? `Better Auth API error (${this.statusCode})`;
  }

  /**
   * Render the error as an HTTP response (status + JSON body + merged
   * headers) — for handlers that want to pass the failure through to the
   * client exactly as Better Auth would have.
   */
  toResponse(): HttpServerResponse.HttpServerResponse {
    return HttpServerResponse.fromWeb(
      new Response(JSON.stringify(this.body ?? {}), {
        status: this.statusCode,
        headers: withJsonContentType(this.headers),
      }),
    );
  }
}

const withJsonContentType = (headers: Headers): Headers => {
  const out = new Headers(headers);
  if (!out.has("content-type")) {
    out.set("content-type", "application/json");
  }
  return out;
};

/** Failure of the deploy-time schema migration. */
export class BetterAuthMigrationError extends Data.TaggedError(
  "BetterAuthMigrationError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Failure of a `secondaryStorage` operation. */
export class BetterAuthStorageError extends Data.TaggedError(
  "BetterAuthStorageError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
