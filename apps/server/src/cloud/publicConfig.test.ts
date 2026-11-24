import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import { hostedAppUrlConfig, makeCloudCliOAuthConfig, makeRelayUrlConfig } from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("rejects malformed or insecure hosted app URLs", () =>
  Effect.gen(function* () {
    for (const value of [
      "app.t3.codes",
      "http://app.t3.codes",
      "https://app.t3.codes/nested",
      "https://app.t3.codes?alias=true",
    ]) {
      const result = yield* hostedAppUrlConfig.pipe(
        provideEnv({ T3CODE_HOSTED_APP_URL: value }),
        Effect.result,
      );
      assert.isTrue(Result.isFailure(result), value);
    }
  }),
);

it.effect("derives direct Clerk OAuth endpoints from statically injected public config", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      tokenEndpoint: "https://clerk.example.test/oauth/token",
      deviceAuthorizationEndpoint: "https://clerk.example.test/oauth/device_authorization",
      clientId: "oauth_client_embedded",
      loopbackPort: 34338,
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
  }),
);
