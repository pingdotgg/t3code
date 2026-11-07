// @effect-diagnostics nodeBuiltinImport:off - the redirect test exercises the real fetch boundary.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PeerEnvironmentRegistry from "./PeerEnvironmentRegistry.ts";
import { PeerEnvironmentRegistryError } from "./PeerEnvironmentRegistry.ts";
import { descriptorOf } from "./PeerLinks.testkit.ts";

const self = descriptorOf("environment-self", "Self Here");

const layerSelfEnvironment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
  getEnvironmentId: Effect.succeed(self.environmentId),
  getDescriptor: Effect.succeed(self),
});

/** A paired peer's delegation session, as the exchange grants it. */
const GRANTED_SCOPES = "orchestration:read orchestration:operate terminal:operate";

interface FakePeer {
  readonly http: HttpClient.HttpClient;
  /** How often its descriptor was asked for. */
  readonly probes: () => number;
  /** The form bodies of the token-exchange requests it answered. */
  readonly exchanges: () => ReadonlyArray<Record<string, string>>;
}

interface FakeToken {
  readonly scope?: string;
  /** The access token it mints; defaults to one fixed value. */
  readonly accessToken?: string | (() => string);
  readonly status?: number;
  /** Only this origin answers the descriptor probe; default: every origin. */
  readonly answersAt?: string;
}

/**
 * The peer as the registry sees it over its HTTP client: a descriptor probe
 * and the bootstrap token exchange. No socket is opened.
 */
const fakePeer = (descriptor: ExecutionEnvironmentDescriptor, token: FakeToken = {}): FakePeer => {
  let probes = 0;
  const exchanges: Array<Record<string, string>> = [];
  const http = HttpClient.make((request) => {
    const url = new URL(request.url);
    if (url.pathname === "/.well-known/t3/environment") {
      probes += 1;
      if (token.answersAt !== undefined && url.origin !== token.answersAt) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(descriptor), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }
    if (url.pathname === "/oauth/token") {
      // The exchange posts the payload as urlencoded text.
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      exchanges.push(Object.fromEntries(new URLSearchParams(raw)));
      const accessToken =
        typeof token.accessToken === "function"
          ? token.accessToken()
          : (token.accessToken ?? "session-token");
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              access_token: accessToken,
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 3600,
              scope: token.scope ?? GRANTED_SCOPES,
            }),
            {
              status: token.status ?? 200,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      );
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })));
  });
  return { http, probes: () => probes, exchanges: () => exchanges };
};

const fakeContext = (
  descriptor: ExecutionEnvironmentDescriptor,
  token: FakeToken = {},
  openshellEnabled = true,
) =>
  buildContext(
    Layer.succeed(HttpClient.HttpClient, fakePeer(descriptor, token).http),
    openshellEnabled,
  );

const buildContext = (http: Layer.Layer<HttpClient.HttpClient>, openshellEnabled = true) =>
  Layer.build(
    PeerEnvironmentRegistry.layer.pipe(
      Layer.provide(http),
      Layer.provideMerge(layerSelfEnvironment),
      Layer.provideMerge(ServerSettings.layerTest({ openshellEnabled })),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-fleet-registry-" })),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Layer.fresh,
    ),
  );

const workerPeer = descriptorOf("environment-worker-1", "Worker One");

const worker = (urls: ReadonlyArray<string> = ["http://127.0.0.1:8111"]) => ({
  environmentId: workerPeer.environmentId,
  role: "worker" as const,
  label: "Worker One",
  urls,
  workerClass: "ephemeral" as const,
});

const reasonOf = (error: unknown) => (error as PeerEnvironmentRegistryError).reason;

/** A peer whose descriptor answers but whose token exchange never does. */
const silentExchangeContext = (descriptor: ExecutionEnvironmentDescriptor) =>
  buildContext(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        request.url.endsWith("/.well-known/t3/environment")
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(descriptor), {
                  status: 200,
                  headers: { "content-type": "application/json" },
                }),
              ),
            )
          : Effect.never,
      ),
    ),
  );

