import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Terminal from "effect/Terminal";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

// pk_test_<base64 of "clerk.example.test$">
const TEST_ENV = {
  T3CODE_CLERK_PUBLISHABLE_KEY: "pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA==",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_client_test",
  T3CODE_HOSTED_APP_URL: "https://hosted.example.test",
};

interface RecordedTokenRequest {
  readonly url: string;
  readonly params: URLSearchParams;
}

// A JWT whose payload claims { email: "theo@example.test" } (signature is not
// verified — the CLI only reads the claim to display the connected account).
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

const isAuthorizationError = Schema.is(CliTokenManager.CloudCliAuthorizationError);

const makeTestTerminal = (queue: Queue.Queue<Terminal.UserInput>) =>
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.succeed(Queue.asDequeue(queue)),
    readLine: Effect.never,
    display: () => Effect.void,
  });

const userInput = (name: string): Terminal.UserInput => ({
  input: Option.some(name),
  key: { name, ctrl: false, meta: false, shift: name !== name.toLowerCase() },
});

it.effect("opens the browser on Enter and switches the active flow on H", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<Terminal.UserInput>();
    yield* Queue.offerAll(queue, [userInput("enter"), userInput("H")]);
    const opened: Array<string> = [];

    const result = yield* CliTokenManager.waitForLoopbackAuthorization({
      authorizationUrl: "https://clerk.example.test/authorize",
      callback: Effect.never,
      terminal: makeTestTerminal(queue),
      launchBrowser: (url) =>
        Effect.sync(() => {
          opened.push(url);
        }),
    });

    assert.deepEqual(opened, ["https://clerk.example.test/authorize"]);
    assert.deepEqual(result, { _tag: "HeadlessRequested" });
  }),
);

it.effect("finishes normally when the browser callback wins", () =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<Terminal.UserInput>();
    const callback = yield* Deferred.make<string>();
    yield* Deferred.succeed(callback, "clerk-code-123");

    const result = yield* CliTokenManager.waitForLoopbackAuthorization({
      authorizationUrl: "https://clerk.example.test/authorize",
      callback: Deferred.await(callback),
      terminal: makeTestTerminal(queue),
      launchBrowser: () => Effect.die("browser launch should not run"),
    });

    assert.deepEqual(result, { _tag: "AuthorizationCode", code: "clerk-code-123" });
  }),
);

interface DeviceFlowServer {
  readonly requests: Array<RecordedTokenRequest>;
  /** Token endpoint replies, consumed in order; the last one repeats. */
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

const rotatedTokenGranted = {
  status: 200,
  body: encodeTestTokenResponse({
    access_token: "access-token-2",
    refresh_token: "refresh-token-2",
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

// The endpoint sends headers, then the JSON body never finishes.
const layerStalledBody = (status: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    ),
  );

const expiredStoredToken = new TextEncoder().encode(
  JSON.stringify({ accessToken: "expired", refreshToken: "refresh-token-1", expiresAtEpochMs: 0 }),
);

const layerRefreshResponse = (reply: { readonly status: number; readonly body: string }) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(reply.body, {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        ),
      ),
    ),
  );

const layerUnreadableResponseBody = (status: number) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start: (controller) => controller.error(new Error("body read failed")),
            }),
            { status, headers: { "content-type": "application/json" } },
          ),
        ),
      ),
    ),
  );

it.effect("persists a rotated refresh token before parent interruption is delivered", () =>
  Effect.gen(function* () {
    const requestStarted = yield* Deferred.make<void>();
    const releaseRequest = yield* Deferred.make<void>();
    const persistStarted = yield* Deferred.make<Uint8Array>();
    const releasePersist = yield* Deferred.make<void>();
    let persisted: Uint8Array | undefined;

    const httpClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(requestStarted, undefined);
          yield* Deferred.await(releaseRequest);
          return HttpClientResponse.fromWeb(
            request,
            new Response(rotatedTokenGranted.body, {
              status: rotatedTokenGranted.status,
              headers: { "content-type": "application/json" },
            }),
          );
        }),
      ),
    );
    const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
      get: () => Effect.succeedSome(expiredStoredToken),
      set: (_name, value) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(persistStarted, value);
          yield* Deferred.await(releasePersist);
          persisted = value;
        }),
    });
    yield* Effect.gen(function* () {
      const manager = yield* CliTokenManager.CloudCliTokenManager;
      const refresh = yield* manager.getExisting.pipe(Effect.forkChild);

      yield* Deferred.await(requestStarted);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(refresh), {
        startImmediately: true,
      });
      yield* Deferred.succeed(releaseRequest, undefined);
      const persistedBeforeExit = yield* Effect.raceFirst(
        Deferred.await(persistStarted).pipe(Effect.as(true)),
        Fiber.await(refresh).pipe(Effect.as(false)),
      );
      assert.isTrue(persistedBeforeExit, "refresh exited before persistence started");
      yield* Deferred.succeed(releasePersist, undefined);
      yield* Fiber.join(interruption);

      // The queued interruption may be delivered immediately after the
      // uninterruptible refresh transaction completes. Either exit is valid;
      // the important guarantee is that persistence finished first.
      yield* Fiber.await(refresh);
      assert.isDefined(persisted);
      assert.equal(
        JSON.parse(new TextDecoder().decode(persisted!)).refreshToken,
        "refresh-token-2",
      );
    }).pipe(
      Effect.provide(
        CliTokenManager.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              httpClient,
              secrets,
              Layer.mock(ExternalLauncher.ExternalLauncher)({}),
              NodeServices.layer,
            ),
          ),
        ),
      ),
      provideTestEnv,
    );
  }),
);

