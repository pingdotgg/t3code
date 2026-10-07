// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Local mock OAuth server validates the browser callback boundary.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { subscribeChatGptHandoff } from "./CodexChatGptHandoff.ts";
import { FetchHttpClient } from "effect/http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";

const assertSameCallback = (actual: string | null, expected: string | null) => {
  const left = new URL(actual!);
  const right = new URL(expected!);
  assert.strictEqual(left.protocol, right.protocol);
  assert.strictEqual(left.hostname, right.hostname);
  assert.strictEqual(left.pathname, right.pathname);
};
const environmentIds = new WeakMap<Map<string, Uint8Array>, EnvironmentId>();
const instanceId = ProviderInstanceId.make("managed-codex-test");
const makeHarnessFor = Effect.fnUntraced(function* (
  instanceId: ProviderInstanceId,
  bytes: Map<string, Uint8Array> = new Map(),
  failAnalytics = false,
) {
  const environmentId = environmentIds.get(bytes) ?? EnvironmentId.make(NodeCrypto.randomUUID());
  environmentIds.set(bytes, environmentId);
  const environment = ServerEnvironment.ServerEnvironmentIdentity.of({
    getEnvironmentId: Effect.succeed(environmentId),
  });
  const keys = yield* Effect.promise(() => generateKeyPair("RS256"));
  const jwk = yield* Effect.promise(() => exportJWK(keys.publicKey));
  const untrustedKeys = yield* Effect.promise(() => generateKeyPair("RS256"));
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(bytes.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        bytes.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        bytes.delete(name);
      }),
    create: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("Host identity must come from the environment."),
  });
  let authorize: URL | undefined;
  let refreshes = 0;
  let revoked = false;
  let refreshError: string | undefined;
  let revocationStatus = 200;
  let codeError: string | undefined;
  const revocations: URLSearchParams[] = [];
  let transient = false;
  let invalidNonce = false;
  let identityFailure: "issuer" | "audience" | "signature" | undefined;
  let mismatchedState = false;
  let callbackClientId: string | undefined;
  let subject = "user-test";
  let email = "hidden@example.test";
  let grantScope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
  let origin = "";
  const exchanges: URLSearchParams[] = [];
  const authorizationRequests: URL[] = [];
  const callbackResponses: { body: string; headers: Headers }[] = [];
  let returnUrl = "http://localhost:7001/welcome";
  const server = yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<NodeHttp.Server>((resolve) => {
          const server = NodeHttp.createServer(async (request, response) => {
            response.setHeader("content-type", "application/json");
            if (request.url === "/discovery") {
              response.end(
                JSON.stringify({
                  issuer: origin,
                  authorization_endpoint: `${origin}/authorize`,
                  token_endpoint: `${origin}/token`,
                  jwks_uri: `${origin}/jwks`,
                  revocation_endpoint: `${origin}/revoke`,
                }),
              );
              return;
            }
            if (request.url === "/jwks") {
              response.end(
                JSON.stringify({ keys: [{ ...jwk, kid: "test", alg: "RS256", use: "sig" }] }),
              );
              return;
            }
            if (request.url === "/revoke") {
              let text = "";
              for await (const chunk of request) text += chunk.toString();
              revocations.push(new URLSearchParams(text));
              response.statusCode = revocationStatus;
              response.end();
              return;
            }
            if (request.url === "/token") {
              let text = "";
              for await (const chunk of request) text += chunk.toString();
              assert.strictEqual(
                request.headers["content-type"],
                "application/x-www-form-urlencoded",
              );
              assert.isUndefined(request.headers.authorization);
              const body = new URLSearchParams(text);
              assert.isFalse(body.has("client_secret"));
              assert.strictEqual(body.get("resource"), `${origin}/v1`);
              exchanges.push(body);
              if (body.get("grant_type") === "refresh_token") {
                refreshes++;
                if (transient) {
                  response.statusCode = 503;
                  response.end(JSON.stringify({ error: "temporarily_unavailable" }));
                  return;
                }
                if (revoked || refreshError) {
                  response.statusCode = 400;
                  response.end(JSON.stringify({ error: refreshError ?? "invalid_grant" }));
                  return;
                }
                response.end(
                  JSON.stringify({
                    access_token: `access-${refreshes}`,
                    refresh_token: `refresh-${refreshes}`,
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: grantScope,
                  }),
                );
                return;
              }
              if (codeError) {
                response.statusCode = 400;
                response.end(JSON.stringify({ error: codeError }));
                return;
              }
              if (!authorize) {
                response.statusCode = 400;
                response.end("{}");
                return;
              }
              assertSameCallback(
                body.get("redirect_uri"),
                authorize.searchParams.get("redirect_uri"),
              );
              assert.strictEqual(
                NodeCrypto.createHash("sha256")
                  .update(body.get("code_verifier")!)
                  .digest("base64url"),
                authorize.searchParams.get("code_challenge"),
              );
              const token = await new SignJWT({
                nonce: invalidNonce ? "incorrect" : authorize.searchParams.get("nonce"),
                email,
              })
                .setProtectedHeader({ alg: "RS256", kid: "test" })
                .setIssuer(identityFailure === "issuer" ? "https://untrusted-issuer.test" : origin)
                .setAudience(
                  identityFailure === "audience"
                    ? "oaiapp_untrusted_audience"
                    : body.get("client_id")!,
                )
                .setSubject(subject)
                .setIssuedAt()
                .setExpirationTime("1h")
                .sign(identityFailure === "signature" ? untrustedKeys.privateKey : keys.privateKey);
              response.end(
                JSON.stringify({
                  access_token: "initial-access",
                  refresh_token: "initial-refresh",
                  id_token: token,
                  token_type: "Bearer",
                  expires_in: 3600,
                  scope: grantScope,
                }),
              );
              return;
            }
            response.statusCode = 404;
            response.end("{}");
          });
          server.listen(0, "127.0.0.1", () => resolve(server));
        }),
    ),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock address");
  origin = `http://127.0.0.1:${address.port}`;
  const analyticsEvents: {
    event: string;
    properties: Readonly<Record<string, unknown>> | undefined;
  }[] = [];
  const analytics = AnalyticsService.AnalyticsService.of({
    record: (event, properties) =>
      failAnalytics
        ? Effect.die("analytics unavailable")
        : Effect.sync(() => {
            analyticsEvents.push({ event, properties });
          }),
    flush: Effect.void,
  });
  const auth = yield* makeCodexChatGptAuth({
    instanceId,
    discoveryUrl: `${origin}/discovery`,
    resource: `${origin}/v1`,
  }).pipe(
    Effect.provideService(AnalyticsService.AnalyticsService, analytics),
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
  );
  const phase = (phase: string) =>
    auth.controller.subscribe("owner").pipe(
      Stream.filter((state) => state.phase === phase),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  const prepareCallback = (waiting: { authorizationUrl: string | null }) => {
    authorize = new URL(waiting.authorizationUrl!);
    authorizationRequests.push(authorize);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      code: "authorization-code",
      state: mismatchedState ? "unmatched-state" : authorize.searchParams.get("state")!,
      ...(callbackClientId
        ? { client_id: callbackClientId }
        : authorize.searchParams.get("client_id") === "dynamic_agent_client"
          ? { client_id: "oaiapp_test" }
          : {}),
    }).toString();
    return callback;
  };
  const startRemote = (methodId?: string) =>
    Effect.gen(function* () {
      yield* auth.controller.start("owner", Effect.void, methodId, returnUrl, "client");
      const waiting = yield* phase("waiting");
      return { waiting, callbackUrl: prepareCallback(waiting).toString() };
    });
  const signInWithMethod = (methodId?: string) =>
    Effect.gen(function* () {
      yield* auth.controller.start("owner", Effect.void, methodId, returnUrl);
      const waiting = yield* phase("waiting");
      assert.strictEqual(waiting.interaction?.type, "browser");
      const callback = prepareCallback(waiting);
      yield* Effect.promise(async () => {
        const response = await fetch(callback);
        callbackResponses.push({ body: await response.text(), headers: response.headers });
      });
    });
  const seedExpired = Effect.gen(function* () {
    const stored = yield* auth.read;
    const record = Option.getOrThrow(stored);
    const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    yield* store.set(new TextEncoder().encode(JSON.stringify({ ...record, expiresAt: 0 })));
  });
  return {
    auth,
    analyticsEvents,
    secrets,
    environmentId,
    bytes,
    handoff: (profile: Parameters<typeof subscribeChatGptHandoff>[0]["profile"]) =>
      subscribeChatGptHandoff(
        {
          instanceId,
          environmentId,
          attemptId: "test-handoff",
          returnUrl,
          profile,
        },
        "owner",
        { discoveryUrl: `${origin}/discovery`, resource: `${origin}/v1` },
      ).pipe(Stream.provideService(AnalyticsService.AnalyticsService, analytics)),
    finishCallback: (state: { authorizationUrl: string | null }) =>
      Effect.promise(() => fetch(prepareCallback(state))),
    destination: Effect.gen(function* () {
      const destinationBytes = new Map<string, Uint8Array>();
      const destinationStore = ServerSecretStore.ServerSecretStore.of({
        ...secrets,
        get: (name) => Effect.sync(() => Option.fromUndefinedOr(destinationBytes.get(name))),
        set: (name, value) =>
          Effect.sync(() => {
            destinationBytes.set(name, value);
          }),
        remove: (name) =>
          Effect.sync(() => {
            destinationBytes.delete(name);
          }),
      });
      const destination = yield* makeCodexChatGptAuth({
        instanceId,
        discoveryUrl: `${origin}/discovery`,
        resource: `${origin}/v1`,
      }).pipe(
        Effect.provideService(AnalyticsService.AnalyticsService, analytics),
        Effect.provideService(ServerSecretStore.ServerSecretStore, destinationStore),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
      );
      return { auth: destination, bytes: destinationBytes };
    }),
    recreateAuth: makeCodexChatGptAuth({
      instanceId,
      discoveryUrl: `${origin}/discovery`,
      resource: `${origin}/v1`,
    }).pipe(
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
    ),
    startRemote,
    signIn: signInWithMethod(),
    changeAccount: signInWithMethod("chatgpt-change-account"),
    reconnectProfile: (clientId: string) => signInWithMethod(`chatgpt-profile:${clientId}`),
    phase,
    seedExpired,
    exchanges,
    authorizationRequests,
    callbackResponses,
    setReturnUrl: (value: string) => {
      returnUrl = value;
    },
    origin,
    storedRecords: () =>
      Array.from(bytes.entries()).flatMap(([, value]) => {
        const record = JSON.parse(new TextDecoder().decode(value));
        return record.sessions ?? [record];
      }),
    revocations,
    setRefreshError: (value: string) => {
      refreshError = value;
    },
    setRevocationStatus: (value: number) => {
      revocationStatus = value;
    },
    setCodeError: (value: string | undefined) => {
      codeError = value;
    },
    refreshes: () => refreshes,
    setRevoked: () => {
      revoked = true;
    },
    setTransient: (value: boolean) => {
      transient = value;
    },
    setInvalidNonce: () => {
      invalidNonce = true;
    },
    setIdentityFailure: (value: "issuer" | "audience" | "signature") => {
      identityFailure = value;
    },
    mismatchCallbackState: () => {
      mismatchedState = true;
    },
    setCallbackClientId: (value: string) => {
      callbackClientId = value;
    },
    setIdentity: (newSubject: string, newEmail: string) => {
      subject = newSubject;
      email = newEmail;
    },
    declineSharing: () => {
      grantScope = "openid profile email";
    },
  };
});
const makeHarness = makeHarnessFor(instanceId);
const provision = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer)),
  );
