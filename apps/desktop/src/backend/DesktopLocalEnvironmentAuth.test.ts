import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

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
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
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
            currentConfig: Effect.succeedSome(config),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  it.effect("retries transient /oauth/token failures before surfacing the bootstrap error", () =>
    Effect.gen(function* () {
      // The first two attempts return a 503 (the shape a settling backend
      // produces); the third succeeds. Before the retry, a single transient
      // failure hard-failed into DesktopLocalEnvironmentAuthSessionBootstrapError.
      // A 503 flows through the real HttpApiClient pipeline and maps to
      // RemoteEnvironmentAuthUndeclaredStatusError(url, 503), which the
      // classifier treats as transient. TestClock advances the spaced schedule
      // deterministically instead of waiting out real 500ms delays.
      const requestCount = yield* Ref.make(0);
      const successResponse = (request: HttpClientRequest.HttpClientRequest) =>
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
      const transientResponse = (request: HttpClientRequest.HttpClientRequest) =>
        HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.modify(requestCount, (n) => [n + 1, n + 1]).pipe(
            Effect.flatMap((count) =>
              count <= 2
                ? Effect.succeed(transientResponse(request))
                : Effect.succeed(successResponse(request)),
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
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
      );

      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth.pipe(
        Effect.provide(testLayer),
      );
      // Fork getBearerToken so the TestClock can advance the spaced schedule
      // delays without blocking the test fiber.
      const fiber = yield* auth.getBearerToken.pipe(Effect.forkChild);
      // Two transient attempts each park for 500ms on the spaced schedule;
      // advance past both delays so the third attempt (success) can run.
      yield* TestClock.adjust(Duration.millis(500));
      yield* TestClock.adjust(Duration.millis(500));
      const token = yield* Fiber.join(fiber);
      assert.strictEqual(token, "desktop-bearer-token");
      assert.isAtLeast(yield* Ref.get(requestCount), 3);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
