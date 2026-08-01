import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { encodeConnectAuthCode } from "@t3tools/shared/connectAuth";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const idToken = (claims: Readonly<Record<string, string>>) =>
  `header.${Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}.signature`;

function memorySecretStore() {
  const values = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        const value = values.get(name);
        return value === undefined ? Option.none() : Option.some(value);
      }),
    set: (name, value) =>
      Effect.sync(() => {
        values.set(name, value);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
    list: () => Effect.succeed([...values.keys()]),
  });
}

it.effect(
  "accepts only a state-bound loopback callback and persists its exchanged credential",
  () =>
    Effect.gen(function* () {
      const secretStore = memorySecretStore();
      const layer = CliTokenManager.layer.pipe(
        Layer.provideMerge(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
        Layer.provideMerge(NodeServices.layer),
      );
      const state = "loopback-state";
      const run = CliTokenManager.withLoopbackAuthorizationCallback(
        {
          redirectUri: "http://127.0.0.1:34338/callback",
          state,
        },
        ({ awaitCode }) =>
          Effect.gen(function* () {
            const invalid = yield* Effect.promise(() =>
              fetch("http://127.0.0.1:34338/callback?code=invalid&state=wrong-state"),
            );
            assert.equal(invalid.status, 400);

            const valid = yield* Effect.promise(() =>
              fetch("http://127.0.0.1:34338/callback?code=loopback-code&state=loopback-state"),
            );
            assert.equal(valid.status, 200);
            const token = yield* CliTokenManager.exchangeOAuthToken(
              {
                authorizationEndpoint: "https://clerk.example.test/oauth/authorize",
                tokenEndpoint: "https://clerk.example.test/oauth/token",
                clientId: "oauth-client",
                redirectUri: "http://127.0.0.1:34338/callback",
                scopes: ["openid", "profile", "email"],
              },
              {
                grant_type: "authorization_code",
                code: yield* awaitCode,
                redirect_uri: "http://127.0.0.1:34338/callback",
                client_id: "oauth-client",
                code_verifier: "verifier",
              },
            );
            const tokens = yield* CliTokenManager.CloudCliTokenManager;
            yield* tokens.store(token.token);
          }),
      );

      yield* run.pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  access_token: "loopback-access-token",
                  refresh_token: "loopback-refresh-token",
                  expires_in: 3600,
                  token_type: "Bearer",
                }),
              ),
            ),
          ),
        ),
        Effect.provide(layer),
      );

      const stored = yield* Effect.gen(function* () {
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        return yield* tokens.getExisting;
      }).pipe(Effect.provide(layer));
      assert.equal(Option.getOrThrow(stored).refreshToken, "loopback-refresh-token");
    }),
);

it.effect("persists a local-browser credential across token-manager restarts", () =>
  Effect.gen(function* () {
    const secretStore = memorySecretStore();
    const layer = CliTokenManager.layer.pipe(
      Layer.provideMerge(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      yield* tokens.store({
        accessToken: "opaque-access-token",
        refreshToken: "opaque-refresh-token",
        expiresAtEpochMs: Date.now() + 60 * 60 * 1_000,
      });
    }).pipe(Effect.provide(layer));

    const restored = yield* Effect.gen(function* () {
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      return yield* tokens.getExisting;
    }).pipe(Effect.provide(layer));

    assert.equal(Option.getOrThrow(restored).refreshToken, "opaque-refresh-token");
  }),
);

it.effect("surfaces a revoked refresh credential so Connect can reauthorize", () =>
  Effect.gen(function* () {
    const secretStore = memorySecretStore();
    const layer = CliTokenManager.layer.pipe(
      Layer.provideMerge(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
      Layer.provideMerge(NodeServices.layer),
    );
    const config = ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth-client",
        },
      }),
    );

    yield* Effect.gen(function* () {
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      yield* tokens.store({
        accessToken: "expired-access-token",
        refreshToken: "revoked-refresh-token",
        expiresAtEpochMs: 0,
      });
    }).pipe(Effect.provide(layer));

    const error = yield* Effect.gen(function* () {
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      return yield* tokens.getExisting.pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          config,
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
              ),
            ),
          ),
        ),
      ),
    );
    assert.equal(error._tag, "CloudCliCredentialRefreshError");
  }),
);

it.effect("exchanges a validated out-of-band code and returns account identity", () =>
  Effect.gen(function* () {
    let authorizeUrl = "";
    const authorization = yield* CliTokenManager.outOfBandOAuthLogin(
      ({ authorizeUrl: url, validate }) => {
        authorizeUrl = url;
        const state = new URLSearchParams(new URL(url).hash.slice(1)).get("state");
        if (state === null) {
          return Effect.die("authorization URL omitted state");
        }
        return Effect.gen(function* () {
          assert.equal((yield* validate("malformed-code").pipe(Effect.result))._tag, "Failure");
          return yield* validate(
            encodeConnectAuthCode({
              code: "authorization-code",
              state,
            }),
          );
        });
      },
    );

    assert.include(authorizeUrl, "https://hosted.example.test/connect");
    assert.equal(authorization.identity, "user@example.test");
    assert.equal(authorization.token.accessToken, "access-token");
    assert.equal(authorization.token.refreshToken, "refresh-token");
    assert.equal(authorization.token.identity, "user@example.test");
  }).pipe(
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: {
            T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
            T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth-client",
            T3CODE_HOSTED_APP_URL: "https://hosted.example.test",
          },
        }),
      ),
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "access-token",
              refresh_token: "refresh-token",
              id_token: idToken({ email: "user@example.test" }),
              expires_in: 3600,
              token_type: "Bearer",
            }),
          ),
        ),
      ),
    ),
    Effect.provide(NodeServices.layer),
  ),
);