it.effect(
  "changing account registers a new user-owned client and then reuses that registration",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        h.setCallbackClientId("oaiapp_other_account");
        h.setIdentity("other-user", "other@example.test");
        yield* h.changeAccount;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[1]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        assert.strictEqual(h.exchanges[1]!.get("client_id"), "oaiapp_other_account");
        const saved = Option.getOrThrow(yield* h.auth.read);
        assert.strictEqual(saved.clientId, "oaiapp_other_account");
        assert.strictEqual(saved.subject, "other-user");
        assert.strictEqual(saved.email, "other@example.test");
        const redirectUri = h.authorizationRequests[1]!.searchParams.get("redirect_uri");
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("client_id"),
          "oaiapp_other_account",
        );
        assertSameCallback(
          h.authorizationRequests[2]!.searchParams.get("redirect_uri"),
          redirectUri,
        );
      }),
    ),
);
it.effect.each(["identity", "sharing"] as const)(
  "failed account change preserves the original credentials and registration: %s",
  (failure) =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const before = h.storedRecords();
        h.setCallbackClientId("oaiapp_other_account");
        if (failure === "identity") h.setInvalidNonce();
        else h.declineSharing();
        yield* h.changeAccount;
        yield* h.phase("failed");
        assert.strictEqual(
          h.authorizationRequests[1]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        if (failure === "sharing") {
          assert.deepEqual(
            Option.getOrThrow(yield* h.auth.read),
            before.find((record) => record.accessToken),
          );
          assert.lengthOf(h.storedRecords().find((record) => record.profiles).profiles, 2);
        } else assert.deepEqual(h.storedRecords(), before);
      }),
    ),
);
it.effect("retains the callback host and path after controller recreation and token removal", () =>
  provision(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      const first = yield* makeHarnessFor(instanceId, bytes);
      yield* first.signIn;
      yield* first.phase("succeeded");
      const redirectUri = first.authorizationRequests[0]!.searchParams.get("redirect_uri");
      yield* first.auth.revoke;
      const restarted = yield* makeHarnessFor(instanceId, bytes);
      yield* restarted.signIn;
      yield* restarted.phase("succeeded");
      assert.strictEqual(
        restarted.authorizationRequests[0]!.searchParams.get("client_id"),
        "oaiapp_test",
      );
      assertSameCallback(
        restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
        redirectUri,
      );
      assert.strictEqual(
        restarted.exchanges[0]!.get("redirect_uri"),
        restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
      );
    }),
  ),
);
it.effect("reauthorizes on an available port when the original callback port is occupied", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const port = Number(
        new URL(h.authorizationRequests[0]!.searchParams.get("redirect_uri")!).port,
      );
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<NodeHttp.Server>((resolve, reject) => {
              const server = NodeHttp.createServer();
              server.once("error", reject);
              server.listen(port, "127.0.0.1", () => resolve(server));
            }),
        ),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      yield* h.signIn;
      yield* h.phase("succeeded");
      assert.notStrictEqual(
        Number(new URL(h.authorizationRequests[1]!.searchParams.get("redirect_uri")!).port),
        port,
      );
      assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("client_id"), "oaiapp_test");
      assert.strictEqual(h.exchanges.length, 2);
    }),
  ),
);

it.effect("registers a fresh client when the original registration is no longer stored", () =>
  provision(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      const h = yield* makeHarnessFor(instanceId, bytes);
      yield* h.signIn;
      yield* h.phase("succeeded");
      for (const [key, value] of bytes) {
        const record = JSON.parse(new TextDecoder().decode(value));
        if (record.profiles) bytes.delete(key);
      }
      h.setCallbackClientId("oaiapp_replacement");
      yield* h.signIn;
      yield* h.phase("succeeded");
      assert.strictEqual(
        h.authorizationRequests[1]!.searchParams.get("client_id"),
        "dynamic_agent_client",
      );
      assert.strictEqual(h.exchanges[1]!.get("client_id"), "oaiapp_replacement");
      assert.strictEqual(Option.getOrThrow(yield* h.auth.read).clientId, "oaiapp_replacement");
    }),
  ),
);
it.effect("reauthorizes a registration without persisting its original port", () =>
  provision(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      const h = yield* makeHarnessFor(instanceId, bytes);
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.auth.revoke;
      for (const [key, value] of bytes) {
        const record = JSON.parse(new TextDecoder().decode(value));
        if (record.profiles)
          bytes.set(key, new TextEncoder().encode(JSON.stringify({ clientId: "oaiapp_test" })));
      }
      yield* h.signIn;
      yield* h.phase("succeeded");
      assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("client_id"), "oaiapp_test");
      assert.strictEqual(new URL(h.exchanges[1]!.get("redirect_uri")!).hostname, "127.0.0.1");
    }),
  ),
);

