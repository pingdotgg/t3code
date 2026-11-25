import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  EnvironmentId,
} from "@t3tools/contracts";
import { SecureChannelError } from "@t3tools/shared/secureChannel";
import {
  makeSecureHttpClientSession,
  SECURE_HTTP_KEY_PATH,
  SECURE_HTTP_PATH,
  SecureHttpKey,
  verifySecureHttpKey,
} from "@t3tools/shared/secureHttp";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { EnvironmentSigningKey } from "../cloud/environmentKeys.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { makeDpopKey } from "./dpop.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as SecureHttp from "./secureHttp.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
const ENVIRONMENT_ID = EnvironmentId.make("environment-secure-http-test");
const ORIGIN = "http://127.0.0.1";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-secure-http-test-" })));

const layerCrypto = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

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

const makeRoutes = (identity: Effect.Success<typeof makeIdentity>) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    SecureHttp.layer,
  ).pipe(
    Layer.provide(
      Layer.succeed(
        EnvironmentSigningKey,
        EnvironmentSigningKey.of({
          publicKey: "",
          sign: () => Effect.die("Not used by these routes."),
          secureChannelIdentity: Effect.succeed(identity),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
        getDescriptor: Effect.die("Not used by these routes."),
      }),
    ),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provide(ManagedPolicy.layerTest()),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
      ),
    ),
    Layer.provide(layerConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(Layer.provideMerge(layerCrypto), Layer.provideMerge(Etag.layerWeak)),
    ),
    Layer.provide(layerCrypto),
  );

const decodeKey = Schema.decodeUnknownSync(SecureHttpKey);

// The web handler runs on its own runtime, so proofs need wall-clock time.
it.live("runs a sealed DPoP request through the real routes and refuses its replay", () =>
  Effect.gen(function* () {
    const identity = yield* makeIdentity;
    const secrets = yield* ServerSecretStore.ServerSecretStore.pipe(
      Effect.provide(ServerSecretStore.layer.pipe(Layer.provide(layerConfig))),
    );
    const requestContext = Context.make(
      SecureRandom.SecureRandom,
      yield* SecureRandom.SecureRandom,
    ).pipe(Context.add(ServerSecretStore.ServerSecretStore, secrets));
    const key = makeDpopKey();
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    const ticketUrl = `${ORIGIN}/api/auth/websocket-ticket/rpc`;

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(makeRoutes(identity), { disableLogger: true })),
      (environment) =>
        Effect.gen(function* () {
          const send = (request: Request) =>
            Effect.promise(() => environment.handler(request, requestContext));
          const issued = yield* send(
            new Request(`${ORIGIN}/oauth/token`, {
              method: "POST",
              headers: {
                host: "127.0.0.1",
                dpop: key.sign({ method: "POST", url: `${ORIGIN}/oauth/token`, token: "", iat }),
              },
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
              }),
            }),
          );
          expect(issued.status).toBe(200);
          const accessToken = ((yield* Effect.promise(() => issued.json())) as never)[
            "access_token"
          ] as string;

          const keyResponse = yield* send(new Request(`${ORIGIN}${SECURE_HTTP_KEY_PATH}`));
          const exchangeKey = verifySecureHttpKey({
            pinned: identity.publicKey,
            environmentId: ENVIRONMENT_ID,
            key: decodeKey(yield* Effect.promise(() => keyResponse.json())),
          });
          expect(exchangeKey).toBeDefined();
          const session = yield* makeSecureHttpClientSession(exchangeKey!);
          const ticketHeaders = (claims: Readonly<Record<string, unknown>>) => ({
            authorization: `DPoP ${accessToken}`,
            dpop: key.sign({ method: "POST", url: ticketUrl, token: accessToken, iat, claims }),
          });
          const sealed = yield* session.seal({
            method: "POST",
            url: ticketUrl,
            headers: ticketHeaders({ t3sc: true }),
            body: new Uint8Array(0),
          });
          const sendSealed = (envelope: Uint8Array) =>
            send(new Request(`${ORIGIN}${SECURE_HTTP_PATH}`, { method: "POST", body: envelope }));

          const answer = yield* sendSealed(sealed.envelope);
          expect(answer.status).toBe(200);
          const ticket = yield* sealed.open(
            new Uint8Array(yield* Effect.promise(() => answer.arrayBuffer())),
          );
          expect(ticket.status).toBe(200);
          expect(ticket.headers["content-type"]).toContain("application/json");
          expect(JSON.parse(new TextDecoder().decode(ticket.body))).toHaveProperty("ticket");

          const replayed = yield* sendSealed(sealed.envelope);
          expect(replayed.status).toBe(200);
          const refused = yield* sealed.open(
            new Uint8Array(yield* Effect.promise(() => replayed.arrayBuffer())),
          );
          expect(refused.status).toBe(401);
          expect(refused.headers["www-authenticate"]).toBe("DPoP");

          // The same kind of proof sent in plaintext is refused before its jti is spent.
          const plaintext = yield* send(
            new Request(ticketUrl, {
              method: "POST",
              headers: { host: "127.0.0.1", ...ticketHeaders({ t3sc: true }) },
            }),
          );
          expect(plaintext.status).toBe(401);
          const unsealedProof = yield* send(
            new Request(ticketUrl, {
              method: "POST",
              headers: { host: "127.0.0.1", ...ticketHeaders({}) },
            }),
          );
          expect(unsealedProof.status).toBe(200);

          // An envelope for an exchange key this environment never had (as after a restart).
          const other = yield* makeSecureHttpClientSession(
            verifySecureHttpKey({
              pinned: identity.publicKey,
              environmentId: ENVIRONMENT_ID,
              key: decodeKey(
                yield* Effect.promise(async () => {
                  const restarted = HttpRouter.toWebHandler(makeRoutes(identity), {
                    disableLogger: true,
                  });
                  try {
                    const response = await restarted.handler(
                      new Request(`${ORIGIN}${SECURE_HTTP_KEY_PATH}`),
                      requestContext,
                    );
                    return await response.json();
                  } finally {
                    await restarted.dispose();
                  }
                }),
              ),
            })!,
          );
          const stale = yield* sendSealed(
            (yield* other.seal({
              method: "POST",
              url: ticketUrl,
              headers: ticketHeaders({ t3sc: true }),
              body: new Uint8Array(0),
            })).envelope,
          );
          expect(stale.status).toBe(409);
          expect(yield* Effect.promise(() => stale.json())).toEqual({
            error: "secure_key_unknown",
          });
        }),
      (environment) => Effect.promise(() => environment.dispose()),
    );
  }).pipe(Effect.provide(layerCrypto)),
);
