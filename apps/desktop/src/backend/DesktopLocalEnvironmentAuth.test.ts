import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@t3tools/contracts";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
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

function makeLayer(baseDir: string, requestCount: Ref.Ref<number>) {
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

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  const dependencies = Layer.mergeAll(
    poolLayer,
    httpClientLayer,
    environmentLayer,
    NodeServices.layer,
  );

  return Layer.mergeAll(
    DesktopLocalEnvironmentAuth.layer.pipe(Layer.provide(dependencies)),
    environmentLayer,
  );
}

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once per persisted instance id", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-local-auth-test-",
      });
      const requestCount = yield* Ref.make(0);

      const exchangeTwiceAndReadInstanceId = Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const path = yield* Path.Path;
        const [first, second] = yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);

        assert.strictEqual(first, "desktop-bearer-token");
        assert.strictEqual(second, "desktop-bearer-token");

        const instanceIdPath = path.join(environment.stateDir, "client-instance-id");
        return yield* fileSystem.readFileString(instanceIdPath);
      }).pipe(Effect.provide(makeLayer(baseDir, requestCount)));

      const storedInstanceId = yield* exchangeTwiceAndReadInstanceId;

      assert.strictEqual(storedInstanceId.trim().length > 0, true);
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