it.effect(
  "separate Codex accounts register independently and disconnect only their own tokens",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const personal = yield* makeHarnessFor(ProviderInstanceId.make("codex_personal"), bytes);
        const work = yield* makeHarnessFor(ProviderInstanceId.make("codex_work"), bytes);
        yield* personal.signIn;
        yield* personal.phase("succeeded");
        const personalCredentials = Option.getOrThrow(yield* personal.auth.read);
        assert.isTrue(Option.isNone(yield* work.auth.read));
        yield* work.signIn;
        yield* work.phase("succeeded");
        assert.strictEqual(
          work.authorizationRequests[0]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        assert.notStrictEqual(
          personal.auth.controller.credentialBinding?.key,
          work.auth.controller.credentialBinding?.key,
        );
        yield* work.auth.controller.logout(Effect.void);
        assert.isTrue(Option.isNone(yield* work.auth.read));
        assert.deepEqual(Option.getOrThrow(yield* personal.auth.read), personalCredentials);
      }),
    ),
);
it.effect(
  "emits the guide's first-time authorization request and fresh reauthorization values",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.include(
          h.callbackResponses[0]!.body,
          'content="1;url=http://localhost:7001/welcome"',
        );
        const first = h.authorizationRequests[0]!;
        assert.strictEqual(
          first.searchParams.get("ext_agent_host_id"),
          `urn:uuid:${h.environmentId}`,
        );
        assert.strictEqual(first.origin, h.origin);
        assert.strictEqual(first.pathname, "/authorize");
        assert.deepEqual(Array.from(first.searchParams.keys()).sort(), [
          "agent_name_hint",
          "client_id",
          "code_challenge",
          "code_challenge_method",
          "ext_agent_host_id",
          "nonce",
          "redirect_uri",
          "resource",
          "response_type",
          "scope",
          "state",
        ]);
        assert.strictEqual(first.searchParams.get("client_id"), "dynamic_agent_client");
        assert.strictEqual(first.searchParams.get("agent_name_hint"), "T3 Code");
        assert.strictEqual(first.searchParams.get("response_type"), "code");
        assert.strictEqual(
          first.searchParams.get("scope"),
          "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
        );
        assert.strictEqual(first.searchParams.get("resource"), `${h.origin}/v1`);
        assert.strictEqual(first.searchParams.get("code_challenge_method"), "S256");
        const callback = new URL(first.searchParams.get("redirect_uri")!);
        assert.strictEqual(callback.protocol, "http:");
        assert.strictEqual(callback.hostname, "127.0.0.1");
        assert.strictEqual(callback.pathname, "/auth/callback");
        assert.isAbove(Number(callback.port), 0);
        for (const key of ["state", "nonce", "code_challenge"]) {
          assert.match(first.searchParams.get(key)!, /^[A-Za-z0-9_-]{43}$/u);
        }
        assert.notStrictEqual(first.searchParams.get("state"), first.searchParams.get("nonce"));
        const originalIdToken = Option.getOrThrow(yield* h.auth.read).idToken;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const second = h.authorizationRequests[1]!;
        assert.strictEqual(second.searchParams.get("client_id"), "oaiapp_test");
        assert.isFalse(second.searchParams.has("agent_name_hint"));
        assert.strictEqual(second.searchParams.get("login_hint"), "hidden@example.test");
        assert.strictEqual(second.searchParams.get("id_token_hint"), originalIdToken);
        assert.strictEqual(
          second.searchParams.get("ext_agent_host_id"),
          first.searchParams.get("ext_agent_host_id"),
        );
        assertSameCallback(
          second.searchParams.get("redirect_uri"),
          first.searchParams.get("redirect_uri"),
        );
        assert.deepEqual(
          Array.from(second.searchParams.keys()).sort(),
          [
            ...Array.from(first.searchParams.keys()).filter((key) => key !== "agent_name_hint"),
            "login_hint",
            "id_token_hint",
          ].sort(),
        );
        for (const key of ["state", "nonce", "code_challenge"]) {
          assert.notStrictEqual(first.searchParams.get(key), second.searchParams.get(key));
        }
        yield* h.auth.controller.logout(Effect.void);
        yield* h.signIn;
        yield* h.phase("succeeded");
        const reconnect = h.authorizationRequests[2]!;
        assert.strictEqual(reconnect.searchParams.get("client_id"), "oaiapp_test");
        assertSameCallback(
          reconnect.searchParams.get("redirect_uri"),
          first.searchParams.get("redirect_uri"),
        );
        assert.isFalse(reconnect.searchParams.has("agent_name_hint"));
        assert.isFalse(reconnect.searchParams.has("id_token_hint"));
        assert.strictEqual(reconnect.searchParams.get("login_hint"), "hidden@example.test");
        assert.strictEqual(
          reconnect.searchParams.get("ext_agent_host_id"),
          first.searchParams.get("ext_agent_host_id"),
        );
        assert.strictEqual(
          h.exchanges[2]!.get("redirect_uri"),
          reconnect.searchParams.get("redirect_uri"),
        );
      }),
    ),
);
it.effect(
  "returns to the initiating client only after sign-in has verified and saved credentials",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.setReturnUrl(
          "http://localhost:7001/settings/providers?instanceId=codex_work&code=secret-code",
        );
        yield* h.signIn;
        assert.isTrue(Option.isSome(yield* h.auth.read));
        const response = h.callbackResponses[0]!;
        assert.include(response.headers.get("content-type")!, "text/html");
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
        assert.strictEqual(response.headers.get("referrer-policy"), "no-referrer");
        assert.include(response.headers.get("content-security-policy")!, "default-src 'none'");
        assert.include(response.body, "You're signed in".replace("'", "&#39;"));
        assert.include(
          response.body,
          'content="1;url=http://localhost:7001/settings/providers?instanceId=codex_work"',
        );
        assert.notInclude(response.body, "secret-code");
        assert.include(response.body, 'history.replaceState(null,"","/auth/callback")');
        assert.notInclude(response.body, "authorization-code");
        assert.notInclude(response.body, "initial-access");
        assert.notInclude(response.body, "hidden@example.test");
      }),
    ),
);
it.effect("preserves the Welcome agents step and strips unrelated callback return parameters", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.setReturnUrl("http://localhost:7001/welcome?code=never-forward#agents:test-environment");
      yield* h.signIn;
      assert.include(
        h.callbackResponses[0]!.body,
        'content="1;url=http://localhost:7001/welcome#agents:test-environment"',
      );
      assert.notInclude(h.callbackResponses[0]!.body, "never-forward");
    }),
  ),
);
it.effect(
  "does not redirect to an arbitrary return URL or claim success after verification fails",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.setReturnUrl("https://attacker.example/welcome");
        h.setInvalidNonce();
        yield* h.signIn;
        yield* h.phase("failed");
        const response = h.callbackResponses[0]!;
        assert.include(response.body, "Sign-in couldn&#39;t finish");
        assert.notInclude(response.body, 'http-equiv="refresh"');
        assert.notInclude(response.body, "attacker.example");
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect(
  "verifies registration, PKCE, identity and persists rotating refresh before concurrent access",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "user-test");
        assert.strictEqual(h.exchanges[0]?.get("client_id"), "oaiapp_test");
        yield* h.seedExpired;
        const records = yield* Effect.all([h.auth.access, h.auth.access], {
          concurrency: "unbounded",
        });
        assert.strictEqual(h.refreshes(), 1);
        assert.strictEqual(records[0].accessToken, "access-1");
        assert.strictEqual(records[1].refreshToken, "refresh-1");
        assert.isNull(h.exchanges[1]?.get("scope"));
        yield* h.auth.controller.logout(Effect.void);
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect("rejects invalid ID token nonce without saving credentials", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.setInvalidNonce();
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "could not be verified");
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);
it.effect("retains identity after declined sharing but never admits inference", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.declineSharing();
      yield* h.signIn;
      yield* h.phase("failed");
      assert.isTrue(Option.isSome(yield* h.auth.read));
      const result = yield* h.auth.access.pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(h.refreshes(), 0);
    }),
  ),
);
it.effect("clears revoked refresh credentials and does not replay them", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.seedExpired;
      h.setRevoked();
      yield* h.auth.access.pipe(Effect.result);
      yield* h.auth.access.pipe(Effect.result);
      assert.strictEqual(h.refreshes(), 1);
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);

