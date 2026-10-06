import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import * as EffectNodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { RelayApi } from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
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
import * as HttpMiddleware from "effect/http/HttpMiddleware";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import { RELAY_HTTP_ROUTER_CONFIG, traceRelayHttpRequestWith } from "../http/Api.ts";
import * as RelayHttpApi from "../http/Api.ts";
import * as HookForwarder from "./HookForwarder.ts";
import { RELAY_HOOK_DELIVERY_TYP, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as HeldHooks from "./HeldHooks.ts";
import * as HookInbox from "./HookInbox.ts";
import type { HeldHook } from "./HookInboxStore.ts";
import { RELAY_HOOK_UPSTREAM_TIMEOUT_MS } from "./upstream.ts";

const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const settings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make(mintKeys.privateKey),
  cloudMintPublicKey: mintKeys.publicKey,
  managedEndpointBaseDomain: "example.test",
  managedEndpointNamespace: "dev",
};

const environmentId = "env-hook";
const endpointKey = "0123456789abcdef";
const readyAllocation: ManagedEndpointAllocations.ManagedEndpointAllocation = {
  userId: "user_1",
  environmentId,
  hostname: "env.example.test",
  tunnelId: "tunnel-id",
  tunnelName: `t3coderelay-managedendpoint-dev-${endpointKey}`,
  dnsRecordId: "dns-record-id",
  readyAt: "2026-05-25T00:00:00.000Z",
  tunnelReleasedAt: null,
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
  holdWebhooksWhileOffline: false,
};

interface Harness {
  readonly execute?: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
  readonly links?: ReadonlyArray<typeof managedLink>;
  readonly allocation?: ManagedEndpointAllocations.ManagedEndpointAllocation | null;
  readonly allow?: (key: string) => boolean;
  readonly allowEndpoint?: (endpointKey: string) => boolean;
  /** Inbox capacity; hold reports full once this many requests are held. */
  readonly inboxCapacity?: number;
}

function makeHarness(options: Harness = {}) {
  const sent: Array<HttpClientRequest.HttpClientRequest> = [];
  const rateLimitKeys: Array<string> = [];
  const held: Array<HeldHook & { readonly baseUrl: string }> = [];
  const execute =
    options.execute ??
    ((request: HttpClientRequest.HttpClientRequest) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
        ),
      ));
  const layerForwarder = HookForwarder.layer.pipe(
    Layer.provideMerge(HeldHooks.layer),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RelayConfiguration.RelayConfiguration, settings),
        Layer.mock(EnvironmentLinks.EnvironmentLinks, {
          findActiveManagedForEnvironment: (input) =>
            Effect.succeed(
              (options.links ?? [managedLink]).filter(
                (link) =>
                  link.environmentId === input.environmentId &&
                  (input.userId === undefined || link.userId === input.userId),
              ),
            ),
        }),
        Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {
          getByTunnelName: (tunnelName) => {
            const allocation =
              options.allocation === undefined ? readyAllocation : options.allocation;
            return Effect.succeed(allocation?.tunnelName === tunnelName ? allocation : null);
          },
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            sent.push(request);
            return execute(request);
          }),
        ),
        Layer.mock(HookInbox.HookInbox, {
          hold: ({ hook, baseUrl }) =>
            Effect.sync(() => {
              if (held.length >= (options.inboxCapacity ?? Infinity)) return false;
              held.push({ ...hook, baseUrl });
              return true;
            }),
        }),
        EffectNodeCrypto.layer,
        Layer.succeed(HookForwarder.HookRateLimiter, {
          allowHook: (key) =>
            Effect.sync(() => {
              rateLimitKeys.push(key);
              return options.allow ? options.allow(key) : true;
            }),
          allowEndpoint: (key) =>
            Effect.sync(() => (options.allowEndpoint ? options.allowEndpoint(key) : true)),
        }),
      ),
    ),
  );
  const httpEffect = HttpRouter.toHttpEffect(
    Layer.mergeAll(
      HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.hooks)).pipe(
        Layer.provide(HookForwarder.layerApi.pipe(Layer.provide(layerForwarder))),
        Layer.provide([NodeServices.layer, NodeHttpPlatform.layer, Etag.layerWeak]),
      ),
      RelayHttpApi.layerNotFoundRoute,
      RelayHttpApi.layerCors,
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
  return { sent, rateLimitKeys, held, send, httpEffect };
}

