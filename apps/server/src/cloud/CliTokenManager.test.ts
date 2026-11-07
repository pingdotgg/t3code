import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const TEST_ENV = {
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
  T3CODE_HOSTED_APP_URL: "https://hosted.example.test",
};

interface RecordedTokenRequest {
  readonly url: string;
  readonly params: URLSearchParams;
}

const TestIdTokenHeaderJson = Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal("none") }));
const TestIdTokenPayloadJson = Schema.fromJsonString(Schema.Struct({ email: Schema.String }));
const encodeTestIdTokenHeader = Schema.encodeSync(TestIdTokenHeaderJson);
const encodeTestIdTokenPayload = Schema.encodeSync(TestIdTokenPayloadJson);
const idTokenWithEmail = (() => {
  const header = Base64Url.encode(encodeTestIdTokenHeader({ alg: "none" }));
  const payload = Base64Url.encode(encodeTestIdTokenPayload({ email: "theo@example.test" }));
  return `${header}.${payload}.`;
})();

const TestTokenResponseJson = Schema.fromJsonString(
  Schema.Struct({
    access_token: Schema.String,
    refresh_token: Schema.String,
    id_token: Schema.String,
    expires_in: Schema.Number,
    token_type: Schema.String,
  }),
);
const encodeTestTokenResponse = Schema.encodeSync(TestTokenResponseJson);

const provideTestEnv = Effect.provide(
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: TEST_ENV })),
);

interface DeviceFlowServer {
  readonly requests: Array<RecordedTokenRequest>;
  readonly tokenReplies: Array<{ readonly status: number; readonly body: string }>;
}

const DEVICE_AUTHORIZATION_BODY = JSON.stringify({
  device_code: "device-code-1",
  user_code: "BCDF-GHJK",
  verification_uri: "https://accounts.example.test/device",
  verification_uri_complete: "https://accounts.example.test/device?user_code=BCDF-GHJK",
  expires_in: 600,
  interval: 5,
});

const oauthError = (error: string) => ({ status: 400, body: JSON.stringify({ error }) });
const tokenGranted = {
  status: 200,
  body: encodeTestTokenResponse({
    access_token: "access-token-1",
    refresh_token: "refresh-token-1",
    id_token: idTokenWithEmail,
    expires_in: 3600,
    token_type: "bearer",
  }),
};

const layerDeviceFlow = (server: DeviceFlowServer) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        server.requests.push({ url: request.url, params: new URLSearchParams(body) });
        const reply = request.url.endsWith("/oauth/device_authorization")
          ? { status: 200, body: DEVICE_AUTHORIZATION_BODY }
          : ((server.tokenReplies.length > 1
              ? server.tokenReplies.shift()
              : server.tokenReplies[0]) ?? oauthError("invalid_grant"));
        return HttpClientResponse.fromWeb(
          request,
          new Response(reply.body, {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const tokenRequests = (requests: ReadonlyArray<RecordedTokenRequest>) =>
  requests.filter((request) => request.url.endsWith("/oauth/token"));

const expiredStoredToken = new TextEncoder().encode(
  JSON.stringify({ accessToken: "expired", refreshToken: "refresh-token-1", expiresAtEpochMs: 0 }),
);

const provideRefreshManager = (
  httpClient: HttpClient.HttpClient,
  secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () => Effect.succeedSome(expiredStoredToken),
  }),
  env: Readonly<Record<string, string>> = TEST_ENV,
) =>
  Effect.provide(
    CliTokenManager.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, httpClient),
          secrets,
          Layer.mock(ExternalLauncher.ExternalLauncher)({}),
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
      Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    ),
  );