it.effect(
  "preserves credentials through temporary renewal failure and retries the latest refresh",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        yield* h.seedExpired;
        h.setTransient(true);
        yield* h.auth.access.pipe(Effect.result);
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).refreshToken, "initial-refresh");
        h.setTransient(false);
        const renewed = yield* h.auth.access;
        assert.strictEqual(renewed.refreshToken, "refresh-2");
        assert.strictEqual(h.exchanges.at(-1)?.get("refresh_token"), "initial-refresh");
      }),
    ),
);

it.effect(
  "disconnect retains the remembered account profile while a different account registers afresh",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[0]?.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        yield* h.auth.controller.logout(Effect.void);
        assert.isTrue(Option.isNone(yield* h.auth.read));
        assert.deepEqual(h.storedRecords(), [
          {
            profiles: [
              {
                clientId: "oaiapp_test",
                connectionLabel: "Connection 1",
                sharingEnabled: true,
                redirectUri: h.authorizationRequests[0]!.searchParams.get("redirect_uri"),
                subject: "user-test",
                email: "hidden@example.test",
              },
            ],
            lastClientId: "oaiapp_test",
          },
        ]);
        const disconnected = yield* h.auth.controller
          .subscribe("owner")
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        assert.include(
          disconnected.methods!.find((method) => method.id === "chatgpt")!.description!,
          "hidden@example.test",
        );
        assert.strictEqual(
          disconnected.methods!.find((method) => method.id === "chatgpt")!.accountEmail,
          "hidden@example.test",
        );
        assert.strictEqual(
          disconnected.methods!.find((method) => method.id === "chatgpt-profile:oaiapp_test")!
            .accountEmail,
          "hidden@example.test",
        );
        assert.strictEqual((yield* h.auth.access.pipe(Effect.result))._tag, "Failure");
        assert.strictEqual(h.refreshes(), 0);
        h.setCallbackClientId("oaiapp_different_workspace");
        h.setIdentity("different-user", "different@example.test");
        yield* h.changeAccount;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[1]?.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        assert.strictEqual(h.exchanges[1]?.get("client_id"), "oaiapp_different_workspace");
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "different-user");
      }),
    ),
);
it.effect("revoked connection clears tokens but preserves registration for reconnect", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.seedExpired;
      h.setRevoked();
      yield* h.auth.access.pipe(Effect.result);
      assert.isTrue(Option.isNone(yield* h.auth.read));
      assert.deepEqual(h.storedRecords(), [
        {
          profiles: [
            {
              clientId: "oaiapp_test",
              connectionLabel: "Connection 1",
              sharingEnabled: true,
              redirectUri: h.authorizationRequests[0]!.searchParams.get("redirect_uri"),
              subject: "user-test",
              email: "hidden@example.test",
            },
          ],
          lastClientId: "oaiapp_test",
        },
      ]);
      yield* h.signIn;
      yield* h.phase("succeeded");
      assert.strictEqual(h.authorizationRequests[1]?.searchParams.get("client_id"), "oaiapp_test");
    }),
  ),
);

it.effect("fresh sign-in ignores a registration left by the old disconnect behavior", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.auth.revoke;
      assert.isTrue(Option.isNone(yield* h.auth.read));
      assert.strictEqual(h.storedRecords().length, 1);
      h.setCallbackClientId("oaiapp_new_workspace");
      h.setIdentity("new-workspace-user", "new@example.test");
      yield* h.changeAccount;
      yield* h.phase("succeeded");
      assert.strictEqual(
        h.authorizationRequests[1]!.searchParams.get("client_id"),
        "dynamic_agent_client",
      );
      assert.strictEqual(Option.getOrThrow(yield* h.auth.read).clientId, "oaiapp_new_workspace");
      assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "new-workspace-user");
    }),
  ),
);

it.effect("rejects mismatched callback state before any token exchange or credential write", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.mismatchCallbackState();
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "could not be verified");
      assert.strictEqual(h.exchanges.length, 0);
      assert.deepEqual(h.storedRecords(), []);
      assert.isTrue(Option.isNone(yield* h.auth.read));
    }),
  ),
);
it.effect.each(["issuer", "audience", "signature"] as const)(
  "rejects ID token %s verification before saving tokens or registration",
  (invalidClaim) =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        h.setIdentityFailure(invalidClaim);
        yield* h.signIn;
        assert.include((yield* h.phase("failed")).message!, "could not be verified");
        assert.strictEqual(h.exchanges.length, 1);
        assert.deepEqual(h.storedRecords(), []);
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);
it.effect.each([
  { revoked: false, label: "without changing the current account" },
  { revoked: true, label: "after token removal" },
])("rejects conflicting callback client ID on reauthorization $label", ({ revoked }) =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      if (revoked) yield* h.auth.revoke;
      const before = h.storedRecords();
      h.setCallbackClientId("oaiapp_untrusted_callback");
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "registration is incomplete");
      assert.strictEqual(h.authorizationRequests[1]?.searchParams.get("client_id"), "oaiapp_test");
      assert.strictEqual(h.exchanges.length, 1);
      assert.deepEqual(h.storedRecords(), before);
      assert.strictEqual(Option.isNone(yield* h.auth.read), revoked);
    }),
  ),
);

it.effect("returns successful desktop sign-in to the original Welcome step", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.setReturnUrl("t3code-dev://app/welcome#agents:test-environment");
      yield* h.signIn;
      yield* h.phase("succeeded");
      assert.include(
        h.callbackResponses[0]!.body,
        'content="1;url=t3code-dev://app/welcome#agents:test-environment"',
      );
      assert.include(
        h.callbackResponses[0]!.body,
        'href="t3code-dev://app/welcome#agents:test-environment"',
      );
    }),
  ),
);

it.effect(
  "completes remote sign-in on the owning environment and reuses its exact callback for reauthorization",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarnessFor(instanceId);
      const first = yield* harness.startRemote();
      assert.isTrue(
        first.waiting.interaction?.type === "browser" && first.waiting.interaction.acceptsCallback,
      );
      yield* harness.auth.controller.complete("owner", {
        flowId: first.waiting.flowId!,
        callbackUrl: first.callbackUrl,
      });
      yield* harness.phase("succeeded");
      assert.strictEqual(Option.getOrThrow(yield* harness.auth.read).email, "hidden@example.test");
      const second = yield* harness.startRemote();
      assertSameCallback(second.callbackUrl, first.callbackUrl);
      assert.strictEqual(
        new URL(second.waiting.authorizationUrl!).searchParams.get("client_id"),
        "oaiapp_test",
      );
      yield* harness.auth.controller.complete("owner", {
        flowId: second.waiting.flowId!,
        callbackUrl: second.callbackUrl,
      });
      yield* harness.phase("succeeded");
      assert.strictEqual(harness.exchanges.length, 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
);

it.effect(
  "rejects foreign clients and malformed remote callbacks without consuming the owner's sign-in",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarnessFor(instanceId);
      const { waiting, callbackUrl } = yield* harness.startRemote();
      assert.isTrue(Option.isNone(yield* harness.auth.read));
      yield* Effect.flip(
        harness.auth.controller.complete("other-client", { flowId: waiting.flowId!, callbackUrl }),
      );
      const wrongPort = new URL(callbackUrl);
      wrongPort.port = wrongPort.port === "65535" ? "65534" : "65535";
      for (const invalid of [
        wrongPort.toString(),
        callbackUrl.replace("/auth/callback", "/other"),
        callbackUrl + "&state=foreign",
        callbackUrl + "&code=duplicate",
        callbackUrl + "&error=access_denied",
        callbackUrl.replace("127.0.0.1", "attacker.example"),
      ]) {
        yield* Effect.flip(
          harness.auth.controller.complete("owner", {
            flowId: waiting.flowId!,
            callbackUrl: invalid,
          }),
        );
      }
      assert.strictEqual(harness.exchanges.length, 0);
      assert.isTrue(Option.isNone(yield* harness.auth.read));
      yield* harness.auth.controller.complete("owner", { flowId: waiting.flowId!, callbackUrl });
      yield* harness.phase("succeeded");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    ),
);

