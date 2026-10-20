import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect(
    "shares cached and renewed bearers, deriving the current bootstrap token after suspend",
    () =>
      Effect.gen(function* () {
        const presented = yield* Ref.make<Array<string | null>>([]);
        const layerHttpClient = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const body =
                request.body._tag === "Uint8Array"
                  ? new TextDecoder().decode(request.body.body)
                  : "";
              const credentials = yield* Ref.updateAndGet(presented, (tokens) => [
                ...tokens,
                new URLSearchParams(body).get("subject_token"),
              ]);
              yield* Effect.yieldNow;
              return tokenResponse(request, `desktop-bearer-token-${credentials.length}`);
            }),
          ),
        );
        const layerSecretPool = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
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
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
          Effect.provide(
            DesktopLocalEnvironmentAuth.layer.pipe(
              Layer.provide(Layer.mergeAll(layerSecretPool, layerHttpClient)),
            ),
          ),
        );
        const concurrentReads = Effect.all([auth.getBearerToken, auth.getBearerToken], {
          concurrency: "unbounded",
        });
        const start = DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS * 2 + 1;
        yield* TestClock.setTime(start);

        assert.deepStrictEqual(yield* concurrentReads, [
          "desktop-bearer-token-1",
          "desktop-bearer-token-1",
        ]);
        yield* TestClock.adjust(Duration.seconds(3_539));
        assert.strictEqual(yield* auth.getBearerToken, "desktop-bearer-token-1");
        assert.deepStrictEqual(yield* Ref.get(presented), [
          currentDesktopBootstrapToken("desktop-secret", start),
        ]);

        yield* TestClock.adjust(Duration.seconds(2));
        assert.deepStrictEqual(yield* concurrentReads, [
          "desktop-bearer-token-2",
          "desktop-bearer-token-2",
        ]);
        assert.deepStrictEqual(yield* Ref.get(presented), [
          currentDesktopBootstrapToken("desktop-secret", start),
          currentDesktopBootstrapToken("desktop-secret", start + 3_541_000),
        ]);

        yield* TestClock.adjust(Duration.days(31));
        assert.deepStrictEqual(yield* concurrentReads, [
          "desktop-bearer-token-3",
          "desktop-bearer-token-3",
        ]);
        assert.deepStrictEqual(yield* Ref.get(presented), [
          currentDesktopBootstrapToken("desktop-secret", start),
          currentDesktopBootstrapToken("desktop-secret", start + 3_541_000),
          currentDesktopBootstrapToken(
            "desktop-secret",
            start + 3_541_000 + Duration.toMillis(Duration.days(31)),
          ),
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  const tokenResponse = (
    request: HttpClientRequest.HttpClientRequest,
    accessToken = "desktop-bearer-token",
  ) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(
        JSON.stringify({
          access_token: accessToken,
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
        HttpClient.make((request) =>
          Ref.updateAndGet(requestCount, (count) => count + 1).pipe(
            Effect.map((count) =>
              count <= failures
                ? HttpClientResponse.fromWeb(request, failure())
                : tokenResponse(request),
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

  it.effect("retries a backend that is still starting", () =>
    Effect.gen(function* () {
      const { auth, requestCount } = yield* makeExchange(
        2,
        () => new Response("", { status: 503 }),
      );

      const fiber = yield* auth.getBearerToken.pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(1));

      assert.strictEqual(yield* Fiber.join(fiber), "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

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
});
