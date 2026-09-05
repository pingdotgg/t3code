import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
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
  it.effect("does not exchange a credential when the backend stops before readiness", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            currentConfig: Effect.succeed(Option.some(config)),
            waitForReady: () => Effect.succeed(false),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.andThen(Effect.die("unexpected HTTP request before readiness")),
          ),
        ),
      );
      const error = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.flip(auth.getBearerToken);
      }).pipe(
        Effect.provide(
          DesktopLocalEnvironmentAuth.layer.pipe(
            Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
          ),
        ),
      );
      assert.equal(error._tag, "DesktopLocalEnvironmentAuthBackendStoppedError");
      assert.equal(yield* Ref.get(requestCount), 0);
    }),
  );

  it.effect(
    "waits for backend readiness and exchanges the desktop bootstrap credential only once",
    () =>
      Effect.gen(function* () {
        const requestCount = yield* Ref.make(0);
        const waiting = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<boolean>();
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
              waitForReady: (timeout: Duration.Duration) =>
                Deferred.succeed(waiting, undefined).pipe(
                  Effect.andThen(Deferred.await(ready)),
                  Effect.timeoutOption(timeout),
                  Effect.map(Option.getOrElse(() => false)),
                ),
            },
          ]),
        } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
        const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
          Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
        );

        const [first, second] = yield* Effect.gen(function* () {
          const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
          const authentication = yield* Effect.all([auth.getBearerToken, auth.getBearerToken], {
            concurrency: 2,
          }).pipe(Effect.forkChild);
          yield* Deferred.await(waiting);
          yield* TestClock.adjust("2 minutes");
          assert.strictEqual(yield* Ref.get(requestCount), 0);
          yield* Deferred.succeed(ready, true);
          return yield* Fiber.join(authentication);
        }).pipe(Effect.provide(testLayer));

        assert.strictEqual(first, "desktop-bearer-token");
        assert.strictEqual(second, "desktop-bearer-token");
        assert.strictEqual(yield* Ref.get(requestCount), 1);
      }),
  );
});
