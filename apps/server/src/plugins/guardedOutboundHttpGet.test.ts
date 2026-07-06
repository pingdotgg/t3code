import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type {
  PluginHttpClientTransport,
  PluginPinnedHttpRequest,
} from "./capabilities/HttpClientCapability.ts";
import { guardedOutboundHttpGet } from "./guardedOutboundHttpGet.ts";
import { OutboundUrlError, type UrlValidatorDeps } from "./OutboundUrlValidator.ts";

const lookupFor =
  (hosts: Record<string, string>): UrlValidatorDeps["lookup"] =>
  (host) => {
    const address = hosts[host];
    return address === undefined
      ? Effect.fail(new OutboundUrlError({ reason: `unexpected lookup ${host}` }))
      : Effect.succeed([{ address, family: 4 as const }]);
  };

const transportFor = (input: {
  readonly responses: Record<string, () => Response>;
  readonly requests?: Array<PluginPinnedHttpRequest>;
}): PluginHttpClientTransport => {
  return (request) => {
    input.requests?.push(request);
    const url = request.url.toString();
    const respond = input.responses[url] ?? (() => new Response("", { status: 404 }));
    return Effect.succeed(HttpClientResponse.fromWeb(HttpClientRequest.get(url), respond()));
  };
};

it.effect("guardedOutboundHttpGet pins requests to the resolved address", () =>
  Effect.gen(function* () {
    const requests: Array<PluginPinnedHttpRequest> = [];
    const response = yield* guardedOutboundHttpGet({
      url: "https://public.test/file",
      lookup: lookupFor({ "public.test": "93.184.216.34" }),
      transport: transportFor({
        responses: { "https://public.test/file": () => new Response("ok") },
        requests,
      }),
      timeoutMs: 1000,
    });

    assert.equal(response.status, 200);
    assert.equal(requests[0]?.address.address, "93.184.216.34");
  }),
);

it.effect("guardedOutboundHttpGet rejects URLs that resolve to blocked addresses", () =>
  Effect.gen(function* () {
    const requests: Array<PluginPinnedHttpRequest> = [];
    const result = yield* Effect.result(
      guardedOutboundHttpGet({
        url: "https://internal.test/admin",
        lookup: lookupFor({ "internal.test": "169.254.169.254" }),
        transport: transportFor({ responses: {}, requests }),
        timeoutMs: 1000,
      }),
    );

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.equal(result.failure._tag, "OutboundUrlError");
    // Rejected during validation: no request may reach the transport.
    assert.deepEqual(requests, []);
  }),
);

it.effect("guardedOutboundHttpGet follows redirects only through validated hosts", () =>
  Effect.gen(function* () {
    const response = yield* guardedOutboundHttpGet({
      url: "https://public.test/file",
      lookup: lookupFor({ "public.test": "93.184.216.34", "cdn.test": "203.0.114.9" }),
      transport: transportFor({
        responses: {
          "https://public.test/file": () =>
            new Response(null, { status: 302, headers: { location: "https://cdn.test/file" } }),
          "https://cdn.test/file": () => new Response("real bytes"),
        },
      }),
      timeoutMs: 1000,
    });

    assert.equal(response.status, 200);
  }),
);

it.effect(
  "guardedOutboundHttpGet rejects redirects to blocked addresses without fetching them",
  () =>
    Effect.gen(function* () {
      const requests: Array<PluginPinnedHttpRequest> = [];
      const result = yield* Effect.result(
        guardedOutboundHttpGet({
          url: "https://public.test/file",
          lookup: lookupFor({ "public.test": "93.184.216.34", "metadata.test": "169.254.169.254" }),
          transport: transportFor({
            responses: {
              "https://public.test/file": () =>
                new Response(null, {
                  status: 302,
                  headers: { location: "https://metadata.test/latest/meta-data" },
                }),
            },
            requests,
          }),
          timeoutMs: 1000,
        }),
      );

      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.equal(result.failure._tag, "OutboundUrlError");
      assert.deepEqual(
        requests.map((request) => request.url.hostname),
        ["public.test"],
      );
    }),
);

it.effect("guardedOutboundHttpGet rejects redirects that downgrade to http", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      guardedOutboundHttpGet({
        url: "https://public.test/file",
        lookup: lookupFor({ "public.test": "93.184.216.34", localhost: "127.0.0.1" }),
        transport: transportFor({
          responses: {
            "https://public.test/file": () =>
              new Response(null, {
                status: 302,
                headers: { location: "http://localhost:8080/steal" },
              }),
          },
        }),
        timeoutMs: 1000,
      }),
    );

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.equal(result.failure._tag, "OutboundUrlError");
      assert.include(result.failure.reason, "https");
    }
  }),
);

it.effect("guardedOutboundHttpGet gives up after too many redirects", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      guardedOutboundHttpGet({
        url: "https://public.test/loop",
        lookup: lookupFor({ "public.test": "93.184.216.34" }),
        transport: transportFor({
          responses: {
            "https://public.test/loop": () =>
              new Response(null, {
                status: 302,
                headers: { location: "https://public.test/loop" },
              }),
          },
        }),
        timeoutMs: 1000,
      }),
    );

    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.equal(result.failure._tag, "OutboundUrlError");
      assert.include(result.failure.reason, "redirects");
    }
  }),
);

it.effect("guardedOutboundHttpGet returns redirect responses without a Location as-is", () =>
  Effect.gen(function* () {
    const response = yield* guardedOutboundHttpGet({
      url: "https://public.test/file",
      lookup: lookupFor({ "public.test": "93.184.216.34" }),
      transport: transportFor({
        responses: {
          "https://public.test/file": () => new Response(null, { status: 302 }),
        },
      }),
      timeoutMs: 1000,
    });

    // The caller's status filter is responsible for rejecting it.
    assert.equal(response.status, 302);
  }),
);