it.effect(
  "persists rotated credentials under the lock despite shutdown, while queued callers can cancel",
  () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const persistStarted = yield* Deferred.make<void>();
      const releasePersist = yield* Deferred.make<void>();
      let stored = expiredStoredToken;
      let reads = 0;
      const httpClient = HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(requestStarted, undefined);
          yield* Deferred.await(releaseRequest);
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 3600,
              token_type: "bearer",
            }),
          );
        }),
      );
      const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
        get: () =>
          Effect.sync(() => {
            reads++;
            return Option.some(stored);
          }),
        set: (_name, value) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(persistStarted, undefined);
            yield* Deferred.await(releasePersist);
            stored = new Uint8Array(value);
          }),
      });

      yield* Effect.gen(function* () {
        const manager = yield* CliTokenManager.CloudCliTokenManager;
        const refresh = yield* manager.getExisting.pipe(Effect.forkChild);
        assert.isTrue(
          yield* Effect.raceFirst(
            Deferred.await(requestStarted).pipe(Effect.as(true)),
            Fiber.await(refresh).pipe(Effect.as(false)),
          ),
          "refresh failed before reaching the endpoint",
        );
        const waiter = yield* manager.getExisting.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(waiter);
        assert.equal(reads, 1, "queued caller must not read credentials during refresh");
        const interruption = yield* Fiber.interrupt(refresh).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Deferred.succeed(releaseRequest, undefined);
        const reachedPersist = yield* Effect.raceFirst(
          Deferred.await(persistStarted).pipe(Effect.as(true)),
          Fiber.await(refresh).pipe(Effect.as(false)),
        );
        assert.isTrue(reachedPersist, "shutdown discarded the rotated credential");
        const reader = yield* manager.getExisting.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        assert.equal(reads, 1, "credential lock must cover persistence");
        yield* Deferred.succeed(releasePersist, undefined);
        yield* Fiber.join(interruption);
        const token = Option.getOrThrow(yield* Fiber.join(reader));
        assert.equal(token.refreshToken, "rotated-refresh");
        assert.equal(token.accessToken, "rotated-access");
      }).pipe(
        Effect.ensuring(Deferred.succeed(releaseRequest, undefined)),
        Effect.ensuring(Deferred.succeed(releasePersist, undefined)),
        provideRefreshManager(httpClient, secrets),
      );
    }),
);

it.effect.each([
  { status: 400, code: "invalid_grant", requiresLogin: true, diagnostic: true },
  { status: 403, code: "private-provider-secret", requiresLogin: true, diagnostic: false },
  { status: 429, code: "invalid_grant", requiresLogin: false, diagnostic: false },
])(
  "refresh HTTP $status exposes only a safe login diagnostic",
  ({ status, code, requiresLogin, diagnostic }) =>
    Effect.gen(function* () {
      const manager = yield* CliTokenManager.CloudCliTokenManager;
      const error = yield* manager.getExisting.pipe(Effect.flip);
      assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
      assert.equal(error.requiresLogin, requiresLogin);
      assert.equal(error.message.includes("t3 connect login"), requiresLogin);
      assert.equal(error.message.includes("OAuth error: invalid_grant"), diagnostic);
      assert.notInclude(error.message, "private");
      assert.equal(error.message.includes("OAuth error:"), diagnostic);
      assert.isTrue(yield* manager.hasCredential);
    }).pipe(
      provideRefreshManager(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                {
                  error: code,
                  error_description: "private-description",
                  refresh_token: "private-refresh-token",
                },
                { status },
              ),
            ),
          ),
        ),
      ),
    ),
);

const OIDC_ISSUER = "https://sso.example.test/realms/t3";
const OIDC_ENV = { T3CODE_OIDC_ISSUER: OIDC_ISSUER, T3CODE_OIDC_CLIENT_ID: "t3-code" };

const OidcClaimsJson = Schema.fromJsonString(
  Schema.Struct({
    sub: Schema.String,
    iss: Schema.String,
    exp: Schema.Number,
    email: Schema.String,
  }),
);
const encodeOidcClaims = Schema.encodeSync(OidcClaimsJson);
const oidcIdToken = (exp: number) =>
  `${Base64Url.encode(encodeTestIdTokenHeader({ alg: "none" }))}.${Base64Url.encode(
    encodeOidcClaims({ sub: "alice", iss: OIDC_ISSUER, exp, email: "theo@example.test" }),
  )}.`;

const oidcProvider = (input: {
  readonly deviceAuthorizationEndpoint?: string;
  readonly tokenResponse: Readonly<Record<string, unknown>>;
  readonly requests: Array<RecordedTokenRequest>;
}) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      input.requests.push({ url: request.url, params: new URLSearchParams(body) });
      return HttpClientResponse.fromWeb(
        request,
        request.url.endsWith("/.well-known/openid-configuration")
          ? Response.json({
              issuer: OIDC_ISSUER,
              authorization_endpoint: `${OIDC_ISSUER}/auth`,
              token_endpoint: `${OIDC_ISSUER}/token`,
              ...(input.deviceAuthorizationEndpoint === undefined
                ? {}
                : { device_authorization_endpoint: input.deviceAuthorizationEndpoint }),
            })
          : Response.json(input.tokenResponse),
      );
    }),
  );

