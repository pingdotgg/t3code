import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Terminal from "effect/Terminal";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import type { OutOfBandOAuthPromptInput } from "./CliTokenManager.ts";

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
// verified — the CLI only reads the claims to display and key the connected
// account).
const TestIdTokenHeaderJson = Schema.fromJsonString(Schema.Struct({ alg: Schema.Literal("none") }));
const TestIdTokenPayloadJson = Schema.fromJsonString(
  Schema.Struct({ email: Schema.String, sub: Schema.optional(Schema.String) }),
);
const encodeTestIdTokenHeader = Schema.encodeSync(TestIdTokenHeaderJson);
const encodeTestIdTokenPayload = Schema.encodeSync(TestIdTokenPayloadJson);
const makeTestIdToken = (payload: { readonly email: string; readonly sub?: string }) => {
  const header = Encoding.encodeBase64Url(encodeTestIdTokenHeader({ alg: "none" }));
  return `${header}.${Encoding.encodeBase64Url(encodeTestIdTokenPayload(payload))}.`;
};
const idTokenWithEmail = makeTestIdToken({ email: "theo@example.test" });

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

const makeTokenEndpointLayer = (
  requests: Array<RecordedTokenRequest>,
  options?: { readonly idToken?: string },
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        requests.push({ url: request.url, params: new URLSearchParams(body) });
        return HttpClientResponse.fromWeb(
          request,
          new Response(
            encodeTestTokenResponse({
              access_token: "access-token-1",
              refresh_token: "refresh-token-1",
              id_token: options?.idToken ?? idTokenWithEmail,
              expires_in: 3600,
              token_type: "bearer",
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }),
    ),
  );

const provideTestEnv = Effect.provide(
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: TEST_ENV })),
);

const isAuthorizationError = Schema.is(CliTokenManager.CloudCliAuthorizationError);

class PromptRejectedError extends Schema.TaggedErrorClass<PromptRejectedError>()(
  "PromptRejectedError",
  { message: Schema.String },
) {}

it("formats loopback authorization with a headless-host fallback", () => {
  assert.equal(
    CliTokenManager.formatLoopbackAuthorizationPrompt("https://clerk.example.test/authorize"),
    [
      "Open this URL to authorize T3 Connect:",
      "  https://clerk.example.test/authorize",
      "",
      "Press \u001b[1mEnter\u001b[22m to open it in your browser.",
      "No browser on this device? Press \u001b[1mH\u001b[22m to switch to headless mode.",
    ].join("\n"),
  );
});

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

