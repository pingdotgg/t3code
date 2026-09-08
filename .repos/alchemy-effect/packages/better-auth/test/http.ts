import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/** Typed failure for the fixture-driving HTTP helpers. */
export class AuthHttpError extends Data.TaggedError("AuthHttpError")<{
  readonly url: string;
  readonly status: number;
  readonly body: string;
}> {
  override get message(): string {
    return `${this.url} -> ${this.status}: ${this.body.slice(0, 300)}`;
  }
}

export interface AuthHttpResponse {
  readonly status: number;
  readonly body: string;
  readonly setCookies: ReadonlyArray<string>;
}

const request = (
  url: string,
  init: RequestInit,
): Effect.Effect<AuthHttpResponse, AuthHttpError> =>
  Effect.tryPromise({
    try: async (signal): Promise<AuthHttpResponse> => {
      const response = await fetch(url, { ...init, signal });
      return {
        status: response.status,
        body: await response.text(),
        setCookies: response.headers.getSetCookie(),
      };
    },
    catch: (cause) =>
      new AuthHttpError({ url, status: 0, body: String(cause) }),
  });

export const postJson = (
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Effect.Effect<AuthHttpResponse, AuthHttpError> =>
  request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

export const getJson = <T>(
  url: string,
  headers?: Record<string, string>,
): Effect.Effect<T, AuthHttpError> =>
  request(url, { method: "GET", headers }).pipe(
    Effect.filterOrFail(
      (response) => response.status === 200,
      (response) => new AuthHttpError({ url, ...response }),
    ),
    Effect.map((response) => JSON.parse(response.body) as T),
  );

/**
 * Retry for the first requests against a freshly-deployed workers.dev URL
 * — the subdomain takes a few seconds to start serving.
 */
export const edgeRetry = Effect.retry({
  schedule: Schedule.exponential("1 second", 1.5),
  times: 8,
});

/** Reduce set-cookie headers to a `cookie` request header value. */
export const toCookieHeader = (setCookies: ReadonlyArray<string>): string =>
  setCookies
    .map((cookie) => cookie.split(";")[0])
    .filter((pair): pair is string => pair !== undefined && pair !== "")
    .join("; ");