it.effect("refreshes against the discovered OIDC token endpoint and keeps the ID token", () => {
  const requests: Array<RecordedTokenRequest> = [];
  const idToken = oidcIdToken(4_000_000_000);
  let stored = expiredStoredToken;
  const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: () => Effect.sync(() => Option.some(stored)),
    set: (_name, value) =>
      Effect.sync(() => {
        stored = new Uint8Array(value);
      }),
  });
  return Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const token = Option.getOrThrow(yield* manager.getExisting);

    // The relay verifies the ID token, so it is the credential, and the provider's lack of
    // refresh token rotation keeps the stored one.
    assert.equal(token.accessToken, idToken);
    assert.equal(token.refreshToken, "refresh-token-1");
    assert.equal(token.expiresAtEpochMs, 4_000_000_000_000);
    assert.equal(token.identity, "theo@example.test");
    const refresh = requests.find((request) => request.url === `${OIDC_ISSUER}/token`);
    assert.equal(refresh?.params.get("grant_type"), "refresh_token");
    assert.equal(refresh?.params.get("client_id"), "t3-code");
  }).pipe(
    provideRefreshManager(
      oidcProvider({
        requests,
        tokenResponse: {
          access_token: "opaque-access-token",
          id_token: idToken,
          expires_in: 300,
          token_type: "bearer",
        },
      }),
      secrets,
      OIDC_ENV,
    ),
  );
});

it.effect("refuses an OIDC token response that carries no ID token", () =>
  Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const error = yield* manager.getExisting.pipe(Effect.flip);
    assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
  }).pipe(
    provideRefreshManager(
      oidcProvider({
        requests: [],
        tokenResponse: { access_token: "opaque", expires_in: 300, token_type: "bearer" },
      }),
      undefined,
      OIDC_ENV,
    ),
  ),
);

it.effect("reports a provider without device authorization instead of calling Clerk", () => {
  const requests: Array<RecordedTokenRequest> = [];
  return CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
    Effect.flip,
    Effect.map((error) =>
      assert.include(String(error.cause), "does not support device authorization"),
    ),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, oidcProvider({ requests, tokenResponse: {} })),
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: OIDC_ENV })),
      ),
    ),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "CliTokenManager.deviceAuthorizationLogin",
  (it) => {
    it.effect("requests a device code, shows it, and polls until Clerk grants the token", () =>
      Effect.gen(function* () {
        const server: DeviceFlowServer = {
          requests: [],
          tokenReplies: [oauthError("authorization_pending"), tokenGranted],
        };
        const prompts: Array<CliTokenManager.DeviceAuthorizationPrompt> = [];

        const fiber = yield* CliTokenManager.deviceAuthorizationLogin((prompt) =>
          Effect.sync(() => {
            prompts.push(prompt);
          }),
        ).pipe(Effect.provide(layerDeviceFlow(server)), provideTestEnv, Effect.forkChild);

        yield* TestClock.adjust(Duration.seconds(10));
        const { token, identity } = yield* Fiber.join(fiber);

        assert.deepEqual(prompts, [
          {
            verificationUri: "https://accounts.example.test/device",
            verificationUriComplete: "https://accounts.example.test/device?user_code=BCDF-GHJK",
            userCode: "BCDF-GHJK",
            expiresIn: Duration.seconds(600),
          },
        ]);
        assert.equal(token.accessToken, "access-token-1");
        assert.equal(token.refreshToken, "refresh-token-1");
        assert.equal(token.identity, "theo@example.test");
        assert.equal(identity, "theo@example.test");

        const authorization = server.requests[0]!;
        assert.equal(authorization.url, "https://clerk.example.test/oauth/device_authorization");
        assert.equal(authorization.params.get("client_id"), "oauth_client_test");
        assert.equal(authorization.params.get("scope"), "openid profile email offline_access");

        const polls = tokenRequests(server.requests);
        assert.lengthOf(polls, 2);
        for (const poll of polls) {
          assert.equal(poll.url, "https://clerk.example.test/oauth/token");
          assert.equal(
            poll.params.get("grant_type"),
            "urn:ietf:params:oauth:grant-type:device_code",
          );
          assert.equal(poll.params.get("device_code"), "device-code-1");
          assert.equal(poll.params.get("client_id"), "oauth_client_test");
        }
      }),
    );

    it.effect("fails with a denied error when the user rejects the request", () =>
      Effect.gen(function* () {
        const server: DeviceFlowServer = {
          requests: [],
          tokenReplies: [oauthError("access_denied")],
        };

        const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
          Effect.provide(layerDeviceFlow(server)),
          provideTestEnv,
          Effect.flip,
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.seconds(5));
        const result = yield* Fiber.join(fiber);

        assert.instanceOf(result, CliTokenManager.CloudCliAuthorizationDeniedError);
        assert.lengthOf(tokenRequests(server.requests), 1);
      }),
    );
  },
);
