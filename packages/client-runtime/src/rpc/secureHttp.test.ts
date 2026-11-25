import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { SecureChannelError } from "@t3tools/shared/secureChannel";
import { makeSecureHttpExchange } from "@t3tools/shared/secureHttp";
import * as Aead from "effect/crypto/Aead";
import * as Digest from "effect/crypto/Digest";
import * as Kdf from "effect/crypto/Kdf";
import * as KeyAgreement from "effect/crypto/KeyAgreement";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as Persistence from "../platform/persistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "./http.ts";
import {
  isSecureHttpKeyRejection,
  makeSecureHttpSealer,
  sealedEnvironmentHttpClient,
} from "./secureHttp.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ORIGIN = "https://environment.example.test";

const crypto = Layer.mergeAll(
  Aead.layerWebCrypto,
  Digest.layerWebCrypto,
  Kdf.layerWebCrypto,
  KeyAgreement.layerWebCrypto,
  Signature.layerWebCrypto,
).pipe(Layer.provideMerge(SecureRandom.layerWebCrypto));

const makeIdentity = Effect.gen(function* () {
  const signature = yield* Signature.Signature;
  const pair = yield* Effect.orDie(signature.generateKeyPair(Signature.ed25519));
  return {
    publicKey: yield* Effect.orDie(Signature.toBytes(pair.publicKey)),
    sign: (message: Uint8Array) =>
      signature
        .sign(pair.privateKey, message)
        .pipe(
          Effect.mapError((cause) => new SecureChannelError({ reason: "crypto_failure", cause })),
        ),
  };
});

/** An environment as an HTTP client that answers each sealed request with what it received. */
const makeEnvironment = Effect.fnUntraced(function* (options?: { readonly refuseAll?: boolean }) {
  const context = yield* Effect.context<
    Aead.Aead | Digest.Digest | Kdf.Kdf | KeyAgreement.KeyAgreement | SecureRandom.SecureRandom
  >();
  const identity = yield* makeIdentity;
  let starts = 0;
  const startExchange = Effect.suspend(() =>
    makeSecureHttpExchange({
      environmentId: ENVIRONMENT_ID,
      identity,
      issuedAt: `start-${++starts}`,
    }),
  );
  let exchange = yield* startExchange;
  const calls: Array<{
    readonly method: string;
    readonly path: string;
    readonly body: Uint8Array;
  }> = [];
  const inner: Array<{ readonly url: string; readonly headers: Record<string, string> }> = [];
  const respond = (request: HttpClientRequest.HttpClientRequest, response: Response) =>
    HttpClientResponse.fromWeb(request, response);
  const base = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const body = request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(0);
      calls.push({ method: request.method, path: url.pathname, body });
      if (url.pathname === "/api/secure/key") return respond(request, Response.json(exchange.key));
      const opened = yield* Effect.result(exchange.open(body));
      if (options?.refuseAll || opened._tag === "Failure") {
        return respond(request, Response.json({ error: "secure_key_unknown" }, { status: 409 }));
      }
      inner.push({
        url: opened.success.request.url,
        headers: { ...opened.success.request.headers },
      });
      const sealed = yield* opened.success.seal({
        status: 201,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode(
          JSON.stringify({ echoed: new TextDecoder().decode(opened.success.request.body) }),
        ),
      });
      return respond(request, new Response(sealed as BodyInit, { status: 200 }));
    }).pipe(Effect.orDie),
  );
  return {
    identity,
    calls,
    inner,
    base,
    restart: startExchange.pipe(
      Effect.map((next) => {
        exchange = next;
      }),
      Effect.provideContext(context),
    ),
  };
});

const makeClient = Effect.fnUntraced(function* (
  environment: Effect.Success<ReturnType<typeof makeEnvironment>>,
  pinnedKey = environment.identity.publicKey,
) {
  const seal = makeSecureHttpSealer(
    yield* Effect.context<
      Aead.Aead | Digest.Digest | Kdf.Kdf | KeyAgreement.KeyAgreement | SecureRandom.SecureRandom
    >(),
  );
  return seal(environment.base, { environmentId: ENVIRONMENT_ID, pinnedKey });
});

const post = (client: HttpClient.HttpClient) =>
  client
    .execute(
      HttpClientRequest.post(`${ORIGIN}/api/auth/websocket-ticket/rpc`).pipe(
        HttpClientRequest.setHeader("authorization", "DPoP secret-token"),
        HttpClientRequest.bodyText('{"secret":"payload"}', "application/json"),
      ),
    )
    .pipe(Effect.flatMap((response) => Effect.map(response.json, (json) => ({ response, json }))));

const viaEnvironmentRequest = <A, E>(request: Effect.Effect<A, E>) =>
  RpcHttp.executeEnvironmentHttpRequest(`${ORIGIN}/api/auth/websocket-ticket/rpc`, 10_000, request);

const includes = (haystack: Uint8Array, needle: string) =>
  new TextDecoder("latin1").decode(haystack).includes(needle);