const hookUrl = (path = "hook-1/secret-token", query = "") =>
  `https://relay.test/v1/hooks/${endpointKey}/${path}${query}`;

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

  it.effect("signs each forward for the environment, replacing any copy a sender sent", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* harness.send(
        new Request(hookUrl("hook-1/tok"), {
          method: "POST",
          headers: { "x-t3-relay-delivery": "forged", "x-t3-relay-delivery-id": "forged" },
          body: "{}",
        }),
      );
      const sent = harness.sent[0]!;
      const payload = yield* verifyRelayJwt({
        publicKey: mintKeys.publicKey,
        token: sent.headers["x-t3-relay-delivery"]!,
        typ: RELAY_HOOK_DELIVERY_TYP,
        issuer: settings.relayIssuer,
        audience: `t3-env:${environmentId}`,
        nowEpochSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
      });
      // The proof names exactly the delivery the environment receives.
      expect(payload).toMatchObject({
        environmentId,
        hookId: "hook-1",
        deliveryId: sent.headers["x-t3-relay-delivery-id"],
        receivedAt: sent.headers["x-t3-relay-received-at"],
      });
      expect(sent.headers["x-t3-relay-delivery-id"]).not.toBe("forged");
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
      // Served from the relay's origin, so it may never render or run there.
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
      expect(new TextDecoder().decode(yield* readBody(response))).toBe('{"error":"bad_signature"}');
      expect(harness.sent[0]?.method).toBe("GET");
    }),
  );

  it.effect("never forwards or holds HEAD, which can carry no body", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ execute: () => Effect.die("must not be sent") });
      const response = yield* harness.send(new Request(hookUrl(), { method: "HEAD" }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(harness.held).toHaveLength(0);
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

  it.effect("returns 404 for unknown endpoints and unready endpoints", () =>
    Effect.gen(function* () {
      const unknown = makeHarness();
      for (const key of ["fedcba9876543210", environmentId]) {
        const response = yield* unknown.send(
          new Request(`https://relay.test/v1/hooks/${key}/hook-1/token`, { method: "POST" }),
        );
        expect(response.status).toBe(404);
        expect(yield* readJson(response)).toEqual({ error: "hook_not_found" });
      }
      expect(unknown.sent).toHaveLength(0);

      const unready = makeHarness({ allocation: { ...readyAllocation, readyAt: null } });
      const unreadyResponse = yield* unready.send(new Request(hookUrl(), { method: "POST" }));
      expect(unreadyResponse.status).toBe(404);
      expect(unready.sent).toHaveLength(0);
    }),
  );

  it.effect("forwards only to the link that owns the endpoint key", () =>
    Effect.gen(function* () {
      // Another account linked the same environment id under its own key; its
      // link must not receive this endpoint's hooks, whatever order rows come in.
      const intruder = {
        ...managedLink,
        userId: "user_attacker",
        environmentPublicKey: "attacker-key",
        endpoint: { ...managedLink.endpoint, httpBaseUrl: "https://attacker.example.test/" },
      };
      const harness = makeHarness({ links: [intruder, managedLink] });
      const response = yield* harness.send(new Request(hookUrl(), { method: "POST", body: "{}" }));
      expect(response.status).toBe(200);
      expect(harness.sent.map((request) => new URL(request.url).host)).toEqual([
        "env.example.test",
      ]);

      // Without the owner's link, the key resolves to nothing at all.
      const orphaned = makeHarness({ links: [intruder] });
      const orphanedResponse = yield* orphaned.send(
        new Request(hookUrl(), { method: "POST", body: "{}" }),
      );
      expect(orphanedResponse.status).toBe(404);
      expect(orphaned.sent).toHaveLength(0);
    }),
  );

  it.effect("returns 429 when the endpoint's overall budget is spent", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ allowEndpoint: () => false });
      const response = yield* harness.send(new Request(hookUrl(), { method: "POST" }));
      expect(response.status).toBe(429);
      expect(harness.sent).toHaveLength(0);
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
      yield* TestClock.adjust(Duration.millis(RELAY_HOOK_UPSTREAM_TIMEOUT_MS));
      const response = yield* Fiber.join(fiber);
      expect(response.status).toBe(504);
      expect(yield* readJson(response)).toEqual({ error: "environment_timeout" });
    }),
  );

  it.effect("holds a timed-out request with the time it arrived", () =>
    Effect.gen(function* () {
      const reachedUpstream = yield* Deferred.make<void>();
      const harness = makeHarness({
        links: [{ ...managedLink, holdWebhooksWhileOffline: true }],
        execute: () =>
          Deferred.succeed(reachedUpstream, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const arrivedAt = DateTime.formatIso(yield* DateTime.now);
      const fiber = yield* harness
        .send(new Request(hookUrl(), { method: "POST", body: "{}" }))
        .pipe(Effect.forkChild);
      yield* Deferred.await(reachedUpstream);
      yield* TestClock.adjust(Duration.millis(RELAY_HOOK_UPSTREAM_TIMEOUT_MS));
      expect((yield* Fiber.join(fiber)).status).toBe(202);
      expect(harness.held[0]?.receivedAt).toBe(arrivedAt);
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
      expect(server?.attributes.get("url.path")).toBe(`/v1/hooks/${endpointKey}/hook-1/<redacted>`);
    }),
  );

  it.effect("records one redacted server span even inside the worker's own HTTP tracer", () =>
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
      // As the worker runtime runs it: its own tracer around ours, off for hook
      // paths. This checks the predicate; whether alchemy applies it per event
      // is only visible on a deployed worker (see worker.ts).
      yield* HttpMiddleware.tracer(
        traceRelayHttpRequestWith(handler, Layer.succeed(Tracer.Tracer, tracer)),
      ).pipe(
        Effect.provideService(HttpMiddleware.TracerDisabledWhen, (request) =>
          HookForwarder.isRelayHookPath(request.url),
        ),
        Effect.withTracer(tracer),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(hookUrl("hook-1/super-secret-token"), {
              method: "POST",
              headers: { traceparent: "00-11111111111111111111111111111111-2222222222222222-01" },
              body: "{}",
            }),
          ),
        ),
      );
      yield* Effect.yieldNow;
      const servers = spans.filter((span) => span.kind === "server");
      expect(servers).toHaveLength(1);
      expect(servers[0]?.attributes.get("url.path")).toBe(
        `/v1/hooks/${endpointKey}/hook-1/<redacted>`,
      );
      expect(spans.every((span) => span.traceId !== "11111111111111111111111111111111")).toBe(true);
    }),
  );

  it.effect("joins the environment to its trace and records what the environment did", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const respondWith = (outcome: string) =>
        makeHarness({
          execute: (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response('{"deliveryId":"d"}', {
                  status: 202,
                  headers: { "x-t3-hook-outcome": outcome },
                }),
              ),
            ),
        });
      const forward = (harness: ReturnType<typeof makeHarness>) =>
        Effect.gen(function* () {
          const handler = yield* harness.httpEffect;
          return yield* traceRelayHttpRequestWith(
            handler,
            Layer.succeed(Tracer.Tracer, tracer),
          ).pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(
                new Request(hookUrl(), {
                  method: "POST",
                  // A sender's own trace context never reaches the environment.
                  headers: {
                    traceparent: "00-11111111111111111111111111111111-2222222222222222-01",
                    "x-b3-traceid": "33333333333333333333333333333333",
                  },
                  body: "{}",
                }),
              ),
            ),
          );
        });

      const duplicate = respondWith("duplicate");
      expect((yield* forward(duplicate)).status).toBe(202);
      yield* Effect.yieldNow;
      const forwardSpan = spans.find((span) => span.name === "relay.hooks.forward");
      expect(forwardSpan?.attributes.get("relay.hook.upstream_outcome")).toBe("duplicate");
      const sent = duplicate.sent[0]!;
      expect(sent.headers.traceparent).toContain(forwardSpan!.traceId);
      expect(sent.headers.traceparent).not.toContain("1111111111");
      expect(sent.headers["x-b3-traceid"]).toBeUndefined();

      // Only a plain outcome name is recorded.
      spans.length = 0;
      yield* forward(respondWith("<script>alert(1)</script>"));
      yield* Effect.yieldNow;
      expect(
        spans
          .find((span) => span.name === "relay.hooks.forward")
          ?.attributes.has("relay.hook.upstream_outcome"),
      ).toBe(false);
    }),
  );

  describe("holding requests while the environment is offline", () => {
    const offline = (request: HttpClientRequest.HttpClientRequest) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error("offline") }),
        }),
      );

    it.effect("holds when cloudflared answers that the local server is down", () =>
      Effect.gen(function* () {
        for (const status of [502, 503, 504, 530]) {
          const harness = makeHarness({
            links: [{ ...managedLink, holdWebhooksWhileOffline: true }],
            execute: (request) =>
              Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status }))),
          });
          const response = yield* harness.send(
            new Request(hookUrl(), { method: "POST", body: "{}" }),
          );
          expect(response.status).toBe(202);
          expect(harness.held).toHaveLength(1);
        }
      }),
    );

    it.effect("stays a plain proxy when the environment has not opted in", () =>
      Effect.gen(function* () {
        const harness = makeHarness({ execute: offline });
        const response = yield* harness.send(
          new Request(hookUrl(), { method: "POST", body: "{}" }),
        );
        expect(response.status).toBe(503);
        expect(harness.held).toHaveLength(0);
      }),
    );

    it.effect("holds the exact request and answers 202 once opted in", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          execute: offline,
          links: [{ ...managedLink, holdWebhooksWhileOffline: true }],
        });
        const body = new Uint8Array([0, 255, 10]);
        const response = yield* harness.send(
          new Request(hookUrl("%68ook-1/tok%2Fen", "?a=1"), {
            method: "POST",
            body,
            headers: { "x-t3-relay-delivery-id": "forged", "x-sig": "s" },
          }),
        );
        expect(response.status).toBe(202);
        const [hook] = harness.held;
        expect(hook?.baseUrl).toBe("https://env.example.test/");
        expect(hook?.rawToken).toBe("tok%2Fen");
        expect(hook?.query).toBe("a=1");
        expect([...(hook?.body ?? [])]).toEqual([0, 255, 10]);
        expect(hook?.headers["x-sig"]).toBe("s");
        // Every spelling of the hook id shares one per-hook cap.
        expect(hook?.hookKey).toBe("hook-1");
        // The sender cannot choose the delivery id.
        expect(hook?.headers["x-t3-relay-delivery-id"]).toBeUndefined();
        expect(hook?.id).not.toBe("forged");
      }),
    );

    it.effect("answers 503 inbox_full when the environment's inbox is full", () =>
      Effect.gen(function* () {
        const harness = makeHarness({
          execute: offline,
          links: [{ ...managedLink, holdWebhooksWhileOffline: true }],
          inboxCapacity: 0,
        });
        const response = yield* harness.send(
          new Request(hookUrl(), { method: "POST", body: "{}" }),
        );
        expect(response.status).toBe(503);
        expect(yield* readJson(response)).toEqual({ error: "inbox_full" });
      }),
    );

    it.effect("tags every forward with a relay delivery id", () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* harness.send(
          new Request(hookUrl(), {
            method: "POST",
            body: "{}",
            headers: { "x-t3-relay-delivery-id": "forged" },
          }),
        );
        const id = harness.sent[0]?.headers["x-t3-relay-delivery-id"];
        expect(id).toMatch(/^[0-9a-f-]{36}$/);
      }),
    );
  });
});