it.layer(NodeServices.layer)("CliTokenManager.outOfBandOAuthLogin", (it) => {
  it.effect("prints a hosted authorize URL and exchanges the out-of-band code with PKCE", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];
      let seenAuthorizeUrl = "";

      const { token, identity } = yield* CliTokenManager.outOfBandOAuthLogin(
        ({ authorizeUrl, validate }: OutOfBandOAuthPromptInput) =>
          Effect.gen(function* () {
            seenAuthorizeUrl = authorizeUrl;
            const request = readConnectAuthorizeRequest(new URL(authorizeUrl));
            assert.isNotNull(request);
            return yield* validate(`clerk-code-123.${request!.state}`).pipe(
              Effect.mapError((message) => new PromptRejectedError({ message })),
            );
          }),
      ).pipe(Effect.provide(makeTokenEndpointLayer(requests)), provideTestEnv);

      const authorizeUrl = new URL(seenAuthorizeUrl);
      assert.equal(authorizeUrl.origin, "https://hosted.example.test");
      assert.equal(authorizeUrl.pathname, "/connect");
      const request = readConnectAuthorizeRequest(authorizeUrl);
      assert.isNotNull(request);
      assert.match(request!.state, /^[A-Za-z0-9_-]{22}$/);

      assert.equal(token.accessToken, "access-token-1");
      assert.equal(token.refreshToken, "refresh-token-1");
      assert.equal(token.identity, "theo@example.test");
      // The id_token's email claim is surfaced so connect can show the account.
      assert.equal(identity, "theo@example.test");

      assert.lengthOf(requests, 1);
      const exchange = requests[0]!;
      assert.equal(exchange.url, "https://clerk.example.test/oauth/token");
      assert.equal(exchange.params.get("grant_type"), "authorization_code");
      assert.equal(exchange.params.get("code"), "clerk-code-123");
      assert.equal(
        exchange.params.get("redirect_uri"),
        "https://hosted.example.test/connect/callback",
      );
      assert.equal(exchange.params.get("client_id"), "oauth_client_test");
      // The verifier must hash to the challenge advertised in the authorize URL.
      const verifier = exchange.params.get("code_verifier");
      assert.isNotNull(verifier);
      const crypto = yield* Crypto.Crypto;
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier!));
      assert.equal(Encoding.encodeBase64Url(digest), request!.challenge);
    }),
  );

  it.effect("rejects out-of-band codes whose state does not match the request", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];

      const validationErrors: Array<string> = [];
      const result = yield* CliTokenManager.outOfBandOAuthLogin(
        ({ validate }: OutOfBandOAuthPromptInput) =>
          validate("clerk-code-123.wrong-state").pipe(
            Effect.tapError((message) => Effect.sync(() => validationErrors.push(message))),
            Effect.mapError((message) => new PromptRejectedError({ message })),
          ),
      ).pipe(Effect.provide(makeTokenEndpointLayer(requests)), provideTestEnv, Effect.flip);

      assert.lengthOf(requests, 0);
      assert.lengthOf(validationErrors, 1);
      assert.include(validationErrors[0], "different connect request");
      assert.instanceOf(result, PromptRejectedError);
    }),
  );

  it.effect("ignores an id_token whose claims are not valid JSON", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];
      const malformedIdToken = `header.${Encoding.encodeBase64Url("not-json")}.signature`;

      const { identity } = yield* CliTokenManager.outOfBandOAuthLogin(
        ({ authorizeUrl }: OutOfBandOAuthPromptInput) => {
          const request = readConnectAuthorizeRequest(new URL(authorizeUrl));
          assert.isNotNull(request);
          return Effect.succeed(`clerk-code-123.${request!.state}`);
        },
      ).pipe(
        Effect.provide(makeTokenEndpointLayer(requests, { idToken: malformedIdToken })),
        provideTestEnv,
      );

      assert.isNull(identity);
      assert.lengthOf(requests, 1);
    }),
  );

  it.effect("fails without touching the token endpoint when the prompt returns garbage", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];

      const result = yield* CliTokenManager.outOfBandOAuthLogin(() =>
        Effect.succeed("not-a-connect-code"),
      ).pipe(Effect.provide(makeTokenEndpointLayer(requests)), provideTestEnv, Effect.flip);

      assert.lengthOf(requests, 0);
      assert.isTrue(isAuthorizationError(result));
    }),
  );
});

const TestStoredTokenJson = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    expiresAtEpochMs: Schema.Number,
    identity: Schema.optional(Schema.String),
    accountId: Schema.optional(Schema.String),
  }),
);
const encodeStoredToken = Schema.encodeSync(TestStoredTokenJson);
const decodeStoredToken = Schema.decodeUnknownSync(TestStoredTokenJson);

const TestUserinfoJson = Schema.fromJsonString(
  Schema.Struct({ sub: Schema.String, email: Schema.String }),
);
const encodeUserinfo = Schema.encodeSync(TestUserinfoJson);

const makeMemorySecretStore = () => {
  const secrets = new Map<string, Uint8Array>();
  const service: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(secrets.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        secrets.set(name, value);
      }),
    getOrCreateRandom: () => Effect.die("unused getOrCreateRandom"),
    remove: (name) =>
      Effect.sync(() => {
        secrets.delete(name);
      }),
  };
  return { service, secrets };
};

const readStoredToken = (secrets: Map<string, Uint8Array>) => {
  const bytes = secrets.get("cloud-cli-oauth-token");
  return bytes === undefined ? null : decodeStoredToken(new TextDecoder().decode(bytes));
};

// The login fiber clears the pending flag in an `ensuring` just after it
// persists the credential; yield until that final step lands.
const awaitPendingLoginSettled = (manager: CliTokenManager.CloudCliTokenManager["Service"]) =>
  Effect.gen(function* () {
    while ((yield* manager.clientAuthState.pipe(provideTestEnv)).pendingLogin) {
      yield* Effect.yieldNow;
    }
  });

const unusedTerminal = Terminal.make({
  columns: Effect.succeed(80),
  rows: Effect.succeed(24),
  readInput: Effect.die("terminal input unused"),
  readLine: Effect.never,
  display: () => Effect.void,
});

