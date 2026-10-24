import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

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
    desktopLaunchId: "launch-1",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const DESCRIPTOR_URL = "http://127.0.0.1:3773/.well-known/t3/environment";

const asLaunchedBackend =
  (
    handler: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
  ) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    request.url === DESCRIPTOR_URL
      ? Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ desktopLaunchId: "launch-1" })),
        )
      : handler(request);

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(
          asLaunchedBackend((request) =>
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
        ),
      );
      const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.succeedSome(config),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const layerTest = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(layerPool, layerHttpClient)),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(layerTest));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  it.effect(
    "exchanges the current window's token when the backend was launched with a secret",
    () =>
      Effect.gen(function* () {
        const presented = yield* Ref.make<string | null>(null);
        const httpClientLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(
            asLaunchedBackend((request) => {
              const body =
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "";
              return Ref.set(presented, new URLSearchParams(body).get("subject_token")).pipe(
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
              );
            }),
          ),
        );
        const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
          list: Effect.succeed([
            {
              id: PRIMARY_LOCAL_ENVIRONMENT_ID,
              label: Effect.succeed("Windows"),
              currentConfig: Effect.succeedSome({
                ...config,
                bootstrap: { ...config.bootstrap, desktopBootstrapSecret: "desktop-secret" },
              }),
            },
          ]),
        } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);

        yield* TestClock.setTime(DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1);
        yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          return yield* auth.getBearerToken;
        }).pipe(
          Effect.provide(
            DesktopLocalEnvironmentAuth.layer.pipe(
              Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
            ),
          ),
        );

        assert.strictEqual(
          yield* Ref.get(presented),
          currentDesktopBootstrapToken("desktop-secret", DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1),
        );
      }).pipe(Effect.provide(TestClock.layer())),
  );

  const tokenResponse = (request: HttpClientRequest.HttpClientRequest) =>
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
    );
  const layerPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
    list: Effect.succeed([
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        label: Effect.succeed("Windows"),
        currentConfig: Effect.succeedSome(config),
      },
    ]),
  } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
  const makeExchange = (failures: number, failure: () => Response) =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(
          asLaunchedBackend((request) =>
            Ref.updateAndGet(requestCount, (count) => count + 1).pipe(
              Effect.map((count) =>
                count <= failures
                  ? HttpClientResponse.fromWeb(request, failure())
                  : tokenResponse(request),
              ),
            ),
          ),
        ),
      );
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(Layer.mergeAll(layerPool, layerHttpClient)),
          ),
        ),
      );
      return { auth, requestCount };
    });

  it.effect("does not retry a rejected bootstrap credential", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(1, () =>
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-1",
          },
          { status: 401 },
        ),
      );

      const fiber = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));
      const error = yield* Fiber.join(fiber);

      assert.strictEqual(error._tag, "DesktopLocalEnvironmentAuthSessionBootstrapError");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    { name: "a page that is not a T3 server", body: () => new Response("<html></html>") },
    { name: "a T3 server launched without an id", body: () => Response.json({ label: "WSL" }) },
  ])("never sends the bootstrap token to $name", ({ body }) =>
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<string>>([]);
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requests, (seen) => [...seen, `${request.method} ${request.url}`]).pipe(
            Effect.as(
              request.url === DESCRIPTOR_URL
                ? HttpClientResponse.fromWeb(request, body())
                : tokenResponse(request),
            ),
          ),
        ),
      );

      const error = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.flatMap((auth) => auth.getBearerToken),
        Effect.flip,
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(Layer.mergeAll(layerPool, layerHttpClient)),
          ),
        ),
      );

      assert.strictEqual(error._tag, "DesktopLocalEnvironmentAuthForeignServerError");
      assert.include(error.message, "port 3773");
      assert.deepEqual(yield* Ref.get(requests), [`GET ${DESCRIPTOR_URL}`]);
    }),
  );

  it.effect("uses the current backend config when retrying after a port move", () =>
    Effect.gen(function* () {
      const firstExchange = yield* Deferred.make<void>();
      let currentConfig = config;
      const requests: string[] = [];
      const credentials: string[] = [];
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(`${request.method} ${request.url}`);
          if (request.method === "GET") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  desktopLaunchId:
                    request.url === DESCRIPTOR_URL && currentConfig !== config
                      ? "foreign-launch"
                      : currentConfig.bootstrap.desktopLaunchId,
                }),
              ),
            );
          }
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          credentials.push(new URLSearchParams(body).get("subject_token") ?? "");
          return request.url === "http://127.0.0.1:3773/oauth/token"
            ? Deferred.succeed(firstExchange, void 0).pipe(
                Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 503 }))),
              )
            : Effect.succeed(tokenResponse(request));
        }),
      );
      const movingPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.sync(() => Option.some(currentConfig)),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const result = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.flatMap((auth) => auth.getBearerToken),
        Effect.result,
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(Layer.mergeAll(movingPool, layerHttpClient)),
          ),
        ),
        Effect.forkChild,
      );

      yield* Deferred.await(firstExchange);
      currentConfig = {
        ...config,
        httpBaseUrl: new URL("http://127.0.0.1:3774"),
        bootstrap: {
          ...config.bootstrap,
          port: 3774,
          desktopLaunchId: "launch-2",
          desktopBootstrapToken: "restarted-bootstrap-token",
        },
      };
      yield* TestClock.adjust(Duration.seconds(15));

      const outcome = yield* Fiber.join(result);
      assert.equal(outcome._tag, "Success");
      if (outcome._tag === "Success") {
        assert.strictEqual(outcome.success, "desktop-bearer-token");
      }
      assert.deepEqual(requests, [
        `GET ${DESCRIPTOR_URL}`,
        "POST http://127.0.0.1:3773/oauth/token",
        "GET http://127.0.0.1:3774/.well-known/t3/environment",
        "POST http://127.0.0.1:3774/oauth/token",
      ]);
      assert.deepEqual(credentials, ["desktop-bootstrap-token", "restarted-bootstrap-token"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rechecks ownership before retrying the bootstrap token exchange", () =>
    Effect.gen(function* () {
      const firstExchange = yield* Deferred.make<void>();
      const requests: string[] = [];
      let exchanged = false;
      const layerHttpClient = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          requests.push(`${request.method} ${new URL(request.url).pathname}`);
          if (request.url === DESCRIPTOR_URL) {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  desktopLaunchId: exchanged ? "another-launch" : config.bootstrap.desktopLaunchId,
                }),
              ),
            );
          }
          exchanged = true;
          return Deferred.succeed(firstExchange, void 0).pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response("", { status: 503 }))),
          );
        }),
      );
      const result = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.flatMap((auth) => auth.getBearerToken),
        Effect.result,
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(Layer.mergeAll(layerPool, layerHttpClient)),
          ),
        ),
        Effect.forkChild,
      );

      yield* Deferred.await(firstExchange);
      yield* TestClock.adjust(Duration.seconds(15));

      const outcome = yield* Fiber.join(result);
      assert.equal(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.equal(outcome.failure._tag, "DesktopLocalEnvironmentAuthForeignServerError");
      }
      assert.deepEqual(requests, [
        "GET /.well-known/t3/environment",
        "POST /oauth/token",
        "GET /.well-known/t3/environment",
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
