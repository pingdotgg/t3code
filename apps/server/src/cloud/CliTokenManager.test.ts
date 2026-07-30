import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { encodeConnectAuthCode } from "@t3tools/shared/connectAuth";

import { outOfBandOAuthLogin } from "./CliTokenManager.ts";

const idToken = (claims: Readonly<Record<string, string>>) =>
  `header.${Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}.signature`;

it.effect("exchanges a validated out-of-band code and returns account identity", () =>
  Effect.gen(function* () {
    let authorizeUrl = "";
    const authorization = yield* outOfBandOAuthLogin(({ authorizeUrl: url }) => {
      authorizeUrl = url;
      const state = new URLSearchParams(new URL(url).hash.slice(1)).get("state");
      if (state === null) {
        return Effect.die("authorization URL omitted state");
      }
      return Effect.succeed(
        encodeConnectAuthCode({
          code: "authorization-code",
          state,
        }),
      );
    });

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