describe("PeerEnvironmentRegistry", () => {
  it.effect("registers, lists and forgets a peer worker", () =>
    Effect.gen(function* () {
      const registry = Context.get(
        yield* fakeContext(self),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const registered = yield* registry.register(worker());
      assert.equal(registered.environmentId, workerPeer.environmentId);
      assert.equal(registered.role, "worker");
      assert.equal(registered.workerClass, "ephemeral");
      assert.deepEqual(registered.urls, ["http://127.0.0.1:8111"]);
      assert.isTrue(Option.isNone(registered.session));

      assert.equal((yield* registry.list).length, 1);

      assert.isTrue(yield* registry.unregister(registered.environmentId));
      assert.deepEqual(yield* registry.list, []);
      assert.isTrue(Option.isNone(yield* registry.get(registered.environmentId)));
    }).pipe(Effect.scoped),
  );

  it.effect("registers a managing instance without a worker class", () =>
    Effect.gen(function* () {
      const registry = Context.get(
        yield* fakeContext(self),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const managing = yield* registry.register({
        environmentId: descriptorOf("environment-manager", "Manager").environmentId,
        role: "managing",
        label: "Manager",
        urls: ["http://127.0.0.1:8222"],
      });
      assert.isNull(managing.workerClass);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to manage peers while the fleet beta is off", () =>
    Effect.gen(function* () {
      const registry = Context.get(
        yield* fakeContext(self, {}, false),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const refused = yield* registry.register(worker()).pipe(Effect.flip);
      assert.equal(reasonOf(refused), "disabled");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to register this environment as its own peer", () =>
    Effect.gen(function* () {
      const registry = Context.get(
        yield* fakeContext(self),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const refused = yield* registry
        .register({ ...worker(), environmentId: self.environmentId })
        .pipe(Effect.flip);
      assert.equal(reasonOf(refused), "self");
    }).pipe(Effect.scoped),
  );

  it.effect("exchanges a bootstrap credential for a stored delegation session", () =>
    Effect.gen(function* () {
      const peer = fakePeer(workerPeer);
      const registry = Context.get(
        yield* buildContext(Layer.succeed(HttpClient.HttpClient, peer.http)),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const registered = yield* registry.register(worker());

      const paired = yield* registry.exchangeBootstrap({
        environmentId: registered.environmentId,
        bootstrapCredential: "one-time-bootstrap-credential",
      });
      const session = paired.session;
      assert.isTrue(Option.isSome(session));
      assert.deepEqual(Option.getOrThrow(session).scopes, [
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
      ]);
      assert.equal(paired.label, "Worker One");
      // The probe proved the address, then the exchange used it once.
      assert.equal(peer.probes(), 1);
      assert.equal(peer.exchanges().length, 1);
      const exchange = peer.exchanges()[0]!;
      assert.equal(exchange.grant_type, "urn:ietf:params:oauth:grant-type:token-exchange");
      assert.equal(exchange.subject_token, "one-time-bootstrap-credential");
      assert.equal(
        exchange.subject_token_type,
        "urn:t3:params:oauth:token-type:environment-bootstrap",
      );
      assert.equal(exchange.scope, GRANTED_SCOPES);

      // The bridge resolves the stored session, with the token from the peer.
      const resolved = yield* registry.resolveSession(registered.environmentId);
      assert.equal(resolved.token, "session-token");
      assert.equal(resolved.url, "http://127.0.0.1:8111");
      assert.equal(resolved.label, "Worker One");
    }).pipe(Effect.scoped),
  );

  it.effect("binds the session to the verified address and drops it when addresses change", () =>
    Effect.gen(function* () {
      const peer = fakePeer(workerPeer, { answersAt: "http://127.0.0.1:8112" });
      const registry = Context.get(
        yield* buildContext(Layer.succeed(HttpClient.HttpClient, peer.http)),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const urls = ["http://127.0.0.1:8111", "http://127.0.0.1:8112"];
      const registered = yield* registry.register(worker(urls));
      yield* registry.exchangeBootstrap({
        environmentId: registered.environmentId,
        bootstrapCredential: "one-time-bootstrap-credential",
      });
      assert.equal(
        (yield* registry.resolveSession(registered.environmentId)).url,
        "http://127.0.0.1:8112",
      );

      // Re-registering the same addresses keeps the session and its verified address.
      yield* registry.register(worker(urls));
      assert.equal(
        (yield* registry.resolveSession(registered.environmentId)).url,
        "http://127.0.0.1:8112",
      );

      yield* registry.register(worker(["http://127.0.0.1:9999"]));
      const refused = yield* registry.resolveSession(registered.environmentId).pipe(Effect.flip);
      assert.equal(refused.reason, "not_paired");
    }).pipe(Effect.scoped),
  );

  it.effect("compares address sets without duplicates when keeping a session", () =>
    Effect.gen(function* () {
      const peer = fakePeer(workerPeer, { answersAt: "http://127.0.0.1:8112" });
      const registry = Context.get(
        yield* buildContext(Layer.succeed(HttpClient.HttpClient, peer.http)),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const urls = ["http://127.0.0.1:8111", "http://127.0.0.1:8112"];
      const registered = yield* registry.register(worker(urls));
      yield* registry.exchangeBootstrap({
        environmentId: registered.environmentId,
        bootstrapCredential: "one-time-bootstrap-credential",
      });

      // [A, A, B] is the same SET as the stored [A, B]: the session stays.
      yield* registry.register(worker([urls[0]!, urls[0]!, urls[1]!]));
      assert.equal(
        (yield* registry.resolveSession(registered.environmentId)).url,
        "http://127.0.0.1:8112",
      );

      // [A, A] is a DIFFERENT set from the stored [A, B]: the session is dropped.
      yield* registry.register(worker([urls[0]!, urls[0]!]));
      const refused = yield* registry.resolveSession(registered.environmentId).pipe(Effect.flip);
      assert.equal(refused.reason, "not_paired");
    }).pipe(Effect.scoped),
  );

  it.effect("re-pairing replaces the stored session token", () =>
    Effect.gen(function* () {
      let issued = 0;
      const peer = fakePeer(workerPeer, { accessToken: () => `session-token-${(issued += 1)}` });
      const registry = Context.get(
        yield* buildContext(Layer.succeed(HttpClient.HttpClient, peer.http)),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const registered = yield* registry.register(worker());
      yield* registry.exchangeBootstrap({
        environmentId: registered.environmentId,
        bootstrapCredential: "first-credential",
      });
      assert.equal(
        (yield* registry.resolveSession(registered.environmentId)).token,
        "session-token-1",
      );

      yield* registry.exchangeBootstrap({
        environmentId: registered.environmentId,
        bootstrapCredential: "second-credential",
      });
      const resolved = yield* registry.resolveSession(registered.environmentId);
      assert.equal(resolved.token, "session-token-2");
      // Re-pairing updates the row, not a second one.
      assert.equal((yield* registry.list).length, 1);
      assert.equal(peer.exchanges().length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an exchange narrowed below the delegation scopes", () =>
    Effect.gen(function* () {
      const peer = fakePeer(workerPeer, { scope: "orchestration:read orchestration:operate" });
      const registry = Context.get(
        yield* buildContext(Layer.succeed(HttpClient.HttpClient, peer.http)),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const registered = yield* registry.register(worker());
      const refused = yield* registry
        .exchangeBootstrap({
          environmentId: registered.environmentId,
          bootstrapCredential: "narrow-credential",
        })
        .pipe(Effect.flip);
      assert.equal(reasonOf(refused), "exchange_rejected");
      const unpaired = Option.getOrThrow(yield* registry.get(registered.environmentId));
      assert.isTrue(Option.isNone(unpaired.session));
      assert.equal(peer.exchanges().length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an exchange at an address that answers as another environment", () =>
    Effect.gen(function* () {
      const peer = fakePeer(descriptorOf("environment-stranger", "Stranger"));
      const registry = Context.get(
        yield* buildContext(Layer.succeed(HttpClient.HttpClient, peer.http)),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const registered = yield* registry.register(worker());
      const refused = yield* registry
        .exchangeBootstrap({
          environmentId: registered.environmentId,
          bootstrapCredential: "credential",
        })
        .pipe(Effect.flip);
      assert.equal(reasonOf(refused), "unreachable");
      const unpaired = Option.getOrThrow(yield* registry.get(registered.environmentId));
      assert.isTrue(Option.isNone(unpaired.session));
      assert.equal(peer.exchanges().length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to resolve a peer that never paired", () =>
    Effect.gen(function* () {
      const registry = Context.get(
        yield* fakeContext(self),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const registered = yield* registry.register(worker());
      const refused = yield* registry.resolveSession(registered.environmentId).pipe(Effect.flip);
      assert.equal(reasonOf(refused), "not_paired");
      const unknown = yield* registry
        .resolveSession(descriptorOf("environment-nowhere", "Nowhere").environmentId)
        .pipe(Effect.flip);
      assert.equal(reasonOf(unknown), "unknown_peer");
    }).pipe(Effect.scoped),
  );

  it.effect("fails the exchange with exchange_timeout when the verified peer hangs", () =>
    Effect.gen(function* () {
      const registry = Context.get(
        yield* silentExchangeContext(workerPeer),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const registered = yield* registry.register(worker());
      const fiber = yield* Effect.forkScoped(
        registry.exchangeBootstrap({
          environmentId: registered.environmentId,
          bootstrapCredential: "credential",
        }),
      );
      yield* TestClock.adjust(Duration.seconds(16));
      const refused = yield* Fiber.join(fiber).pipe(Effect.flip);
      assert.equal(reasonOf(refused), "exchange_timeout");
      const unpaired = Option.getOrThrow(yield* registry.get(registered.environmentId));
      assert.isTrue(Option.isNone(unpaired.session));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a redirect after a verified descriptor and forwards no token", () =>
    Effect.gen(function* () {
      const received: Array<string> = [];
      let serverPort = 0;
      const server = yield* Effect.acquireRelease(
        Effect.callback<NodeHttp.Server>((resume) => {
          const listening = NodeHttp.createServer((request, response) => {
            const url = request.url ?? "";
            if (url === "/.well-known/t3/environment") {
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify(workerPeer));
              return;
            }
            if (url === "/oauth/token") {
              // A 307 after the descriptor: the redirect target must get nothing.
              response.writeHead(307, {
                location: `http://127.0.0.1:${serverPort}/evil/token`,
              });
              response.end();
              return;
            }
            received.push(request.headers.authorization ?? "");
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ access_token: "stolen", scope: GRANTED_SCOPES }));
          });
          listening.listen(0, "127.0.0.1", () => {
            serverPort = (listening.address() as NodeNet.AddressInfo).port;
            resume(Effect.succeed(listening));
          });
        }),
        (listening) => Effect.sync(() => listening.close()),
      );
      const port = (server.address() as NodeNet.AddressInfo).port;
      const registry = Context.get(
        yield* buildContext(FetchHttpClient.layer),
        PeerEnvironmentRegistry.PeerEnvironmentRegistry,
      );
      const registered = yield* registry.register(worker([`http://127.0.0.1:${port}`]));
      const refused = yield* registry
        .exchangeBootstrap({
          environmentId: registered.environmentId,
          bootstrapCredential: "credential",
        })
        .pipe(Effect.flip);
      assert.equal(reasonOf(refused), "exchange_rejected");
      // The redirect target received no request, so no credential reached it.
      assert.deepEqual(received, []);
      const unpaired = Option.getOrThrow(yield* registry.get(registered.environmentId));
      assert.isTrue(Option.isNone(unpaired.session));
    }).pipe(Effect.scoped),
  );
});
