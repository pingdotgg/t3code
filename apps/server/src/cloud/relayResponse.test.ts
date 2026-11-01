import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpClientError from "effect/http/HttpClientError";

import {
  filterRelayResponse,
  relayRequestError,
  relayRetryAfterMillis,
  shouldRetryRelayRequest,
} from "./relayResponse.ts";

const response = (
  status: number,
  body: string | Record<string, unknown>,
  headers?: Record<string, string>,
) =>
  HttpClientResponse.fromWeb(
    HttpClientRequest.post("https://relay.example.test/v1/client/environment-links"),
    typeof body === "string"
      ? new Response(body, { status, ...(headers ? { headers } : {}) })
      : Response.json(body, { status, ...(headers ? { headers } : {}) }),
  );

it("reports a transport failure category without exposing request or cause details", () => {
  const error = relayRequestError(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request: HttpClientRequest.post("https://relay.example.test/link?token=private-token"),
        description: "private transport details",
        cause: new Error("private cause details"),
      }),
    }),
  );

  expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "unavailable" });
  expect(error.message).toContain("TransportError");
  expect(error.message).toContain("network connection");
  expect(error.message).not.toContain("relay.example.test");
  expect(error.message).not.toContain("private");
  expect(shouldRetryRelayRequest(error)).toBe(true);
});

it.effect("retries an expired link proof but not a revoked bearer, both 401", () =>
  Effect.gen(function* () {
    const expired = yield* filterRelayResponse(
      response(401, {
        _tag: "RelayEnvironmentLinkProofExpiredError",
        code: "environment_link_proof_expired",
        traceId: "trace-expired",
      }),
    ).pipe(Effect.mapError(relayRequestError), Effect.flip);
    const revoked = yield* filterRelayResponse(
      response(401, {
        _tag: "RelayAuthInvalidError",
        code: "auth_invalid",
        reason: "invalid_bearer",
        traceId: "trace-auth",
      }),
    ).pipe(Effect.mapError(relayRequestError), Effect.flip);

    expect(expired).toMatchObject({ _tag: "RelayRequestError", rejection: "unavailable" });
    expect(expired.message).toContain("Relay environment link proof expired");
    expect(expired.message).toContain("date and time");
    expect(expired.message).toContain("Trace ID: trace-expired");
    expect(shouldRetryRelayRequest(expired)).toBe(true);
    expect(revoked).toMatchObject({ rejection: "unauthorized" });
    expect(shouldRetryRelayRequest(revoked)).toBe(false);
  }),
);

it.effect("reports an unrecognized access denial without printing its response body", () =>
  Effect.gen(function* () {
    const error = yield* filterRelayResponse(
      response(403, "<html>private upstream details</html>", {
        "content-type": "text/html",
        "cf-ray": "abcdef1234-IAD",
      }),
    ).pipe(Effect.flip);

    expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "forbidden" });
    expect(error.message).toContain("HTTP 403");
    expect(error.message).toContain("proxy or firewall");
    expect(error.message).toContain("Cloudflare Ray ID: abcdef1234-IAD");
    expect(error.message).not.toContain("private upstream details");
  }),
);

it.effect("keeps the relay's Retry-After on a retryable failure", () =>
  Effect.gen(function* () {
    const seconds = yield* filterRelayResponse(
      response(503, "paused", { "retry-after": "30" }),
    ).pipe(Effect.flip);
    expect(seconds).toMatchObject({ rejection: "unavailable", retryAfterMillis: 30_000 });
    expect(relayRetryAfterMillis({ cause: { cause: seconds } })).toBe(30_000);

    // The test clock starts at the epoch, so the date is 90 seconds after it.
    const date = yield* filterRelayResponse(
      response(429, "slow down", { "retry-after": "Thu, 01 Jan 1970 00:01:30 GMT" }),
    ).pipe(Effect.flip);
    expect(date.retryAfterMillis).toBe(90_000);

    const malformed = yield* filterRelayResponse(
      response(503, "paused", { "retry-after": "soon" }),
    ).pipe(Effect.flip);
    expect(malformed.retryAfterMillis).toBeUndefined();
  }),
);

it.effect.each([
  { status: 401, attempts: 1 },
  { status: 403, attempts: 1 },
  { status: 429, attempts: 2 },
  { status: 503, attempts: 2 },
])("stops rejected startup links but retries temporary failures: $status", ({ status, attempts }) =>
  Effect.gen(function* () {
    let requests = 0;
    const result = yield* Effect.suspend(() => {
      requests++;
      return filterRelayResponse(response(requests === 1 ? status : 200, "{}"));
    }).pipe(
      Effect.mapError(relayRequestError),
      Effect.retry({ while: shouldRetryRelayRequest, times: 1 }),
      Effect.result,
    );
    expect(requests).toBe(attempts);
    expect(result._tag).toBe(attempts === 1 ? "Failure" : "Success");
  }),
);