it.effect("keeps simultaneous remote accounts and environments independent", () =>
  Effect.gen(function* () {
    const first = yield* makeHarnessFor(instanceId);
    const second = yield* makeHarnessFor(instanceId);
    second.setIdentity("other-user", "other@example.test");
    second.setCallbackClientId("oaiapp_other");
    const a = yield* first.startRemote();
    const b = yield* second.startRemote();
    assert.notStrictEqual(
      new URL(a.waiting.authorizationUrl!).searchParams.get("ext_agent_host_id"),
      new URL(b.waiting.authorizationUrl!).searchParams.get("ext_agent_host_id"),
    );
    yield* Effect.flip(
      first.auth.controller.complete("owner", {
        flowId: a.waiting.flowId!,
        callbackUrl: b.callbackUrl,
      }),
    );
    yield* first.auth.controller.complete("owner", {
      flowId: a.waiting.flowId!,
      callbackUrl: a.callbackUrl,
    });
    yield* second.auth.controller.complete("owner", {
      flowId: b.waiting.flowId!,
      callbackUrl: b.callbackUrl,
    });
    yield* first.phase("succeeded");
    yield* second.phase("succeeded");
    assert.strictEqual(Option.getOrThrow(yield* first.auth.read).subject, "user-test");
    assert.strictEqual(Option.getOrThrow(yield* second.auth.read).subject, "other-user");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer))),
);

it.effect(
  "reconnects after Disconnect and restart with the same client and host on an available port",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const first = yield* makeHarnessFor(instanceId, bytes);
        yield* first.signIn;
        yield* first.phase("succeeded");
        const redirectUri = first.authorizationRequests[0]!.searchParams.get("redirect_uri");
        yield* first.auth.controller.logout(Effect.void);
        const restarted = yield* makeHarnessFor(instanceId, bytes);
        yield* restarted.signIn;
        yield* restarted.phase("succeeded");
        assert.strictEqual(
          restarted.authorizationRequests[0]!.searchParams.get("client_id"),
          "oaiapp_test",
        );
        assertSameCallback(
          restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
          redirectUri,
        );
        assert.strictEqual(
          restarted.exchanges[0]!.get("redirect_uri"),
          restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
        );
        assert.strictEqual(Option.getOrThrow(yield* restarted.auth.read).subject, "user-test");
      }),
    ),
);

it.effect.each([
  { disconnected: false, label: "while connected" },
  { disconnected: true, label: "after Disconnect" },
])("rejects a different verified identity during saved-profile reauth $label", ({ disconnected }) =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      if (disconnected) yield* h.auth.controller.logout(Effect.void);
      const before = h.storedRecords();
      h.setIdentity("another-user", "another@example.test");
      yield* h.signIn;
      assert.include((yield* h.phase("failed")).message!, "different ChatGPT account");
      assert.deepEqual(h.storedRecords(), before);
      assert.strictEqual(Option.isNone(yield* h.auth.read), disconnected);
    }),
  ),
);

it.effect(
  "retains both profiles and reuses the original account's client and callback when returning from another account",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const first = yield* makeHarnessFor(instanceId, bytes);
        yield* first.signIn;
        yield* first.phase("succeeded");
        const redirectUri = first.authorizationRequests[0]!.searchParams.get("redirect_uri");
        first.setIdentity("other-user", "other@example.test");
        first.setCallbackClientId("oaiapp_other_account");
        yield* first.changeAccount;
        const changed = yield* first.phase("succeeded");
        assert.isTrue(
          changed.methods!.some((method) => method.id === "chatgpt-profile:oaiapp_test"),
        );
        assert.isTrue(
          changed.methods!.some((method) => method.id === "chatgpt-profile:oaiapp_other_account"),
        );
        yield* first.auth.controller.logout(Effect.void);
        const restarted = yield* makeHarnessFor(instanceId, bytes);
        yield* restarted.reconnectProfile("oaiapp_test");
        yield* restarted.phase("succeeded");
        assert.strictEqual(
          restarted.authorizationRequests[0]!.searchParams.get("client_id"),
          "oaiapp_test",
        );
        assertSameCallback(
          restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
          redirectUri,
        );
        assert.strictEqual(Option.getOrThrow(yield* restarted.auth.read).subject, "user-test");
      }),
    ),
);

it.effect("fresh sign-in to the same identity preserves separate registration profiles", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setIdentity("other-user", "other@example.test");
      h.setCallbackClientId("oaiapp_other_account");
      yield* h.changeAccount;
      yield* h.phase("succeeded");
      h.setIdentity("user-test", "hidden@example.test");
      h.setCallbackClientId("oaiapp_replacement");
      yield* h.changeAccount;
      const changed = yield* h.phase("succeeded");
      assert.deepEqual(
        changed
          .methods!.filter((method) => method.id.startsWith("chatgpt-profile:"))
          .map((method) => method.id),
        [
          "chatgpt-profile:oaiapp_replacement",
          "chatgpt-profile:oaiapp_other_account",
          "chatgpt-profile:oaiapp_test",
        ],
      );
      assert.strictEqual(Option.getOrThrow(yield* h.auth.read).clientId, "oaiapp_replacement");
      const redirectUri = h.authorizationRequests[2]!.searchParams.get("redirect_uri");
      yield* h.auth.controller.logout(Effect.void);
      yield* h.reconnectProfile("oaiapp_replacement");
      yield* h.phase("succeeded");
      assert.strictEqual(
        h.authorizationRequests[3]!.searchParams.get("client_id"),
        "oaiapp_replacement",
      );
      assertSameCallback(h.authorizationRequests[3]!.searchParams.get("redirect_uri"), redirectUri);
    }),
  ),
);

it.effect("preserves legacy profiles with the same email and subject", () =>
  provision(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      const h = yield* makeHarnessFor(instanceId, bytes);
      yield* h.signIn;
      yield* h.phase("succeeded");
      const redirectUri = h.authorizationRequests[0]!.searchParams.get("redirect_uri");
      for (const [key, value] of bytes) {
        const record = JSON.parse(new TextDecoder().decode(value));
        if (record.profiles)
          bytes.set(
            key,
            new TextEncoder().encode(
              JSON.stringify({
                ...record,
                profiles: [
                  { ...record.profiles[0], clientId: "oaiapp_old_duplicate" },
                  ...record.profiles,
                ],
              }),
            ),
          );
      }
      const restarted = yield* makeHarnessFor(instanceId, bytes);
      const state = yield* restarted.auth.controller.subscribe("owner").pipe(
        Stream.filter((state) => state.methods != null),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      assert.deepEqual(
        state
          .methods!.filter((method) => method.id.startsWith("chatgpt-profile:"))
          .map((method) => method.id),
        ["chatgpt-profile:oaiapp_test", "chatgpt-profile:oaiapp_old_duplicate"],
      );
      yield* restarted.signIn;
      yield* restarted.phase("succeeded");
      assert.strictEqual(
        restarted.authorizationRequests[0]!.searchParams.get("client_id"),
        "oaiapp_test",
      );
      assertSameCallback(
        restarted.authorizationRequests[0]!.searchParams.get("redirect_uri"),
        redirectUri,
      );
      assert.lengthOf(restarted.storedRecords().find((record) => record.profiles).profiles, 2);
    }),
  ),
);

