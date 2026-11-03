import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { makeCodexChatGptAuth } from "./CodexChatGptAuth.ts";
import * as CodexManagedResponses from "./CodexManagedResponses.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";

const instanceId = ProviderInstanceId.make("codex");
const expired = { error: { code: "token_expired", message: "expired" } };
const makeHarness = Effect.fnUntraced(function* (
  options: {
    error?: unknown;
    retryStatus?: number;
    renewalFails?: boolean;
    concurrent?: boolean;
    constraint?: "replacement" | "earliestRefreshAt" | "sharing" | "logout";
  } = {},
) {
  const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
  const fixtureCredentials = {
    clientId: "oaiapp_bridge",
    subject: "bridge-user",
    idToken: "sign-in",
    email: null,
    accessToken: "stale-access",
    refreshToken: "single-use-refresh",
    expiresAt: (yield* Clock.currentTimeMillis) + 3_600_000,
    earliestRefreshAt: null as number | null,
    scopes: ["chatgpt.tokens.use.direct"],
  };
  const credentials = fixtureCredentials;
  const save = (record: typeof credentials) =>
    store.set(new TextEncoder().encode(JSON.stringify(record)));
  yield* save(credentials);
  const requests: { token: string | undefined; body: string; url: string }[] = [];
  const refreshTokens: string[] = [];
  const bothRejected = yield* Deferred.make<void>();
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (request.url.endsWith("openid-configuration"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            issuer: "https://auth.openai.com",
            authorization_endpoint: "https://auth.openai.com/authorize",
            token_endpoint: "https://auth.openai.com/token",
            jwks_uri: "https://auth.openai.com/jwks",
          }),
        );
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing request body");
      const body = new TextDecoder().decode(request.body.body);
      if (request.url === "https://auth.openai.com/token") {
        refreshTokens.push(new URLSearchParams(body).get("refresh_token")!);
        return HttpClientResponse.fromWeb(
          request,
          options.renewalFails
            ? Response.json({ error: "temporarily_unavailable" }, { status: 503 })
            : Response.json({
                access_token: "fresh-access",
                refresh_token: "rotated-refresh",
                expires_in: 3600,
                token_type: "Bearer",
                scope: "chatgpt.tokens.use.direct",
              }),
        );
      }
      requests.push({ token: request.headers.authorization, body, url: request.url });
      if (request.headers.authorization === "Bearer stale-access") {
        if (options.constraint === "logout") yield* store.remove.pipe(Effect.orDie);
        else if (options.constraint)
          yield* save({
            ...credentials,
            ...(options.constraint === "replacement" ? { idToken: "new-sign-in" } : {}),
            ...(options.constraint === "earliestRefreshAt"
              ? { earliestRefreshAt: credentials.expiresAt }
              : {}),
            ...(options.constraint === "sharing" ? { scopes: ["openid"] } : {}),
          }).pipe(Effect.orDie);
        if (options.concurrent) {
          if (requests.length === 2) yield* Deferred.succeed(bothRejected, undefined);
          yield* Deferred.await(bothRejected);
        }
        return HttpClientResponse.fromWeb(
          request,
          Response.json(options.error ?? expired, { status: 401 }),
        );
      }
      return HttpClientResponse.fromWeb(
        request,
        options.retryStatus
          ? Response.json(expired, { status: options.retryStatus })
          : new Response('data: {"output":"OK"}\n\n', {
              headers: { "content-type": "text/event-stream" },
            }),
      );
    }),
  );
  const auth = yield* makeCodexChatGptAuth({ instanceId }).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const bridge = yield* CodexManagedResponses.make().pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );
  const profileKey = yield* auth.profileKey(credentials);
  const register = bridge.register({ instanceId, profileKey });
  const token = yield* register;
  const body = JSON.stringify({
    model: "gpt-test",
    input: "same turn",
    stream: true,
    metadata: { thread: "thread-test" },
  });
  const send = (bearer = token, path = "/responses") =>
    HttpClientRequest.post(`${bridge.baseUrl}${path}`).pipe(
      HttpClientRequest.bearerToken(bearer),
      HttpClientRequest.setHeader("x-client-request-id", "same-request"),
      HttpClientRequest.bodyText(body, "application/json"),
      HttpClient.execute,
      Effect.flatMap((response) =>
        Effect.map(response.text, (text) => ({ status: response.status, text })),
      ),
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
    );
  return { send, auth, save, credentials, requests, refreshTokens, body, register, token };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(ServerSecretStore.layer),
    Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "managed-responses-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

