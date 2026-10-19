import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestClock from "effect/testing/TestClock";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpClientError from "effect/http/HttpClientError";

import {
  filterRelayResponse,
  relayRequestError,
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

it.effect("reports the tunnel limit and relay trace instead of a generic 403", () =>
  Effect.gen(function* () {
    const error = yield* filterRelayResponse(
      response(
        403,
        {
          _tag: "RelayEnvironmentLinkLimitExceededError",
          code: "environment_link_limit_exceeded",
          maxTunnels: 3,
          traceId: "trace-limit",
        },
        { date: "Thu, 01 Jan 1970 00:07:00 GMT" },
      ),
    ).pipe(Effect.mapError(relayRequestError), Effect.flip);

    expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "forbidden" });
    expect(error.message).toContain("at most 3 tunnels");
    expect(error.message).toContain("Unlink an unused environment");
    expect(error.message).toContain("Trace ID: trace-limit");
    expect(shouldRetryRelayRequest(error)).toBe(false);
    expect(error.clockSkewSeconds).toBeUndefined();
  }),
);

it.effect("makes revoked authorization actionable and non-retryable", () =>
  Effect.gen(function* () {
    const error = yield* filterRelayResponse(
      response(401, {
        _tag: "RelayAuthInvalidError",
        code: "auth_invalid",
        reason: "invalid_bearer",
        traceId: "trace-auth",
      }),
    ).pipe(Effect.mapError(relayRequestError), Effect.flip);

    expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "unauthorized" });
    expect(error.message).toContain("invalid_bearer");
    expect(error.message).toContain("t3 connect login");
    expect(error.message).toContain("Trace ID: trace-auth");
  }),
);

it.effect("keeps a rejected proof retryable until the host clock is within 60 seconds", () =>
  Effect.gen(function* () {
    const rejectedProof = () =>
      filterRelayResponse(
        response(
          400,
          {
            _tag: "RelayEnvironmentLinkProofInvalidError",
            code: "environment_link_proof_invalid",
            reason: "invalid_signature_or_scope",
            traceId: "trace-clock",
          },
          { date: "Thu, 01 Jan 1970 00:07:00 GMT" },
        ),
      ).pipe(Effect.flip);

    const skewed = yield* rejectedProof();
    expect(skewed.clockSkewSeconds).toBe(-420);
    expect(shouldRetryRelayRequest(skewed)).toBe(true);
    expect(skewed.message).toContain("clock is 7 minutes behind");
    expect(skewed.message).toContain('"Sync now"');
    expect(skewed.message).toContain("reconnects by itself");
    expect(skewed.message).toContain("Trace ID: trace-clock");

    yield* TestClock.setTime(359_000);
    expect(shouldRetryRelayRequest(yield* rejectedProof())).toBe(true);
    yield* TestClock.setTime(360_000);
    const withinTolerance = yield* rejectedProof();
    expect(withinTolerance.clockSkewSeconds).toBeUndefined();
    expect(shouldRetryRelayRequest(withinTolerance)).toBe(false);
  }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
);

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

it.effect.each([408, 429, 500, 502, 503, 504])(
  "keeps transient HTTP %s failures retryable",
  (status) =>
    Effect.gen(function* () {
      const error = yield* filterRelayResponse(response(status, "unavailable")).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "unavailable" });
      expect(error.message).toContain(`HTTP ${status}`);
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

it.effect("keeps the relay failure reason and trace when tunnel cleanup fails", () =>
  Effect.gen(function* () {
    const error = yield* filterRelayResponse(
      response(500, {
        _tag: "RelayInternalError",
        code: "internal_error",
        reason: "upstream_unavailable",
        traceId: "trace-cleanup",
      }),
    ).pipe(Effect.flip);

    expect(error).toMatchObject({ _tag: "RelayRequestError", rejection: "unavailable" });
    expect(error.message).toContain("upstream_unavailable");
    expect(error.message).toContain("Trace ID: trace-cleanup");
  }),
);

it.effect("leaves successful response bodies available to their decoder", () =>
  Effect.gen(function* () {
    const result = yield* filterRelayResponse(response(200, '{"ok":true}'));
    expect(yield* result.json).toEqual({ ok: true });
  }),
);
