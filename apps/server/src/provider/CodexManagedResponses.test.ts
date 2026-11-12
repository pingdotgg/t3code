import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
    concurrentRegistration?: boolean;
    pauseRenewal?: boolean;
    constraint?: "replacement" | "earliestRefreshAt";
  } = {},
) {
  const store = yield* ProviderCredentialStore.make("codex-chatgpt", instanceId);
  const credentials = {
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
  const save = (record: typeof credentials) =>
    store.set(new TextEncoder().encode(JSON.stringify(record)));
  yield* save(credentials);
  const requests: { token: string | undefined; body: string; url: string }[] = [];
  const refreshTokens: string[] = [];
  const bothRejected = yield* Deferred.make<void>();
  const renewalEntered = yield* Deferred.make<void>();
  const renewalRelease = yield* Deferred.make<void>();
  yield* Effect.addFinalizer(() => Deferred.succeed(renewalRelease, undefined));
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
        yield* Deferred.succeed(renewalEntered, undefined);
        if (options.pauseRenewal) yield* Deferred.await(renewalRelease);
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
        if (options.constraint)
          yield* save({
            ...credentials,
            ...(options.constraint === "replacement"
              ? { idToken: "new-sign-in" }
              : { earliestRefreshAt: credentials.expiresAt }),
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
  const digest = yield* Digest.Digest;
  const secondRegistering = yield* Deferred.make<void>();
  const firstRegistered = yield* Deferred.make<void>();
  let registrations = 0;
  const bridge = yield* CodexManagedResponses.make().pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(Digest.Digest, {
      ...digest,
      digest: (algorithm, input) =>
        Effect.gen(function* () {
          // Pause credential-store construction after both registrations miss the grant lookup.
          if (
            options.concurrentRegistration &&
            new TextDecoder().decode(input) ===
              `${"codex-chatgpt".length}:codex-chatgpt${instanceId}`
          ) {
            const registration = ++registrations;
            if (registration === 1) yield* Deferred.await(secondRegistering);
            if (registration === 2) {
              yield* Deferred.succeed(secondRegistering, undefined);
              yield* Deferred.await(firstRegistered);
            }
          }
          return yield* digest.digest(algorithm, input);
        }),
    }),
  );
  const profileKey = yield* auth.profileKey(credentials);
  const register = bridge.register({ instanceId, profileKey });
  const tokens = options.concurrentRegistration
    ? yield* Effect.gen(function* () {
        const first = yield* register.pipe(Effect.forkChild);
        const second = yield* register.pipe(Effect.forkChild);
        const token = yield* Fiber.join(first);
        yield* Deferred.succeed(firstRegistered, undefined);
        return [token, yield* Fiber.join(second)];
      })
    : [yield* register];
  const token = tokens[0]!;
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
  return {
    renewalEntered,
    renewalRelease,
    send,
    tokens,
    register,
    auth,
    credentials,
    requests,
    refreshTokens,
    body,
    expire: () => save({ ...credentials, expiresAt: 0 }),
  };
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

it.live("keeps concurrent first registrations valid and reuses the matching grant", () =>
  provide(
    Effect.gen(function* () {
      const h = yield* makeHarness({ concurrentRegistration: true });
      const results = yield* Effect.forEach(h.tokens, (token) => h.send(token));
      assert.deepEqual(
        results.map((result) => result.status),
        [200, 200],
      );
      assert.isTrue(h.tokens[0] === h.tokens[1]);
      assert.isTrue((yield* h.register) === h.tokens[0]);
      assert.equal(h.requests.length, 3);
      assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
    }),
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
  {
    name: "other 401",
    error: { error: { code: "invalid_api_key", message: "stale-access single-use-refresh" } },
    renewals: 0,
    attempts: 1,
  },
  { name: "second 401", retryStatus: 401, renewals: 1, attempts: 2 },
  { name: "renewal failure", renewalFails: true, renewals: 1, attempts: 1 },
])("terminates on $name", (options) =>
  provide(
    Effect.gen(function* () {
      const h = yield* makeHarness(options);
      const result = yield* h.send();
      assert.equal(result.status, 400);
      assert.include(result.text, "t3_managed_auth");
      for (const secret of [h.credentials.accessToken, h.credentials.refreshToken])
        assert.notInclude(result.text, secret);
      assert.equal(h.refreshTokens.length, options.renewals);
      assert.equal(h.requests.length, options.attempts);
    }),
  ),
);

it.live.each(["replacement", "earliestRefreshAt"] as const)(
  "respects %s while recovering a rejected token",
  (constraint) =>
    provide(
      Effect.gen(function* () {
        const h = yield* makeHarness({ constraint });
        const result = yield* h.send();
        assert.equal(result.status, 400);
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

it.live("failed proactive renewal is terminal without an upstream Responses request", () =>
  provide(
    Effect.gen(function* () {
      const h = yield* makeHarness({ renewalFails: true });
      yield* h.expire();
      const result = yield* h.send();
      assert.equal(result.status, 400);
      assert.include(result.text, "t3_managed_auth");
      assert.equal(h.refreshTokens.length, 1);
      assert.deepEqual(h.requests, []);
    }),
  ),
);

it.live.each([400, 403, 429, 503])("preserves upstream HTTP %s after renewal", (retryStatus) =>
  provide(
    Effect.gen(function* () {
      const h = yield* makeHarness({ retryStatus });
      const result = yield* h.send();
      assert.equal(result.status, retryStatus);
      assert.deepEqual(JSON.parse(result.text), expired);
      assert.equal(h.requests.length, 2);
      assert.equal(h.refreshTokens.length, 1);
    }),
  ),
);

it.live("persists a single-use renewal after the Responses caller disconnects", () =>
  provide(
    Effect.gen(function* () {
      const h = yield* makeHarness({ pauseRenewal: true });
      const caller = yield* h.send().pipe(Effect.forkChild);
      yield* Deferred.await(h.renewalEntered);
      yield* Fiber.interrupt(caller);
      yield* Deferred.succeed(h.renewalRelease, undefined);
      const saved = yield* h.auth.access;
      assert.equal(saved.refreshToken, "rotated-refresh");
      assert.deepEqual(h.refreshTokens, ["single-use-refresh"]);
    }),
  ),
);