it.effect.each([
  { status: 400, requiresLogin: true },
  { status: 401, requiresLogin: true },
  { status: 403, requiresLogin: true },
  { status: 408, requiresLogin: false },
  { status: 429, requiresLogin: false },
  { status: 500, requiresLogin: false },
])("marks refresh status $status as requiresLogin=$requiresLogin", ({ status, requiresLogin }) =>
  Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const error = yield* manager.getExisting.pipe(Effect.flip);

    assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
    assert.equal(error.requiresLogin, requiresLogin);
    assert.equal(error.message.includes("t3 connect login"), requiresLogin);
    assert.equal(error.message.includes("OAuth error: invalid_grant"), requiresLogin);
    assert.notInclude(error.message, "private-oauth-diagnostic");
  }).pipe(
    Effect.provide(
      CliTokenManager.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerRefreshResponse({
              status,
              body: JSON.stringify({
                error: "invalid_grant",
                error_description: "private-oauth-diagnostic",
              }),
            }),
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedSome(expiredStoredToken),
            }),
            Layer.mock(ExternalLauncher.ExternalLauncher)({}),
            NodeServices.layer,
          ),
        ),
      ),
    ),
    provideTestEnv,
  ),
);

it.effect("only includes an allowlisted OAuth error code in a login prompt", () =>
  Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const error = yield* manager.getExisting.pipe(Effect.flip);

    assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
    assert.isTrue(error.requiresLogin);
    assert.include(error.message, "t3 connect login");
    assert.notInclude(error.message, "provider_secret");
    assert.notInclude(error.message, "private-oauth-diagnostic");
    assert.notInclude(error.message, "OAuth error:");
  }).pipe(
    Effect.provide(
      CliTokenManager.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerRefreshResponse({
              status: 400,
              body: JSON.stringify({
                error: "provider_secret",
                error_description: "private-oauth-diagnostic",
              }),
            }),
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedSome(expiredStoredToken),
            }),
            Layer.mock(ExternalLauncher.ExternalLauncher)({}),
            NodeServices.layer,
          ),
        ),
      ),
    ),
    provideTestEnv,
  ),
);

it.effect.each([
  {
    name: "malformed",
    layer: layerRefreshResponse({ status: 400, body: "{" }),
    expectedBodyCause: false,
  },
  { name: "unreadable", layer: layerUnreadableResponseBody(400), expectedBodyCause: true },
])("keeps the permanent status for a $name refresh error body", ({ layer, expectedBodyCause }) =>
  Effect.gen(function* () {
    const manager = yield* CliTokenManager.CloudCliTokenManager;
    const error = yield* manager.getExisting.pipe(Effect.flip);

    assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
    assert.isTrue(error.requiresLogin);
    assert.include(error.message, "t3 connect login");
    assert.isTrue(HttpClientError.isHttpClientError(error.cause));
    if (HttpClientError.isHttpClientError(error.cause)) {
      assert.equal(error.cause.reason._tag, "StatusCodeError");
      if (error.cause.reason._tag === "StatusCodeError") {
        assert.equal(error.cause.reason.response.status, 400);
        if (expectedBodyCause) {
          assert.isTrue(HttpClientError.isHttpClientError(error.cause.reason.cause));
          if (HttpClientError.isHttpClientError(error.cause.reason.cause)) {
            assert.equal(error.cause.reason.cause.reason._tag, "DecodeError");
            if (error.cause.reason.cause.reason._tag === "DecodeError") {
              assert.instanceOf(error.cause.reason.cause.reason.cause, Error);
              assert.equal(
                (error.cause.reason.cause.reason.cause as Error).message,
                "body read failed",
              );
            }
          }
        } else {
          assert.isUndefined(error.cause.reason.cause);
        }
      }
    }
  }).pipe(
    Effect.provide(
      CliTokenManager.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layer,
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              get: () => Effect.succeedSome(expiredStoredToken),
            }),
            Layer.mock(ExternalLauncher.ExternalLauncher)({}),
            NodeServices.layer,
          ),
        ),
      ),
    ),
    provideTestEnv,
  ),
);