it.effect("keeps distinct verified identities even when their email matches", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setIdentity("other-user", "hidden@example.test");
      h.setCallbackClientId("oaiapp_other_account");
      yield* h.changeAccount;
      const changed = yield* h.phase("succeeded");
      assert.lengthOf(
        changed.methods!.filter((method) => method.id.startsWith("chatgpt-profile:")),
        2,
      );
    }),
  ),
);

it.effect(
  "migrates a legacy registration and retains its verified identity when credentials are cleared",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const first = yield* makeHarnessFor(instanceId, bytes);
        yield* first.signIn;
        yield* first.phase("succeeded");
        const redirectUri = first.authorizationRequests[0]!.searchParams.get("redirect_uri");
        for (const [key, value] of bytes) {
          const saved = JSON.parse(new TextDecoder().decode(value));
          if (saved.profiles)
            bytes.set(
              key,
              new TextEncoder().encode(JSON.stringify({ clientId: "oaiapp_test", redirectUri })),
            );
        }
        yield* first.auth.revoke;
        assert.deepEqual(first.storedRecords(), [
          {
            profiles: [
              {
                clientId: "oaiapp_test",
                connectionLabel: "Connection 1",
                redirectUri,
                subject: "user-test",
                email: "hidden@example.test",
              },
            ],
            lastClientId: "oaiapp_test",
          },
        ]);
        const restarted = yield* makeHarnessFor(instanceId, bytes);
        restarted.setIdentity("another-user", "another@example.test");
        yield* restarted.signIn;
        assert.include((yield* restarted.phase("failed")).message!, "different ChatGPT account");
        assert.isTrue(Option.isNone(yield* restarted.auth.read));
        assert.strictEqual(
          restarted.authorizationRequests[0]!.searchParams.get("ext_agent_host_id"),
          first.authorizationRequests[0]!.searchParams.get("ext_agent_host_id"),
        );
      }),
    ),
);

it.effect("declined sharing on an older profile does not replace the active account", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setIdentity("other-user", "other@example.test");
      h.setCallbackClientId("oaiapp_other_account");
      yield* h.changeAccount;
      yield* h.phase("succeeded");
      const before = h.storedRecords();
      h.setIdentity("user-test", "hidden@example.test");
      h.setCallbackClientId("oaiapp_test");
      h.declineSharing();
      yield* h.reconnectProfile("oaiapp_test");
      assert.include(
        (yield* h.phase("failed")).message!,
        "existing ChatGPT connection is unchanged",
      );
      assert.deepEqual(
        Option.getOrThrow(yield* h.auth.read),
        before.find((record) => record.clientId === "oaiapp_other_account"),
      );
    }),
  ),
);

it.effect(
  "Disconnect preserves a remote profile's callback URI for client-delivered reconnect",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const first = yield* h.startRemote();
        yield* h.auth.controller.complete("owner", {
          flowId: first.waiting.flowId!,
          callbackUrl: first.callbackUrl,
        });
        yield* h.phase("succeeded");
        yield* h.auth.controller.logout(Effect.void);
        const second = yield* h.startRemote();
        assert.strictEqual(
          new URL(second.waiting.authorizationUrl!).searchParams.get("client_id"),
          "oaiapp_test",
        );
        assertSameCallback(
          new URL(second.waiting.authorizationUrl!).searchParams.get("redirect_uri"),
          new URL(first.waiting.authorizationUrl!).searchParams.get("redirect_uri"),
        );
        yield* h.auth.controller.complete("owner", {
          flowId: second.waiting.flowId!,
          callbackUrl: second.callbackUrl,
        });
        yield* h.phase("succeeded");
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "user-test");
      }),
    ),
);

it.effect.each([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
  "invalid_client",
  "invalid_token",
])("refresh recovery follows the machine-readable code: %s", (code) =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.seedExpired;
      h.setRefreshError(code);
      yield* Effect.flip(h.auth.access);
      assert.strictEqual(
        Option.isNone(yield* h.auth.read),
        !["invalid_client", "invalid_token"].includes(code),
      );
      assert.isTrue(
        h
          .storedRecords()
          .some((record) =>
            record.profiles?.some(
              (profile: { clientId: string }) => profile.clientId === "oaiapp_test",
            ),
          ),
      );
    }),
  ),
);

it.effect(
  "logout revokes the latest refresh token with the selected client and clears its ID hint",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const host = h.authorizationRequests[0]!.searchParams.get("ext_agent_host_id");
        assert.match(host!, /^urn:uuid:[0-9a-f-]{36}$/u);
        yield* h.seedExpired;
        yield* h.auth.access;
        const state = yield* h.auth.controller.logout(Effect.void);
        assert.strictEqual(state.message, "Signed out.");
        assert.deepEqual(Array.from(h.revocations[0]!), [
          ["token", "refresh-1"],
          ["token_type_hint", "refresh_token"],
          ["client_id", "oaiapp_test"],
        ]);
        assert.isTrue(Option.isNone(yield* h.auth.read));
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.isFalse(h.authorizationRequests[1]!.searchParams.has("id_token_hint"));
        assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("ext_agent_host_id"), host);
      }),
    ),
);

it.live("logout retries temporary revocation failures and reports local-only sign-out", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setRevocationStatus(503);
      const state = yield* h.auth.controller.logout(Effect.void);
      assert.lengthOf(h.revocations, 3);
      assert.strictEqual(state.phase, "idle");
      assert.include(state.message!, "Remote revocation could not be confirmed");
      assert.isTrue(Option.isNone(yield* h.auth.read));
      assert.isFalse(h.storedRecords().some((record) => record.idToken));
    }),
  ),
);

it.effect(
  "reauth hints come from the selected profile, including after another profile logs out",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const personal = Option.getOrThrow(yield* h.auth.read);
        h.setCallbackClientId("oaiapp_work");
        h.setIdentity("work-user", "work@example.test");
        yield* h.changeAccount;
        yield* h.phase("succeeded");
        assert.isFalse(h.authorizationRequests[1]!.searchParams.has("id_token_hint"));
        assert.isFalse(h.authorizationRequests[1]!.searchParams.has("login_hint"));
        yield* h.auth.controller.logout(Effect.void);
        h.setCallbackClientId("oaiapp_test");
        h.setIdentity("user-test", "hidden@example.test");
        yield* h.reconnectProfile("oaiapp_test");
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("id_token_hint"),
          personal.idToken,
        );
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("login_hint"),
          personal.email,
        );
      }),
    ),
);

it.effect("an expired initial code retains the issued ID for a fresh authorization", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.setCodeError("invalid_grant");
      yield* h.signIn;
      const failed = yield* h.phase("failed");
      assert.isTrue(Option.isNone(yield* h.auth.read));
      assert.isTrue(failed.methods!.some((method) => method.id === "chatgpt-profile:oaiapp_test"));
      h.setCodeError(undefined);
      yield* h.reconnectProfile("oaiapp_test");
      yield* h.phase("succeeded");
      assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("client_id"), "oaiapp_test");
      assert.notStrictEqual(
        h.authorizationRequests[0]!.searchParams.get("state"),
        h.authorizationRequests[1]!.searchParams.get("state"),
      );
    }),
  ),
);

it.effect("identity-only sign-in requests consent on an explicit retry, then rechecks scopes", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      h.declineSharing();
      yield* h.signIn;
      yield* h.phase("failed");
      yield* h.reconnectProfile("oaiapp_test");
      yield* h.phase("failed");
      assert.strictEqual(h.authorizationRequests[1]!.searchParams.get("prompt"), "consent");
      assert.isFalse(h.authorizationRequests[1]!.searchParams.has("force_reconsent"));
      assert.include(
        h.authorizationRequests[1]!.searchParams.get("scope")!,
        "chatgpt.tokens.use.direct",
      );
      yield* Effect.flip(h.auth.access);
    }),
  ),
);

it.effect(
  "controller replacement shares refresh serialization for the same environment session",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.signIn;
        yield* h.phase("succeeded");
        const replacement = yield* h.recreateAuth;
        yield* h.seedExpired;
        const records = yield* Effect.all([h.auth.access, replacement.access], {
          concurrency: "unbounded",
        });
        assert.strictEqual(h.refreshes(), 1);
        assert.strictEqual(records[0].refreshToken, "refresh-1");
        assert.deepEqual(records[0], records[1]);
      }),
    ),
);

