import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi } from "@t3tools/contracts/relay";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Etag from "effect/http/Etag";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import {
  RELAY_HTTP_ROUTER_CONFIG,
  relayCors,
  relayNotFoundRoute,
  traceRelayHttpRequestWith,
} from "../http/Api.ts";
import * as HookForwarder from "./HookForwarder.ts";

const settings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: undefined,
};

const environmentId = "env-hook";
const readyAllocation: ManagedEndpointAllocations.ManagedEndpointAllocation = {
  userId: "user_1",
  environmentId,
  hostname: "env.example.test",
  tunnelId: "tunnel-id",
  tunnelName: "tunnel-name",
  dnsRecordId: "dns-record-id",
  readyAt: "2026-05-25T00:00:00.000Z",
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
  updatedAt: "2026-05-25T00:00:00.000Z",
  generation: 1,
};

const managedLink = {
  userId: "user_1",
  environmentId: environmentId as never,
  label: "Hook env",
  endpoint: {
    httpBaseUrl: "https://env.example.test/",
    wsBaseUrl: "wss://env.example.test/ws",
    providerKind: "cloudflare_tunnel" as const,
  },
  environmentPublicKey: "public-key",
  linkedAt: "2026-05-25T00:00:00.000Z",
};

interface Harness {
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
  readonly links?: ReadonlyArray<typeof managedLink>;
  readonly allocation?: ManagedEndpointAllocations.ManagedEndpointAllocation | null;
  readonly allow?: (key: string) => boolean;
}

function makeHarness(options: Harness = {}) {
  const sent: Array<HttpClientRequest.HttpClientRequest> = [];
  const rateLimitKeys: Array<string> = [];
  const execute =
    options.execute ??
    ((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
        ),
      ));
  const forwarderLayer = HookForwarder.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayConfiguration.RelayConfiguration, settings),
        Layer.mock(EnvironmentLinks.EnvironmentLinks, {
          findActiveManagedForEnvironment: (input) =>
            Effect.succeed(
              input.environmentId === environmentId ? (options.links ?? [managedLink]) : [],
            ),
        }),
        Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {
          get: () =>
            Effect.succeed(options.allocation === undefined ? readyAllocation : options.allocation),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            sent.push(request);
            return execute(request);
          }),
        ),
        Layer.succeed(HookForwarder.HookRateLimiter, {
          allow: (key) =>
            Effect.sync(() => {
              rateLimitKeys.push(key);
              return options.allow ? options.allow(key) : true;
            }),
        }),
      ),
    ),
  );
  const httpEffect = HttpRouter.toHttpEffect(
    Layer.mergeAll(
      HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.hooks)).pipe(
        Layer.provide(HookForwarder.hooksApi.pipe(Layer.provide(forwarderLayer))),
        Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
      ),
      relayNotFoundRoute,
      relayCors,
    ),
  ).pipe(Effect.provideService(HttpRouter.RouterConfig, RELAY_HTTP_ROUTER_CONFIG));
  const send = (request: Request) =>
    Effect.gen(function* () {
      const handler = yield* httpEffect;
      return yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(request),
        ),
      );
    });
  return { sent, rateLimitKeys, send, httpEffect };
}

const hookUrl = (path = "hook-1/secret-token", query = "") =>
  `https://relay.test/v1/hooks/${environmentId}/${path}${query}`;

const readBody = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.promise(() => HttpServerResponse.toWeb(response).arrayBuffer()).pipe(
    Effect.map((buffer) => new Uint8Array(buffer)),
  );
const readJson = (response: HttpServerResponse.HttpServerResponse) =>
  Effect.promise(() => HttpServerResponse.toWeb(response).json());