it.live.each([false, true])(
  "renews locally unexpired tokens and replays the same request once (concurrent=%s)",
  (concurrent) =>
    provide(
      Effect.gen(function* () {
        const h = yield* makeHarness({ concurrent });
        const count = concurrent ? 2 : 1;
        const results = yield* Effect.all(
          Array.from({ length: count }, () => h.send()),
          { concurrency: "unbounded" },
        );
        assert.deepEqual(
          results,
          Array.from({ length: count }, () => ({ status: 200, text: 'data: {"output":"OK"}\n\n' })),
        );
        assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
        assert.equal(h.requests.length, count * 2);
        for (const request of h.requests) {
          assert.equal(request.body, h.body);
          assert.equal(request.url, "https://api.openai.com/v1/responses");
        }
        assert.equal(h.requests.at(-1)!.token, "Bearer fresh-access");
        const saved = Option.getOrThrow(yield* h.auth.read);
        assert.equal(saved.refreshToken, "rotated-refresh");
        assert.equal(saved.subject, h.credentials.subject);
      }),
    ),
);

it.live.each([
  { name: "other 401", error: { error: { code: "invalid_api_key" } }, renewals: 0, attempts: 1 },
  { name: "unstructured 401", error: { message: "token_expired" }, renewals: 0, attempts: 1 },
  { name: "second 401", retryStatus: 401, renewals: 1, attempts: 2 },
  { name: "renewal failure", renewalFails: true, renewals: 1, attempts: 1 },
  {
    name: "locally expired renewal failure",
    renewalFails: true,
    locallyExpired: true,
    renewals: 1,
    attempts: 0,
  },
])("terminates on $name", (options) =>
  provide(
    Effect.gen(function* () {
      const h = yield* makeHarness(options);
      if ("locallyExpired" in options) yield* h.save({ ...h.credentials, expiresAt: 0 });
      const result = yield* h.send();
      assert.equal(result.status, 401);
      if ("locallyExpired" in options)
        assert.include(result.text, "Could not renew the ChatGPT connection");
      assert.equal(h.refreshTokens.length, options.renewals);
      assert.equal(h.requests.length, options.attempts);
    }),
  ),
);

it.live.each(["replacement", "earliestRefreshAt", "sharing", "logout"] as const)(
  "respects %s while recovering a rejected token",
  (constraint) =>
    provide(
      Effect.gen(function* () {
        const h = yield* makeHarness({ constraint });
        const result = yield* h.send();
        assert.equal(result.status, 401);
        assert.deepEqual(h.refreshTokens, []);
        assert.equal(h.requests.length, 1);
        for (const secret of [h.credentials.accessToken, h.credentials.refreshToken])
          assert.notInclude(result.text, secret);
        if (constraint === "earliestRefreshAt")
          assert.isAtMost(
            Option.getOrThrow(yield* h.auth.read).expiresAt,
            yield* Clock.currentTimeMillis,
          );
      }),
    ),
);

it.live("refuses unauthenticated callers and non-Responses destinations", () =>
  provide(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      assert.equal((yield* h.send("wrong-token")).status, 401);
      assert.equal((yield* h.send(undefined, "/untrusted")).status, 404);
      assert.deepEqual(h.requests, []);
      assert.deepEqual(h.refreshTokens, []);
    }),
  ),
);

it.live("reuses a profile grant without retaining more auth resources", () =>
  provide(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const scope = yield* Scope.Scope;
      const finalizers = () =>
        scope.state._tag === "Open"
          ? (scope.state.finalizers?.size ?? 0) + (scope.state.finalizer ? 1 : 0)
          : 0;
      const before = finalizers();
      for (let i = 0; i < 3; i++) assert.equal(yield* h.register, h.token);
      assert.isAtMost(finalizers(), before);
      yield* h.save({ ...h.credentials, scopes: ["openid"] });
      assert.equal((yield* Effect.result(h.register))._tag, "Failure");
    }),
  ),
);