it.effect(
  "old localhost registrations retain their profile while a new client gets its own identity",
  () =>
    provision(
      Effect.gen(function* () {
        const bytes = new Map<string, Uint8Array>();
        const h = yield* makeHarnessFor(instanceId, bytes);
        yield* h.signIn;
        yield* h.phase("succeeded");
        for (const [key, value] of bytes) {
          const record = JSON.parse(new TextDecoder().decode(value));
          if (record.profiles)
            bytes.set(
              key,
              new TextEncoder().encode(
                JSON.stringify({
                  ...record,
                  profiles: record.profiles.map((profile: { redirectUri: string }) => ({
                    ...profile,
                    redirectUri: profile.redirectUri.replace("127.0.0.1", "localhost"),
                  })),
                }),
              ),
            );
        }
        h.setCallbackClientId("oaiapp_migrated");
        h.setIdentity("new-client-subject", "hidden@example.test");
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[1]!.searchParams.get("client_id"),
          "dynamic_agent_client",
        );
        assert.strictEqual(
          new URL(h.authorizationRequests[1]!.searchParams.get("redirect_uri")!).hostname,
          "127.0.0.1",
        );
        assert.strictEqual(Option.getOrThrow(yield* h.auth.read).subject, "new-client-subject");
        const profiles = (yield* h.phase("succeeded")).methods!;
        assert.isTrue(profiles.some((profile) => profile.id === "chatgpt-profile:oaiapp_test"));
        assert.isTrue(profiles.some((profile) => profile.id === "chatgpt-profile:oaiapp_migrated"));
        yield* h.signIn;
        yield* h.phase("succeeded");
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("client_id"),
          "oaiapp_migrated",
        );
        assert.strictEqual(
          h.authorizationRequests[2]!.searchParams.get("login_hint"),
          "hidden@example.test",
        );
        assert.isTrue(h.authorizationRequests[2]!.searchParams.has("id_token_hint"));
      }),
    ),
);

it.effect("keeps the active connection first when another profile declines sharing", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setCallbackClientId("oaiapp_identity_only");
      h.setIdentity("other-user", "other@example.test");
      h.declineSharing();
      yield* h.changeAccount;
      const state = yield* h.phase("failed");
      assert.strictEqual(Option.getOrThrow(yield* h.auth.read).clientId, "oaiapp_test");
      const profiles = state.methods!.filter((method) => method.id.startsWith("chatgpt-profile:"));
      assert.strictEqual(profiles[0]!.id, "chatgpt-profile:oaiapp_test");
      assert.include(profiles[0]!.name, "Connection 1");
      assert.include(profiles[1]!.name, "Connection 2");
    }),
  ),
);

it.effect("primary completes OAuth and destination imports and owns the refresh session", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const destination = yield* h.destination;
      const before = h.bytes.size;
      const waiting = yield* Deferred.make<{ authorizationUrl: string | null }>();
      const transferred = yield* h.handoff(null).pipe(
        Stream.tap((state) =>
          state.phase === "auth" && state.state.phase === "waiting"
            ? Deferred.succeed(waiting, state.state)
            : Effect.void,
        ),
        Stream.filter((state) => state.phase === "finished"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.forkChild,
      );
      yield* h.finishCallback(yield* Deferred.await(waiting));
      const result = yield* Fiber.join(transferred);
      assert.strictEqual(result.phase, "finished");
      if (result.phase !== "finished") return;
      assert.strictEqual(h.bytes.size, before);
      assert.isTrue(Option.isNone(yield* h.auth.read));
      let stopped = false;
      const imported = yield* destination.auth.controller.importProfile!(
        result.profile,
        Effect.sync(() => {
          stopped = true;
        }),
      );
      assert.isTrue(stopped);
      assert.strictEqual(imported.phase, "succeeded");
      assert.deepStrictEqual(
        h.analyticsEvents.map(({ event }) => event),
        [
          "chatgpt.auth.started",
          "chatgpt.auth.completed",
          "chatgpt.transfer.started",
          "chatgpt.transfer.completed",
        ],
      );
      assert.isTrue(
        h.analyticsEvents.every(({ properties }) => properties?.flow === "primary_handoff"),
      );
      assert.strictEqual(h.analyticsEvents[1]?.properties?.outcome, "succeeded");
      assert.strictEqual(h.analyticsEvents[3]?.properties?.outcome, "succeeded");
      assert.notProperty(h.analyticsEvents[1]?.properties ?? {}, "connectedAccountCount");
      assert.strictEqual(h.analyticsEvents[1]?.properties?.intent, "different_account");
      assert.strictEqual(h.analyticsEvents[3]?.properties?.connectedAccountCount, 1);
      assert.strictEqual(h.analyticsEvents[3]?.properties?.savedConnectionCount, 1);
      const saved = Option.getOrThrow(yield* destination.auth.read);
      assert.strictEqual(saved.clientId, result.profile.registration.clientId);
      assert.strictEqual(saved.refreshToken, "initial-refresh");
      const reconnect = yield* destination.auth.controller.reconnectProfile!("chatgpt");
      assert.strictEqual(reconnect?.idTokenHint, result.profile.credentials.idToken);
      assert.isFalse("refreshToken" in reconnect!);
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId).pipe(
        Effect.provideService(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: (name) => Effect.sync(() => Option.fromUndefinedOr(destination.bytes.get(name))),
            set: (name, value) =>
              Effect.sync(() => {
                destination.bytes.set(name, value);
              }),
            remove: () => Effect.void,
            create: () => Effect.die("unused"),
            getOrCreateRandom: () => Effect.die("unused"),
          }),
        ),
      );
      yield* store.set(new TextEncoder().encode(JSON.stringify({ ...saved, expiresAt: 0 })));
      yield* destination.auth.access;
      assert.strictEqual(
        h.exchanges.filter((entry) => entry.get("grant_type") === "authorization_code").length,
        1,
      );
      assert.strictEqual(
        h.exchanges.filter((entry) => entry.get("grant_type") === "refresh_token").length,
        1,
      );
    }),
  ),
);

it.effect("transferred profiles reject mismatched identities without overwriting credentials", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const profile = yield* h.auth.exportProfile;
      const destination = yield* h.destination;
      yield* destination.auth.controller.importProfile!(profile, Effect.void);
      const original = Option.getOrThrow(yield* destination.auth.read);
      for (const credentials of [
        { ...profile.credentials, subject: "wrong-user" },
        { ...profile.credentials, clientId: "oaiapp_wrong" },
        { ...profile.credentials, idToken: "not-a-jwt" },
        { ...profile.credentials, scopes: ["openid"] },
        { ...profile.credentials, expiresAt: 0 },
      ]) {
        const result = yield* destination.auth.controller.importProfile!(
          { ...profile, credentials },
          Effect.void,
        ).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.deepEqual(Option.getOrThrow(yield* destination.auth.read), original);
      }
    }),
  ),
);

it.effect("primary handoff reuses the selected registration and ID token hint", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const profile = yield* h.auth.controller.reconnectProfile!("chatgpt");
      const waiting = yield* Deferred.make<{ authorizationUrl: string | null }>();
      const resultFiber = yield* h.handoff(profile).pipe(
        Stream.tap((state) =>
          state.phase === "auth" && state.state.phase === "waiting"
            ? Deferred.succeed(waiting, state.state)
            : Effect.void,
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      const state = yield* Deferred.await(waiting);
      const url = new URL(state.authorizationUrl!);
      assert.strictEqual(url.searchParams.get("client_id"), profile!.clientId);
      assert.strictEqual(url.searchParams.get("id_token_hint"), profile!.idTokenHint);
      assert.strictEqual(url.searchParams.get("login_hint"), profile!.email);
      assert.strictEqual(url.searchParams.get("ext_agent_host_id"), `urn:uuid:${h.environmentId}`);
      yield* h.finishCallback(state);
      const results = yield* Fiber.join(resultFiber);
      assert.strictEqual(results.at(-1)?.phase, "finished");
    }),
  ),
);