it.effect.each([200, 400])(
  "a stalled $status token refresh fails and releases the credential lock",
  (status) =>
    Effect.gen(function* () {
      const manager = yield* CliTokenManager.CloudCliTokenManager;
      const refresh = yield* manager.getExisting.pipe(Effect.flip, Effect.forkChild);
      const hasCredential = yield* manager.hasCredential.pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.seconds(10));

      const error = yield* Fiber.join(refresh);
      assert.instanceOf(error, CliTokenManager.CloudCliCredentialRefreshError);
      assert.equal(error.requiresLogin, status === 400);
      assert.equal(error.message.includes("t3 connect login"), status === 400);
      if (status === 400 && HttpClientError.isHttpClientError(error.cause)) {
        assert.equal(error.cause.reason._tag, "StatusCodeError");
        if (error.cause.reason._tag === "StatusCodeError") {
          assert.isTrue(Cause.isTimeoutError(error.cause.reason.cause));
        }
      }
      assert.isTrue(yield* Fiber.join(hasCredential));
    }).pipe(
      Effect.provide(
        CliTokenManager.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerStalledBody(status),
              Layer.mock(ServerSecretStore.ServerSecretStore)({
                get: () => Effect.succeedSome(expiredStoredToken),
              }),
              Layer.mock(ExternalLauncher.ExternalLauncher)({}),
              NodeServices.layer,
            ),
          ),
        ),
      ),
      provideTestEnv,
    ),
);

it.layer(NodeServices.layer)("CliTokenManager.deviceAuthorizationLogin", (it) => {
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
        assert.equal(poll.params.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
        assert.equal(poll.params.get("device_code"), "device-code-1");
        assert.equal(poll.params.get("client_id"), "oauth_client_test");
      }
    }),
  );

  it.effect("waits the advertised interval between polls and backs off on slow_down", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("slow_down"), oauthError("authorization_pending")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(4));
      assert.lengthOf(tokenRequests(server.requests), 0);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.lengthOf(tokenRequests(server.requests), 1);
      // slow_down widens the 5s interval to 10s.
      yield* TestClock.adjust(Duration.seconds(9));
      assert.lengthOf(tokenRequests(server.requests), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.lengthOf(tokenRequests(server.requests), 2);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("backs off after a transient upstream failure and keeps polling", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [{ status: 503, body: "upstream unavailable" }, tokenGranted],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.forkChild,
      );

      yield* TestClock.adjust(Duration.seconds(5));
      assert.lengthOf(tokenRequests(server.requests), 1);
      // The 5xx widens the 5s interval to 10s before the retry.
      yield* TestClock.adjust(Duration.seconds(9));
      assert.lengthOf(tokenRequests(server.requests), 1);
      yield* TestClock.adjust(Duration.seconds(1));
      const { token } = yield* Fiber.join(fiber);
      assert.lengthOf(tokenRequests(server.requests), 2);
      assert.equal(token.accessToken, "access-token-1");
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

  it.effect("times out once the device code lifetime elapses", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("authorization_pending")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(600));
      const result = yield* Fiber.join(fiber);

      assert.instanceOf(result, CliTokenManager.CloudCliAuthorizationTimeoutError);
    }),
  );

  it.effect("surfaces other OAuth errors as authorization failures", () =>
    Effect.gen(function* () {
      const server: DeviceFlowServer = {
        requests: [],
        tokenReplies: [oauthError("invalid_client")],
      };

      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerDeviceFlow(server)),
        provideTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(5));
      const result = yield* Fiber.join(fiber);

      assert.isTrue(isAuthorizationError(result));
    }),
  );

  it.effect("fails instead of hanging when the device authorization response stalls", () =>
    Effect.gen(function* () {
      const fiber = yield* CliTokenManager.deviceAuthorizationLogin(() => Effect.void).pipe(
        Effect.provide(layerStalledBody(200)),
        provideTestEnv,
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(Duration.seconds(10));

      assert.isTrue(Cause.isTimeoutError(yield* Fiber.join(fiber)));
    }),
  );
});