it.layer(NodeServices.layer)("CloudCliTokenManager browser login", (it) => {
  it.effect("opens the browser, exchanges the callback code, and persists the credential", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];
      const memory = makeMemorySecretStore();
      const opened: Array<string> = [];
      const browserOpened = yield* Deferred.make<void>();
      const persisted = yield* Deferred.make<void>();
      const store: ServerSecretStore.ServerSecretStore["Service"] = {
        ...memory.service,
        set: (name, value) =>
          memory.service
            .set(name, value)
            .pipe(Effect.andThen(Deferred.succeed(persisted, undefined))),
      };

      const manager = yield* CliTokenManager.make.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, store),
        Effect.provideService(Terminal.Terminal, unusedTerminal),
        Effect.provideService(ExternalLauncher.ExternalLauncher, {
          resolveAvailableEditors: () => Effect.succeed([]),
          launchBrowser: (url) =>
            Effect.sync(() => {
              opened.push(url);
            }).pipe(Effect.andThen(Deferred.succeed(browserOpened, undefined))),
          launchEditor: () => Effect.die("unused launchEditor"),
        }),
        Effect.provide(
          makeTokenEndpointLayer(requests, {
            idToken: makeTestIdToken({ email: "theo@example.test", sub: "user_desktop" }),
          }),
        ),
        provideTestEnv,
      );

      const { authorizationUrl } = yield* manager.beginBrowserLogin.pipe(provideTestEnv);
      const request = readConnectAuthorizeRequest(new URL(authorizationUrl));
      assert.isNotNull(request);
      assert.equal(request!.loopbackPort, 34338);

      // A second call while the first flow waits reuses the same attempt
      // instead of fighting over the loopback port.
      const second = yield* manager.beginBrowserLogin.pipe(provideTestEnv);
      assert.equal(second.authorizationUrl, authorizationUrl);
      const pendingState = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.isFalse(pendingState.authorized);
      assert.isTrue(pendingState.pendingLogin);
      assert.equal(pendingState.authorizationUrl, authorizationUrl);

      // The browser only launches once the loopback listener is up, so the
      // launch signal is the receipt that the callback URL is reachable.
      yield* Deferred.await(browserOpened);
      assert.deepEqual(opened, [authorizationUrl]);
      const callback = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(
          HttpClientRequest.get(
            `http://127.0.0.1:34338/callback?code=clerk-code-123&state=${encodeURIComponent(request!.state)}`,
          ),
        );
      }).pipe(Effect.provide(FetchHttpClient.layer));
      assert.equal(callback.status, 200);
      yield* Deferred.await(persisted);
      yield* awaitPendingLoginSettled(manager);

      const state = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.isTrue(state.authorized);
      assert.isFalse(state.pendingLogin);
      assert.equal(state.accountId, "user_desktop");
      assert.equal(state.identity, "theo@example.test");

      assert.lengthOf(requests, 1);
      const exchange = requests[0]!;
      assert.equal(exchange.url, "https://clerk.example.test/oauth/token");
      assert.equal(exchange.params.get("grant_type"), "authorization_code");
      assert.equal(exchange.params.get("code"), "clerk-code-123");
      assert.equal(exchange.params.get("redirect_uri"), "http://127.0.0.1:34338/callback");
    }),
  );

  it.effect("a sign-out cancels a pending browser login", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];
      const memory = makeMemorySecretStore();
      const browserOpened = yield* Deferred.make<void>();

      const manager = yield* CliTokenManager.make.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, memory.service),
        Effect.provideService(Terminal.Terminal, unusedTerminal),
        Effect.provideService(ExternalLauncher.ExternalLauncher, {
          resolveAvailableEditors: () => Effect.succeed([]),
          launchBrowser: () => Deferred.succeed(browserOpened, undefined).pipe(Effect.asVoid),
          launchEditor: () => Effect.die("unused launchEditor"),
        }),
        Effect.provide(makeTokenEndpointLayer(requests)),
        provideTestEnv,
      );

      yield* manager.beginBrowserLogin.pipe(provideTestEnv);
      yield* Deferred.await(browserOpened);
      yield* manager.clear;
      yield* awaitPendingLoginSettled(manager);

      const state = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.isFalse(state.authorized);
      assert.isFalse(state.pendingLogin);
      // The attempt died before any token exchange could run.
      assert.lengthOf(requests, 0);
      assert.isNull(readStoredToken(memory.secrets));
    }),
  );

  it.effect("a fresh sign-in right after a sign-out completes cleanly", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];
      const memory = makeMemorySecretStore();
      // Each launch signals after its loopback listener is up.
      const launches = yield* Queue.make<void>();
      const persisted = yield* Deferred.make<void>();
      const store: ServerSecretStore.ServerSecretStore["Service"] = {
        ...memory.service,
        set: (name, value) =>
          memory.service
            .set(name, value)
            .pipe(Effect.andThen(Deferred.succeed(persisted, undefined))),
      };

      const manager = yield* CliTokenManager.make.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, store),
        Effect.provideService(Terminal.Terminal, unusedTerminal),
        Effect.provideService(ExternalLauncher.ExternalLauncher, {
          resolveAvailableEditors: () => Effect.succeed([]),
          launchBrowser: () => Queue.offer(launches, undefined).pipe(Effect.asVoid),
          launchEditor: () => Effect.die("unused launchEditor"),
        }),
        Effect.provide(
          makeTokenEndpointLayer(requests, {
            idToken: makeTestIdToken({ email: "theo@example.test", sub: "user_retry" }),
          }),
        ),
        provideTestEnv,
      );

      // First attempt gets cancelled by a sign-out; the second must not lose
      // its pending state to the first fiber's cleanup, and must be able to
      // rebind the loopback port.
      const first = yield* manager.beginBrowserLogin.pipe(provideTestEnv);
      yield* Queue.take(launches);
      yield* manager.clear;
      const second = yield* manager.beginBrowserLogin.pipe(provideTestEnv);
      assert.notEqual(second.authorizationUrl, first.authorizationUrl);
      yield* Queue.take(launches);

      const pendingState = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.isTrue(pendingState.pendingLogin);
      assert.equal(pendingState.authorizationUrl, second.authorizationUrl);

      const request = readConnectAuthorizeRequest(new URL(second.authorizationUrl));
      assert.isNotNull(request);
      const callback = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(
          HttpClientRequest.get(
            `http://127.0.0.1:34338/callback?code=clerk-code-789&state=${encodeURIComponent(request!.state)}`,
          ),
        );
      }).pipe(Effect.provide(FetchHttpClient.layer));
      assert.equal(callback.status, 200);
      yield* Deferred.await(persisted);
      yield* awaitPendingLoginSettled(manager);

      const state = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.isTrue(state.authorized);
      assert.equal(state.accountId, "user_retry");
      assert.lengthOf(requests, 1);
      assert.equal(requests[0]!.params.get("code"), "clerk-code-789");
    }),
  );

  it.effect("a denied authorization fails the pending attempt promptly", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];
      const memory = makeMemorySecretStore();
      const browserOpened = yield* Deferred.make<void>();

      const manager = yield* CliTokenManager.make.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, memory.service),
        Effect.provideService(Terminal.Terminal, unusedTerminal),
        Effect.provideService(ExternalLauncher.ExternalLauncher, {
          resolveAvailableEditors: () => Effect.succeed([]),
          launchBrowser: () => Deferred.succeed(browserOpened, undefined).pipe(Effect.asVoid),
          launchEditor: () => Effect.die("unused launchEditor"),
        }),
        Effect.provide(makeTokenEndpointLayer(requests)),
        provideTestEnv,
      );

      const { authorizationUrl } = yield* manager.beginBrowserLogin.pipe(provideTestEnv);
      const request = readConnectAuthorizeRequest(new URL(authorizationUrl));
      assert.isNotNull(request);
      yield* Deferred.await(browserOpened);

      const callback = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        return yield* client.execute(
          HttpClientRequest.get(
            `http://127.0.0.1:34338/callback?error=access_denied&state=${encodeURIComponent(request!.state)}`,
          ),
        );
      }).pipe(Effect.provide(FetchHttpClient.layer));
      assert.equal(callback.status, 200);
      yield* awaitPendingLoginSettled(manager);

      const state = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.isFalse(state.authorized);
      assert.isFalse(state.pendingLogin);
      assert.lengthOf(requests, 0);
    }),
  );

  it.effect("completes a pending browser login with a pasted out-of-band code", () =>
    Effect.gen(function* () {
      const requests: Array<RecordedTokenRequest> = [];
      const memory = makeMemorySecretStore();
      const persisted = yield* Deferred.make<void>();
      const store: ServerSecretStore.ServerSecretStore["Service"] = {
        ...memory.service,
        set: (name, value) =>
          memory.service
            .set(name, value)
            .pipe(Effect.andThen(Deferred.succeed(persisted, undefined))),
      };

      const manager = yield* CliTokenManager.make.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, store),
        Effect.provideService(Terminal.Terminal, unusedTerminal),
        Effect.provideService(ExternalLauncher.ExternalLauncher, {
          resolveAvailableEditors: () => Effect.succeed([]),
          launchBrowser: () => Effect.void,
          launchEditor: () => Effect.die("unused launchEditor"),
        }),
        Effect.provide(
          makeTokenEndpointLayer(requests, {
            idToken: makeTestIdToken({ email: "theo@example.test", sub: "user_oob" }),
          }),
        ),
        provideTestEnv,
      );

      const rejectedWithoutLogin = yield* manager.submitBrowserLoginCode("code.state");
      assert.isFalse(rejectedWithoutLogin.accepted);

      const { authorizationUrl } = yield* manager.beginBrowserLogin.pipe(provideTestEnv);
      const request = readConnectAuthorizeRequest(new URL(authorizationUrl));
      assert.isNotNull(request);

      const rejected = yield* manager.submitBrowserLoginCode("clerk-code-456.wrong-state");
      assert.isFalse(rejected.accepted);
      assert.lengthOf(requests, 0);

      const accepted = yield* manager.submitBrowserLoginCode(` clerk-code-456.${request!.state} `);
      assert.isTrue(accepted.accepted);
      // A second paste for the same attempt is reported as rejected, not
      // silently swallowed.
      const doubled = yield* manager.submitBrowserLoginCode(`clerk-code-456.${request!.state}`);
      assert.isFalse(doubled.accepted);
      yield* Deferred.await(persisted);
      yield* awaitPendingLoginSettled(manager);

      const state = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.isTrue(state.authorized);
      assert.isFalse(state.pendingLogin);

      // The out-of-band code was issued against the hosted callback redirect
      // URI, so the exchange must name it instead of the loopback URI.
      assert.lengthOf(requests, 1);
      const exchange = requests[0]!;
      assert.equal(exchange.params.get("code"), "clerk-code-456");
      assert.equal(
        exchange.params.get("redirect_uri"),
        "https://hosted.example.test/connect/callback",
      );
    }),
  );

  it.effect("clientAuthState backfills the account id for legacy credentials via userinfo", () =>
    Effect.gen(function* () {
      const memory = makeMemorySecretStore();
      const now = yield* Clock.currentTimeMillis;
      memory.secrets.set(
        "cloud-cli-oauth-token",
        new TextEncoder().encode(
          encodeStoredToken({
            accessToken: "legacy-access-token",
            refreshToken: "legacy-refresh-token",
            expiresAtEpochMs: now + 3_600_000,
          }),
        ),
      );
      const userinfoRequests: Array<string> = [];
      const userinfoLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            userinfoRequests.push(`${request.headers.authorization}`);
            return HttpClientResponse.fromWeb(
              request,
              new Response(encodeUserinfo({ sub: "user_legacy", email: "theo@example.test" }), {
                status: 200,
                headers: { "content-type": "application/json" },
              }),
            );
          }),
        ),
      );

      const manager = yield* CliTokenManager.make.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, memory.service),
        Effect.provideService(Terminal.Terminal, unusedTerminal),
        Effect.provideService(ExternalLauncher.ExternalLauncher, {
          resolveAvailableEditors: () => Effect.succeed([]),
          launchBrowser: () => Effect.die("unused launchBrowser"),
          launchEditor: () => Effect.die("unused launchEditor"),
        }),
        Effect.provide(userinfoLayer),
        provideTestEnv,
      );

      const state = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.isTrue(state.authorized);
      assert.equal(state.accountId, "user_legacy");
      assert.equal(state.identity, "theo@example.test");
      assert.deepEqual(userinfoRequests, ["Bearer legacy-access-token"]);

      // The backfill persists, so the next read does not hit userinfo again.
      const again = yield* manager.clientAuthState.pipe(provideTestEnv);
      assert.equal(again.accountId, "user_legacy");
      assert.lengthOf(userinfoRequests, 1);
      assert.deepInclude(readStoredToken(memory.secrets), { accountId: "user_legacy" });
    }),
  );
});