describe("secure HTTP sealing", () => {
  it.effect("sends the whole request sealed and opens the response", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();
      const { response, json } = yield* post(yield* makeClient(environment));
      assert.strictEqual(response.status, 201);
      assert.deepStrictEqual(json, { echoed: '{"secret":"payload"}' });
      assert.deepStrictEqual(
        environment.calls.map((call) => `${call.method} ${call.path}`),
        ["GET /api/secure/key", "POST /api/secure"],
      );
      const envelope = environment.calls[1]!.body;
      assert.isFalse(includes(envelope, "secret-token"));
      assert.isFalse(includes(envelope, "payload"));
      assert.isFalse(includes(envelope, "websocket-ticket"));
      assert.strictEqual(environment.inner[0]!.url, `${ORIGIN}/api/auth/websocket-ticket/rpc`);
      assert.strictEqual(environment.inner[0]!.headers.authorization, "DPoP secret-token");
      assert.strictEqual(environment.inner[0]!.headers["content-type"], "application/json");
    }).pipe(Effect.provide(crypto)),
  );

  it.effect("reuses the verified key and the ephemeral key pair across requests", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();
      const client = yield* makeClient(environment);
      yield* post(client);
      yield* post(client);
      yield* post(client);
      const posts = environment.calls.filter((call) => call.method === "POST");
      assert.strictEqual(environment.calls.length - posts.length, 1);
      const ephemeralKeys = new Set(posts.map((call) => call.body.subarray(8, 73).join(",")));
      const salts = new Set(posts.map((call) => call.body.subarray(73, 89).join(",")));
      assert.strictEqual(ephemeralKeys.size, 1);
      assert.strictEqual(salts.size, 3);
    }).pipe(Effect.provide(crypto)),
  );

  it.effect("refetches a restarted environment's key and retries the request once", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();
      const client = yield* makeClient(environment);
      yield* post(client);
      yield* environment.restart;
      const { response } = yield* post(client);
      assert.strictEqual(response.status, 201);
      assert.deepStrictEqual(
        environment.calls.map((call) => `${call.method} ${call.path}`),
        [
          "GET /api/secure/key",
          "POST /api/secure",
          "POST /api/secure",
          "GET /api/secure/key",
          "POST /api/secure",
        ],
      );
    }).pipe(Effect.provide(crypto)),
  );

  it.effect("refuses an exchange key the pinned identity did not sign and sends nothing", () =>
    Effect.gen(function* () {
      const environment = yield* makeEnvironment();
      const stranger = yield* makeIdentity;
      const error = yield* Effect.flip(
        viaEnvironmentRequest(post(yield* makeClient(environment, stranger.publicKey))),
      );
      // Reported like a changed key on the secure socket, so Trust new identity stays reachable.
      assert.isTrue(isSecureHttpKeyRejection(error));
      assert.deepStrictEqual(
        environment.calls.map((call) => call.method),
        ["GET"],
      );
    }).pipe(Effect.provide(crypto)),
  );
});

describe("sealedEnvironmentHttpClient", () => {
  const sealing = ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof: () => Effect.succeed("proof"),
    sealHttpClient: (client) => client,
  });
  const registrations = (
    environmentKey: Persistence.ConnectionRegistrationStore["Service"]["environmentKey"],
  ) =>
    Layer.build(Layer.mock(Persistence.ConnectionRegistrationStore)({ environmentKey })).pipe(
      Effect.map((context) => Context.get(context, Persistence.ConnectionRegistrationStore)),
    );
  const run = (input: Parameters<typeof sealedEnvironmentHttpClient>[1]) =>
    sealedEnvironmentHttpClient(ENVIRONMENT_ID, input).pipe(
      Effect.provide(RpcHttp.layerRemoteHttpClient(globalThis.fetch)),
    );

  it.effect("leaves an environment without a pin, or a platform that cannot seal, untouched", () =>
    Effect.gen(function* () {
      const unpinned = yield* registrations(() => Effect.succeedNone);
      const pinned = yield* registrations(() => Effect.succeedSome(new Uint8Array(32)));
      assert.isTrue(
        Option.isNone(
          yield* run({ signer: Option.some(sealing), registrations: Option.some(unpinned) }),
        ),
      );
      const { sealHttpClient: _, ...plain } = sealing;
      assert.isTrue(
        Option.isNone(
          yield* run({
            signer: Option.some(ManagedRelay.ManagedRelayDpopSigner.of(plain)),
            registrations: Option.some(pinned),
          }),
        ),
      );
      assert.isTrue(
        Option.isSome(
          yield* run({ signer: Option.some(sealing), registrations: Option.some(pinned) }),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("fails when the pin cannot be read instead of sending plaintext", () =>
    Effect.gen(function* () {
      const unreadable = yield* registrations(() =>
        Effect.fail(
          new Persistence.ConnectionPersistenceError({
            operation: "load-environment-key",
            message: "locked",
          }),
        ),
      );
      const exit = yield* Effect.exit(
        run({ signer: Option.some(sealing), registrations: Option.some(unreadable) }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }).pipe(Effect.scoped),
  );
});