it.effect(
  "cancelling primary handoff closes its callback listener without saving credentials",
  () =>
    provision(
      Effect.gen(function* () {
        const h = yield* makeHarness;
        const waiting = yield* Deferred.make<{ authorizationUrl: string | null }>();
        const flow = yield* h.handoff(null).pipe(
          Stream.tap((state) =>
            state.phase === "auth" && state.state.phase === "waiting"
              ? Deferred.succeed(waiting, state.state)
              : Effect.void,
          ),
          Stream.runDrain,
          Effect.forkChild,
        );
        const state = yield* Deferred.await(waiting);
        yield* Fiber.interrupt(flow);
        const callback = new URL(
          new URL(state.authorizationUrl!).searchParams.get("redirect_uri")!,
        );
        const request = yield* Effect.tryPromise(() => fetch(callback)).pipe(Effect.result);
        assert.strictEqual(request._tag, "Failure");
        assert.isTrue(Option.isNone(yield* h.auth.read));
      }),
    ),
);

it.effect("records one anonymous auth outcome per success, failure, or cancellation", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setInvalidNonce();
      yield* h.signIn;
      yield* h.phase("failed");
      const { waiting } = yield* h.startRemote();
      yield* h.auth.controller.cancel("owner", waiting.flowId!);
      yield* h.phase("cancelled");
      const completed = h.analyticsEvents.filter(({ event }) => event === "chatgpt.auth.completed");
      assert.deepStrictEqual(
        completed.map(({ properties }) => properties?.outcome),
        ["succeeded", "failed", "cancelled"],
      );
      assert.strictEqual(
        h.analyticsEvents.filter(({ event }) => event === "chatgpt.auth.started").length,
        3,
      );
      assert.strictEqual(completed[1]?.properties?.failureStage, "verify");
      for (const { properties } of completed) {
        assert.isNumber(properties?.durationMs);
        assert.strictEqual(properties?.flow, "direct");
        assert.deepStrictEqual(
          Object.keys(properties!).sort(),
          [
            ...(properties?.outcome === "succeeded"
              ? [
                  "accountCountScope",
                  "connectedAccountCount",
                  "connectedConnectionCount",
                  "savedConnectionCount",
                  "unidentifiedConnectedConnectionCount",
                ]
              : []),
            "callbackMode",
            "durationMs",
            ...(properties?.failureStage ? ["failureStage"] : []),
            "flow",
            "intent",
            "outcome",
          ].sort(),
        );
      }
      const serialized = JSON.stringify(h.analyticsEvents);
      for (const secret of [
        "hidden@example.test",
        "oaiapp_test",
        "user-test",
        "access_token",
        "refresh_token",
      ]) {
        assert.notInclude(serialized, secret);
      }
    }),
  ),
);

it.effect("telemetry failures do not fail a verified ChatGPT sign-in", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarnessFor(instanceId, new Map(), true);
      yield* h.signIn;
      const state = yield* h.phase("succeeded");
      assert.strictEqual(state.phase, "succeeded");
      assert.isTrue(Option.isSome(yield* h.auth.read));
    }),
  ),
);

it.effect("counts accounts separately from saved connections across additions and reconnects", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      yield* h.signIn;
      yield* h.phase("succeeded");
      h.setCallbackClientId("oaiapp_same_account");
      h.setIdentity("another-client-subject", "HIDDEN@example.test");
      yield* h.changeAccount;
      yield* h.phase("succeeded");
      h.setCallbackClientId("oaiapp_other_account");
      h.setIdentity("other-user", "other@example.test");
      yield* h.changeAccount;
      yield* h.phase("succeeded");
      yield* h.auth.controller.logout(Effect.void);
      h.setCallbackClientId("oaiapp_test");
      h.setIdentity("user-test", "hidden@example.test");
      yield* h.reconnectProfile("oaiapp_test");
      yield* h.phase("succeeded");
      const completed = h.analyticsEvents.filter(({ event }) => event === "chatgpt.auth.completed");
      assert.deepStrictEqual(
        completed.map(({ properties }) => [
          properties?.connectedAccountCount,
          properties?.connectedConnectionCount,
          properties?.savedConnectionCount,
        ]),
        [
          [1, 1, 1],
          [1, 1, 1],
          [1, 2, 2],
          [2, 3, 3],
          [1, 2, 3],
        ],
      );
      assert.isTrue(
        completed.every(({ properties }) => properties?.unidentifiedConnectedConnectionCount === 0),
      );
      assert.notInclude(JSON.stringify(h.analyticsEvents), "example.test");
    }),
  ),
);

it.effect("includes accounts from other Codex instances in the environment", () =>
  provision(
    Effect.gen(function* () {
      const bytes = new Map<string, Uint8Array>();
      const personal = yield* makeHarnessFor(instanceId, bytes);
      const work = yield* makeHarnessFor(ProviderInstanceId.make("managed-work"), bytes);
      yield* personal.signIn;
      yield* personal.phase("succeeded");
      work.setCallbackClientId("oaiapp_work");
      work.setIdentity("work-user", "work@example.test");
      yield* work.signIn;
      yield* work.phase("succeeded");
      const completed = work.analyticsEvents.find(
        ({ event }) => event === "chatgpt.auth.completed",
      );
      assert.strictEqual(completed?.properties?.accountCountScope, "environment");
      assert.strictEqual(completed?.properties?.connectedAccountCount, 2);
      assert.strictEqual(completed?.properties?.connectedConnectionCount, 2);
      assert.strictEqual(completed?.properties?.savedConnectionCount, 2);
    }).pipe(
      Effect.provide(
        ServerSettings.layerTest({
          providerInstances: {
            [instanceId]: { driver: "codex", enabled: true },
            [ProviderInstanceId.make("managed-work")]: { driver: "codex", enabled: true },
          },
        }),
      ),
    ),
  ),
);

it.effect("an unreadable unrelated profile omits counts without failing sign-in", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const unrelated = yield* ProviderCredentialStore.make("codex-chatgpt", "codex").pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, h.secrets),
      );
      // The harness owns its store; seed the corresponding binding in that store.
      h.bytes.set(unrelated.binding.key, new TextEncoder().encode("invalid"));
      yield* h.signIn;
      yield* h.phase("succeeded");
      const completed = h.analyticsEvents.find(({ event }) => event === "chatgpt.auth.completed");
      assert.strictEqual(completed?.properties?.outcome, "succeeded");
      assert.notProperty(completed?.properties ?? {}, "connectedAccountCount");
    }).pipe(Effect.provide(ServerSettings.layerTest())),
  ),
);

it.effect("reports connections without an email separately from identifiable accounts", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.signIn;
      yield* h.phase("succeeded");
      const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, h.secrets),
      );
      yield* store.set(
        new TextEncoder().encode(
          JSON.stringify({
            activeClientId: "oaiapp_test",
            sessions: [{ ...Option.getOrThrow(yield* h.auth.read), email: null }],
          }),
        ),
      );
      h.setCallbackClientId("oaiapp_other_account");
      h.setIdentity("other-user", "other@example.test");
      yield* h.changeAccount;
      yield* h.phase("succeeded");
      const completed = h.analyticsEvents.findLast(
        ({ event }) => event === "chatgpt.auth.completed",
      );
      assert.strictEqual(completed?.properties?.connectedAccountCount, 1);
      assert.strictEqual(completed?.properties?.connectedConnectionCount, 2);
      assert.strictEqual(completed?.properties?.unidentifiedConnectedConnectionCount, 1);
    }),
  ),
);

it.effect("records an expired auth outcome when sign-in reaches its deadline", () =>
  provision(
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.startRemote();
      yield* TestClock.adjust(300_001);
      assert.include((yield* h.phase("failed")).message ?? "", "expired");
      const completed = h.analyticsEvents.filter(({ event }) => event === "chatgpt.auth.completed");
      assert.strictEqual(completed.length, 1);
      assert.strictEqual(completed[0]?.properties?.outcome, "expired");
      assert.isAtLeast(completed[0]?.properties?.durationMs as number, 300_000);
    }),
  ),
);