const requestBytes = (request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(0);

describe("HookForwarder", () => {
  it.effect("forwards the exact body bytes, query and filtered headers", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const body = new Uint8Array([0, 255, 10, 13, 0x7b, 0x22, 0xc3, 0x28]);
      const response = yield* harness.send(
        new Request(hookUrl("hook-1/tok%2Fen", "?a=1&b=two%20words"), {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            authorization: "Bearer sender-secret",
            "x-hub-signature-256": "sha256=abc",
            cookie: "session=1",
            "cf-connecting-ip": "1.2.3.4",
            "x-forwarded-for": "1.2.3.4",
            "x-real-ip": "1.2.3.4",
            "proxy-authorization": "Basic x",
            connection: "keep-alive",
          },
          body,
        }),
      );
      expect(response.status).toBe(200);
      expect(harness.sent).toHaveLength(1);
      const sent = harness.sent[0]!;
      expect(sent.method).toBe("POST");
      expect(sent.url).toBe("https://env.example.test/api/hooks/hook-1/tok%2Fen?a=1&b=two%20words");
      expect(Array.from(requestBytes(sent))).toEqual(Array.from(body));
      expect(sent.headers.authorization).toBe("Bearer sender-secret");
      expect(sent.headers["x-hub-signature-256"]).toBe("sha256=abc");
      expect(sent.headers["content-type"]).toBe("application/octet-stream");
      for (const dropped of [
        "cookie",
        "cf-connecting-ip",
        "x-forwarded-for",
        "x-real-ip",
        "proxy-authorization",
        "connection",
        "host",
      ]) {
        expect(sent.headers[dropped]).toBeUndefined();
      }
      // Recomputed from the forwarded bytes, not copied from the sender.
      expect(sent.headers["content-length"]).toBe(String(body.length));
      // The budget key is a hash, so the token never reaches the limiter.
      expect(harness.rateLimitKeys).toHaveLength(1);
      expect(harness.rateLimitKeys[0]).toMatch(/^[0-9a-f]{64}$/);
    }),
  );

  it.effect("passes upstream status, body and content-type through", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        execute: (request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response('{"error":"bad_signature"}', {
                status: 401,
                headers: { "content-type": "application/json", "set-cookie": "x=1" },
              }),
            ),
          ),
      });
      const response = yield* harness.send(new Request(hookUrl(), { method: "GET" }));
      expect(response.status).toBe(401);
      expect(response.headers["content-type"]).toBe("application/json");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(new TextDecoder().decode(yield* readBody(response))).toBe('{"error":"bad_signature"}');
      expect(harness.sent[0]?.method).toBe("GET");
    }),
  );

  it.effect("does not follow or relay upstream redirects", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        execute: (request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: 302,
                headers: { location: "https://internal.example/" },
              }),
            ),
          ),
      });
      const response = yield* harness.send(new Request(hookUrl(), { method: "POST", body: "{}" }));
      expect(response.status).toBe(302);
      expect(response.headers.location).toBeUndefined();
      expect(harness.sent).toHaveLength(1);
    }),
  );

  it.effect("rejects bodies over 1 MiB by content-length and while reading", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const declared = yield* harness.send(
        new Request(hookUrl(), {
          method: "POST",
          headers: { "content-length": String(HookForwarder.RELAY_HOOK_MAX_BODY_BYTES + 1) },
          body: "x",
        }),
      );
      expect(declared.status).toBe(413);

      const oversized = new Uint8Array(HookForwarder.RELAY_HOOK_MAX_BODY_BYTES + 1);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(oversized.subarray(0, 600_000));
          controller.enqueue(oversized.subarray(600_000));
          controller.close();
        },
      });
      const streamed = yield* harness.send(
        new Request(hookUrl(), { method: "POST", body: stream, duplex: "half" } as RequestInit),
      );
      expect(streamed.status).toBe(413);
      expect(yield* readJson(streamed)).toEqual({ error: "payload_too_large" });
      expect(harness.sent).toHaveLength(0);
    }),
  );

  it.effect("returns 404 for unknown environments and unready endpoints", () =>
    Effect.gen(function* () {
      const unknown = makeHarness();
      const response = yield* unknown.send(
        new Request("https://relay.test/v1/hooks/other-env/hook-1/token", { method: "POST" }),
      );
      expect(response.status).toBe(404);
      expect(yield* readJson(response)).toEqual({ error: "hook_not_found" });

      const unready = makeHarness({ allocation: { ...readyAllocation, readyAt: null } });
      const unreadyResponse = yield* unready.send(new Request(hookUrl(), { method: "POST" }));
      expect(unreadyResponse.status).toBe(404);
      expect(unready.sent).toHaveLength(0);
    }),
  );

  it.effect("maps tunnel-offline and network failures to 503", () =>
    Effect.gen(function* () {
      const offline = makeHarness({
        execute: (request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 530 }))),
      });
      const offlineResponse = yield* offline.send(new Request(hookUrl(), { method: "POST" }));
      expect(offlineResponse.status).toBe(503);
      expect(yield* readJson(offlineResponse)).toEqual({ error: "environment_unavailable" });

      const network = makeHarness({
        execute: (request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: new Error("reset") }),
            }),
          ),
      });
      const networkResponse = yield* network.send(new Request(hookUrl(), { method: "POST" }));
      expect(networkResponse.status).toBe(503);
    }),
  );

  it.effect("does not relay an upstream response larger than the cap", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        execute: (request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(new Uint8Array(64 * 1024 + 1), { status: 200 }),
            ),
          ),
      });
      const response = yield* harness.send(new Request(hookUrl(), { method: "POST" }));
      expect(response.status).toBe(503);
      expect(yield* readJson(response)).toEqual({ error: "environment_unavailable" });
    }),
  );

  it.effect("maps an upstream timeout to 504", () =>
    Effect.gen(function* () {
      // Advance the clock only once the request is waiting on the environment;
      // hashing the budget key before that step is asynchronous.
      const reachedUpstream = yield* Deferred.make<void>();
      const harness = makeHarness({
        execute: () =>
          Deferred.succeed(reachedUpstream, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const fiber = yield* harness
        .send(new Request(hookUrl(), { method: "POST", body: "{}" }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(reachedUpstream);
      yield* TestClock.adjust(Duration.millis(HookForwarder.RELAY_HOOK_UPSTREAM_TIMEOUT_MS));
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(504);
      expect(yield* readJson(response)).toEqual({ error: "environment_timeout" });
    }),
  );

  it.effect("answers OPTIONS without a CORS preflight or forwarding", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const response = yield* harness.send(new Request(hookUrl(), { method: "OPTIONS" }));
      // No hook endpoint accepts OPTIONS, so it falls through to the 404 route.
      expect(response.status).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["access-control-allow-methods"]).toBeUndefined();
      expect(harness.sent).toHaveLength(0);
    }),
  );

  it.effect("drops headers the sender names in Connection", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* harness.send(
        new Request(hookUrl(), {
          method: "POST",
          body: "{}",
          headers: { connection: "x-hop, keep-alive", "x-hop": "1", "x-keep": "2" },
        }),
      );
      const sent: Readonly<Record<string, string>> = harness.sent[0]?.headers ?? {};
      expect(sent["x-hop"]).toBeUndefined();
      expect(sent["x-keep"]).toBe("2");
    }),
  );

  it.effect("gives requests with a wrong token their own budget", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* harness.send(
        new Request(hookUrl("hook-1/real-token"), { method: "POST", body: "{}" }),
      );
      yield* harness.send(new Request(hookUrl("hook-1/guessed"), { method: "POST", body: "{}" }));
      expect(new Set(harness.rateLimitKeys).size).toBe(2);
    }),
  );

  it.effect("gives two spellings of one token a single budget", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* harness.send(new Request(hookUrl("hook-1/token"), { method: "POST", body: "{}" }));
      yield* harness.send(new Request(hookUrl("hook-1/%74oken"), { method: "POST", body: "{}" }));
      expect(new Set(harness.rateLimitKeys).size).toBe(1);
    }),
  );

  it.effect("returns 429 when the hook's budget is spent", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ allow: () => false });
      const response = yield* harness.send(new Request(hookUrl(), { method: "POST" }));
      expect(response.status).toBe(429);
      expect(harness.sent).toHaveLength(0);
    }),
  );

  it.effect("never records the token in the server span", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const harness = makeHarness();
      const handler = yield* harness.httpEffect;
      const response = yield* traceRelayHttpRequestWith(
        handler,
        Layer.succeed(Tracer.Tracer, tracer),
      ).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(hookUrl("hook-1/super-secret-token", "?sig=also-secret"), {
              method: "POST",
              headers: { "x-gitlab-token": "header-secret" },
              body: "{}",
            }),
          ),
        ),
      );
      expect(response.status).toBe(200);
      expect(harness.sent[0]?.url).toContain("super-secret-token");
      yield* Effect.yieldNow;
      const serialized = spans
        .flatMap((span) => [span.name, ...Array.from(span.attributes.values(), String)])
        .join("\n");
      expect(serialized).not.toContain("super-secret-token");
      expect(serialized).not.toContain("also-secret");
      expect(serialized).not.toContain("header-secret");
      const server = spans.find((span) => span.kind === "server");
      expect(server?.attributes.get("url.path")).toBe(
        `/v1/hooks/${environmentId}/hook-1/<redacted>`,
      );
    }),
  );
});
