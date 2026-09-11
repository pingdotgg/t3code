import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpClientError from "effect/unstable/http/HttpClientError";

import { filterRelayResponse, relayRequestError, shouldRetryCloudLink } from "./relayResponse.ts";

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

  expect(error._tag).toBe("EnvironmentHttpInternalServerError");
  expect(error.message).toContain("TransportError");
  expect(error.message).toContain("network connection");
  expect(error.message).not.toContain("relay.example.test");
  expect(error.message).not.toContain("private");
  expect(shouldRetryCloudLink(error)).toBe(true);
});

it.effect("reports the tunnel limit and relay trace instead of a generic 403", () =>
  Effect.gen(function* () {
    const error = yield* filterRelayResponse(
      response(403, {
        _tag: "RelayEnvironmentLinkLimitExceededError",
        code: "environment_link_limit_exceeded",
        maxTunnels: 3,
        traceId: "trace-limit",
      }),
    ).pipe(Effect.mapError(relayRequestError), Effect.flip);

    expect(error._tag).toBe("EnvironmentHttpForbiddenError");
    expect(error.message).toContain("at most 3 tunnels");
    expect(error.message).toContain("Unlink an unused environment");
    expect(error.message).toContain("Trace ID: trace-limit");
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

    expect(error._tag).toBe("EnvironmentHttpUnauthorizedError");
    expect(error.message).toContain("invalid_bearer");
    expect(error.message).toContain("t3 connect login");
    expect(error.message).toContain("Trace ID: trace-auth");
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

    expect(error._tag).toBe("EnvironmentHttpForbiddenError");
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
      expect(error._tag).toBe("EnvironmentHttpInternalServerError");
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
      Effect.retry({ while: shouldRetryCloudLink, times: 1 }),
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

    expect(error._tag).toBe("EnvironmentHttpInternalServerError");
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
