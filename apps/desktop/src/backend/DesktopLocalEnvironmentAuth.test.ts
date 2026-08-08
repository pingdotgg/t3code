import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";
import * as DesktopLocalEnvironmentAuthTokenStore from "./DesktopLocalEnvironmentAuthTokenStore.ts";

const config = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

type SessionValidationResult = "authenticated" | "unauthenticated" | "error";

const readToken = DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
  Effect.flatMap((auth) => auth.getBearerToken),
);

function makePersistedSessionTestLayer(input: {
  readonly requests: Ref.Ref<ReadonlyArray<string>>;
  readonly persistedToken: Ref.Ref<Option.Option<string>>;
  readonly tokenStoreOperations: Ref.Ref<ReadonlyArray<string>>;
  readonly tokenStoreReadError?: DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStoreError;
  readonly bootstrapExpiresInSeconds?: number;
  readonly sessionValidationResult: SessionValidationResult;
}) {
  const httpClientLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const response = request.url.endsWith("/oauth/token")
        ? Response.json({
            access_token: "desktop-bearer-token",
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: input.bootstrapExpiresInSeconds ?? 3600,
            scope: "orchestration:read",
          })
        : input.sessionValidationResult === "error"
          ? Response.json({ error: "temporary failure" }, { status: 500 })
          : Response.json({
              authenticated: input.sessionValidationResult === "authenticated",
              auth: {
                policy: "desktop-managed-local",
                bootstrapMethods: ["desktop-bootstrap"],
                sessionMethods: ["bearer-access-token"],
                sessionCookieName: "t3_session",
              },
              ...(input.sessionValidationResult === "authenticated"
                ? {
                    scopes: ["orchestration:read"],
                    sessionMethod: "bearer-access-token",
                    expiresAt: "2100-01-01T00:00:00.000Z",
                  }
                : {}),
            });
      return Ref.update(input.requests, (current) => [...current, request.url]).pipe(
        Effect.as(HttpClientResponse.fromWeb(request, response)),
      );
    }),
  );
  const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed([
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        label: Effect.succeed("Windows"),
        currentConfig: Effect.succeed(Option.some(config)),
      },
    ]),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
  const tokenStoreLayer = Layer.succeed(
    DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore,
    {
      get: Ref.update(input.tokenStoreOperations, (operations) => [...operations, "get"]).pipe(
        Effect.andThen(
          input.tokenStoreReadError === undefined
            ? Ref.get(input.persistedToken)
            : Effect.fail(input.tokenStoreReadError),
        ),
      ),
      set: (token) =>
        Effect.gen(function* () {
          yield* Ref.update(input.tokenStoreOperations, (operations) => [
            ...operations,
            `set:${token}`,
          ]);
          yield* Ref.set(input.persistedToken, Option.some(token));
          return true;
        }),
      clear: Ref.update(input.tokenStoreOperations, (operations) => [...operations, "clear"]).pipe(
        Effect.andThen(Ref.set(input.persistedToken, Option.none())),
      ),
    },
  );

  return DesktopLocalEnvironmentAuth.layer.pipe(
    Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer, tokenStoreLayer)),
  );
}

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const persistedToken = yield* Ref.make(Option.none<string>());
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: "desktop-bearer-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      );
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.succeed(Option.some(config)),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const tokenStoreLayer = Layer.succeed(
        DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore,
        {
          get: Ref.get(persistedToken),
          set: (token) => Ref.set(persistedToken, Option.some(token)).pipe(Effect.as(true)),
          clear: Ref.set(persistedToken, Option.none()),
        },
      );
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer, tokenStoreLayer)),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
      assert.deepStrictEqual(yield* Ref.get(persistedToken), Option.some("desktop-bearer-token"));
    }),
  );

  it.effect("reuses a persisted bearer session after the desktop service restarts", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const persistedToken = yield* Ref.make(Option.none<string>());
      const tokenStoreOperations = yield* Ref.make<ReadonlyArray<string>>([]);
      const testLayer = makePersistedSessionTestLayer({
        requests,
        persistedToken,
        tokenStoreOperations,
        sessionValidationResult: "authenticated",
      });

      assert.strictEqual(yield* readToken.pipe(Effect.provide(testLayer)), "desktop-bearer-token");
      assert.strictEqual(yield* readToken.pipe(Effect.provide(testLayer)), "desktop-bearer-token");
      assert.deepStrictEqual(yield* Ref.get(requests), [
        "http://127.0.0.1:3773/oauth/token",
        "http://127.0.0.1:3773/api/auth/session",
      ]);
      assert.deepStrictEqual(yield* Ref.get(tokenStoreOperations), [
        "get",
        "set:desktop-bearer-token",
        "get",
      ]);
      assert.deepStrictEqual(yield* Ref.get(persistedToken), Option.some("desktop-bearer-token"));
    }),
  );

  it.effect("replaces an unauthenticated persisted bearer session", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const persistedToken = yield* Ref.make(Option.some("stale-bearer-token"));
      const tokenStoreOperations = yield* Ref.make<ReadonlyArray<string>>([]);
      const testLayer = makePersistedSessionTestLayer({
        requests,
        persistedToken,
        tokenStoreOperations,
        sessionValidationResult: "unauthenticated",
      });

      assert.strictEqual(yield* readToken.pipe(Effect.provide(testLayer)), "desktop-bearer-token");
      assert.deepStrictEqual(yield* Ref.get(requests), [
        "http://127.0.0.1:3773/api/auth/session",
        "http://127.0.0.1:3773/oauth/token",
      ]);
      assert.deepStrictEqual(yield* Ref.get(tokenStoreOperations), [
        "get",
        "clear",
        "set:desktop-bearer-token",
      ]);
      assert.deepStrictEqual(yield* Ref.get(persistedToken), Option.some("desktop-bearer-token"));
    }),
  );

  it.effect("preserves a persisted token when session validation fails transiently", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const persistedToken = yield* Ref.make(Option.some("desktop-bearer-token"));
      const tokenStoreOperations = yield* Ref.make<ReadonlyArray<string>>([]);
      const testLayer = makePersistedSessionTestLayer({
        requests,
        persistedToken,
        tokenStoreOperations,
        sessionValidationResult: "error",
      });

      const error = yield* readToken.pipe(Effect.provide(testLayer), Effect.flip);

      assert.instanceOf(
        error,
        DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuthSessionValidationError,
      );
      assert.deepStrictEqual(yield* Ref.get(requests), ["http://127.0.0.1:3773/api/auth/session"]);
      assert.deepStrictEqual(yield* Ref.get(tokenStoreOperations), ["get"]);
      assert.deepStrictEqual(yield* Ref.get(persistedToken), Option.some("desktop-bearer-token"));
    }),
  );

  it.effect("does not create a session when reading the persisted token fails", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const persistedToken = yield* Ref.make(Option.some("desktop-bearer-token"));
      const tokenStoreOperations = yield* Ref.make<ReadonlyArray<string>>([]);
      const tokenStoreReadError =
        new DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStoreError({
          operation: "read",
          path: "/tmp/t3/desktop-local-auth.json",
          cause: new Error("temporary read failure"),
        });
      const testLayer = makePersistedSessionTestLayer({
        requests,
        persistedToken,
        tokenStoreOperations,
        tokenStoreReadError,
        sessionValidationResult: "authenticated",
      });

      const error = yield* readToken.pipe(Effect.provide(testLayer), Effect.flip);

      assert.strictEqual(error, tokenStoreReadError);
      assert.deepStrictEqual(yield* Ref.get(requests), []);
      assert.deepStrictEqual(yield* Ref.get(tokenStoreOperations), ["get"]);
      assert.deepStrictEqual(yield* Ref.get(persistedToken), Option.some("desktop-bearer-token"));
    }),
  );

  it.effect("replaces the cached bearer token after it expires", () =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const persistedToken = yield* Ref.make(Option.none<string>());
      const tokenStoreOperations = yield* Ref.make<ReadonlyArray<string>>([]);
      const testLayer = makePersistedSessionTestLayer({
        requests,
        persistedToken,
        tokenStoreOperations,
        bootstrapExpiresInSeconds: 1,
        sessionValidationResult: "unauthenticated",
      });

      yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token");
        assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token");
        yield* TestClock.adjust("1 second");
        assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token");
      }).pipe(Effect.provide(testLayer));

      assert.deepStrictEqual(yield* Ref.get(requests), [
        "http://127.0.0.1:3773/oauth/token",
        "http://127.0.0.1:3773/api/auth/session",
        "http://127.0.0.1:3773/oauth/token",
      ]);
      assert.deepStrictEqual(yield* Ref.get(tokenStoreOperations), [
        "get",
        "set:desktop-bearer-token",
        "get",
        "clear",
        "set:desktop-bearer-token",
      ]);
    }),
  );
});
