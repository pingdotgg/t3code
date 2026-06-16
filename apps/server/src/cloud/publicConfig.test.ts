import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";

import {
  makeCloudCliOAuthConfig,
  makeRelayUrlConfig,
  resolveRelayClientTracingConfig,
} from "./publicConfig.ts";

const provideEnv = (env: Readonly<Record<string, string>>) =>
  Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })));

it.effect("uses the statically injected relay URL when no runtime override exists", () =>
  Effect.gen(function* () {
    const relayUrl = yield* makeRelayUrlConfig("https://embedded.example.test///").pipe(
      provideEnv({}),
    );

    assert.equal(relayUrl, "https://embedded.example.test");
  }),
);

it.effect("prefers a runtime relay URL override over the statically injected value", () =>
  Effect.gen(function* () {
    const relayUrl = yield* makeRelayUrlConfig("https://embedded.example.test").pipe(
      provideEnv({ T3CODE_RELAY_URL: "https://runtime.example.test///" }),
    );

    assert.equal(relayUrl, "https://runtime.example.test");
  }),
);

it.effect("requires a relay URL when the server bundle has no injected value", () =>
  makeRelayUrlConfig("").pipe(provideEnv({}), Effect.flip),
);

it.effect("rejects an insecure runtime relay URL override", () =>
  makeRelayUrlConfig("https://embedded.example.test").pipe(
    provideEnv({ T3CODE_RELAY_URL: "http://runtime.example.test" }),
    Effect.flip,
  ),
);

it.effect("rejects an injected relay URL with a non-origin path", () =>
  makeRelayUrlConfig("https://embedded.example.test/path").pipe(provideEnv({}), Effect.flip),
);

it.effect("derives direct Clerk OAuth endpoints from statically injected public config", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(provideEnv({}));

    assert.deepEqual(config, {
      authorizationEndpoint: "https://clerk.example.test/oauth/authorize",
      tokenEndpoint: "https://clerk.example.test/oauth/token",
      clientId: "oauth_client_embedded",
      redirectUri: "http://127.0.0.1:34338/callback",
      scopes: ["openid", "profile", "email"],
    });
  }),
);

it.effect("prefers runtime Clerk OAuth config overrides over statically injected values", () =>
  Effect.gen(function* () {
    const config = yield* makeCloudCliOAuthConfig({
      clerkPublishableKeyFallback: "pk_test_ZW1iZWRkZWQuZXhhbXBsZS50ZXN0JA==",
      clerkCliOAuthClientIdFallback: "oauth_client_embedded",
    }).pipe(
      provideEnv({
        T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_cnVudGltZS5leGFtcGxlLnRlc3Qk",
        T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_runtime",
      }),
    );

    assert.equal(config.authorizationEndpoint, "https://runtime.example.test/oauth/authorize");
    assert.equal(config.tokenEndpoint, "https://runtime.example.test/oauth/token");
    assert.equal(config.clientId, "oauth_client_runtime");
  }),
);

it.effect("requires Clerk OAuth config when the server bundle has no injected values", () =>
  makeCloudCliOAuthConfig({
    clerkPublishableKeyFallback: "",
    clerkCliOAuthClientIdFallback: "",
  }).pipe(provideEnv({}), Effect.flip),
);

it("resolves relay client tracing from runtime config with build-time fallback", () => {
  const fallback = {
    tracesUrl: "https://embedded.example.test/v1/traces",
    tracesDataset: "embedded-dataset",
    tracesToken: "embedded-token",
  };

  assert.deepEqual(resolveRelayClientTracingConfig({}, fallback), fallback);
  assert.deepEqual(
    resolveRelayClientTracingConfig(
      {
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://runtime.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    {
      tracesUrl: "https://runtime.example.test/v1/traces",
      tracesDataset: "runtime-dataset",
      tracesToken: "runtime-token",
    },
  );
  assert.equal(
    resolveRelayClientTracingConfig(
      {
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "http://insecure.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "runtime-dataset",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "runtime-token",
      },
      fallback,
    ),
    null,
  );
});
