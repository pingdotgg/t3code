// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off preferSchemaOverJson:off
// shared fixtures for CodexChatGptAuth (never imports the test file)
// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Local mock OAuth server validates the browser callback boundary.
import * as NodeNet from "node:net";
import * as Context from "effect/Context";
import * as Scope from "effect/Scope";
import * as ServerConfig from "../config.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import { subscribeChatGptHandoff } from "./CodexChatGptHandoff.ts";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";


export const assertSameCallback = (actual: string | null, expected: string | null) => {
  const left = new URL(actual!);
  const right = new URL(expected!);
  assert.strictEqual(left.protocol, right.protocol);
  assert.strictEqual(left.hostname, right.hostname);
  assert.strictEqual(left.pathname, right.pathname);
};

export const environmentIds = new WeakMap<Map<string, Uint8Array>, EnvironmentId>();

export const instanceId = ProviderInstanceId.make("managed-codex-test");

export const makeHarnessFor = Effect.fnUntraced(function* (
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
    recordOwners: () => Effect.void,
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
    bindProfile: (expectedProfileKey: string) =>
      makeCodexChatGptAuth({
        instanceId,
        expectedProfileKey,
        discoveryUrl: `${origin}/discovery`,
        resource: `${origin}/v1`,
      }).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, environment),
      ),
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

export const makeRenewalBroker = Effect.gen(function* () {
  const oauthEntered = yield* Deferred.make<void>();
  const oauthRelease = yield* Deferred.make<void>();
  let pauseOAuth = false;
  const refreshTokens: string[] = [];
  const credentials = {
    clientId: "oaiapp_broker",
    subject: "broker-user",
    idToken: "broker-sign-in",
    email: null,
    accessToken: "expired-access",
    refreshToken: "single-use-refresh",
    expiresAt: 0,
    earliestRefreshAt: null,
    scopes: ["chatgpt.tokens.use.direct"],
  };
  const environmentId = EnvironmentId.make("00000000-0000-4000-8000-000000000001");
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("openid-configuration")) {
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://auth.openai.com",
            authorization_endpoint: "https://auth.openai.com/authorize",
            token_endpoint: "https://auth.openai.com/token",
            jwks_uri: "https://auth.openai.com/jwks",
          }),
        );
      }
      assert.equal(request.url, "https://auth.openai.com/token");
      assert.equal(request.body._tag, "Uint8Array");
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing refresh body");
      const body = new URLSearchParams(new TextDecoder().decode(request.body.body));
      refreshTokens.push(body.get("refresh_token")!);
      yield* Deferred.succeed(oauthEntered, undefined);
      if (pauseOAuth) yield* Deferred.await(oauthRelease);
      return HttpClientResponse.fromWeb(
        request,
        Response.json({
          access_token: "renewed-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "chatgpt.tokens.use.direct",
        }),
      );
    }),
  );
  return yield* Effect.gen(function* () {
    const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
    yield* store.set(new TextEncoder().encode(JSON.stringify(credentials)));
    const auth = yield* makeCodexChatGptAuth({ instanceId });
    const profileKey = yield* auth.profileKey(credentials);
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
    const context = yield* Layer.buildWithScope(CodexManagedTokenBroker.layer, scope);
    const broker = Context.get(context, CodexManagedTokenBroker.CodexManagedTokenBroker);
    const endpoint = yield* broker.endpoint;
    yield* Effect.addFinalizer(() => Deferred.succeed(oauthRelease, undefined));
    return {
      auth,
      store,
      broker,
      endpoint,
      refreshTokens,
      request: { version: 1, instanceId, environmentId, profileKey },
      oauthEntered,
      oauthRelease,
      pause: () => {
        pauseOAuth = true;
      },
    };
  }).pipe(
    Effect.provide(ServerSecretStore.layer),
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  );
});

export const provision = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer, NodePlatformCrypto.layer),
    ),
  );

export const makeHarness = makeHarnessFor(instanceId);

export const brokerClient = (endpoint: string, request: unknown) =>
  Effect.acquireRelease(
    Effect.callback<{ socket: NodeNet.Socket; response: Promise<string> }, Error>((resume) => {
      const socket = NodeNet.createConnection(endpoint);
      let text = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        text += chunk;
      });
      const response = new Promise<string>((resolve) => socket.once("close", () => resolve(text)));
      socket.on("error", () => {});
      socket.once("error", (error) => resume(Effect.fail(error)));
      socket.once("connect", () => {
        socket.write(JSON.stringify(request) + "\n");
        resume(Effect.succeed({ socket, response }));
      });
      return Effect.sync(() => {
        if (socket.connecting) socket.destroy();
      });
    }),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  );
