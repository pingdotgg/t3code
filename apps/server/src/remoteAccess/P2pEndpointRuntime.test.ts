import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import createTestnet from "hyperdht/testnet";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as P2pEndpointRuntime from "./P2pEndpointRuntime.ts";

const TEST_TIMEOUT_MS = 30_000;

const acquireTestnetBootstrap = Effect.acquireRelease(
  Effect.promise(() => createTestnet(3)),
  (testnet) => Effect.promise(() => testnet.destroy()),
).pipe(Effect.map((testnet) => testnet.bootstrap.map(({ host, port }) => `${host}:${port}`)));

const makeRuntimeLayer = (baseDir: string) =>
  P2pEndpointRuntime.layer.pipe(
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(NodeServices.layer),
  );

const announceOnce = (baseDir: string, bootstrap: ReadonlyArray<string>, targetPort: number) =>
  Effect.gen(function* () {
    const runtime = yield* P2pEndpointRuntime.P2pEndpointRuntime;
    const status = yield* runtime.ensure({ targetPort, bootstrap });
    assert.strictEqual(status.status, "announced");
    if (status.status !== "announced") {
      return "";
    }
    const observed = yield* runtime.status;
    assert.deepStrictEqual(observed, status);
    yield* runtime.disable;
    assert.deepStrictEqual(yield* runtime.status, { status: "disabled" });
    return status.publicKeyZ32;
  }).pipe(Effect.provide(makeRuntimeLayer(baseDir)));

describe("P2pEndpointRuntime", () => {
  it.effect(
    "announces with an identity that persists across runtime restarts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-p2p-runtime-test-" });
        const bootstrap = yield* acquireTestnetBootstrap;

        const firstKey = yield* announceOnce(baseDir, bootstrap, 43_210);
        const secondKey = yield* announceOnce(baseDir, bootstrap, 43_211);
        assert.strictEqual(secondKey, firstKey);

        const seedPath = path.join(
          baseDir,
          "userdata",
          "secrets",
          `${P2pEndpointRuntime.P2P_ENDPOINT_SEED_SECRET}.bin`,
        );
        const seedInfo = yield* fs.stat(seedPath);
        assert.strictEqual(seedInfo.size, 32n);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    TEST_TIMEOUT_MS,
  );

  it.effect("degrades to unavailable when the seed cannot be read", () =>
    Effect.gen(function* () {
      const runtime = yield* P2pEndpointRuntime.P2pEndpointRuntime;
      const status = yield* runtime.ensure({ targetPort: 43_212, bootstrap: [] });
      assert.strictEqual(status.status, "unavailable");
      assert.deepStrictEqual(yield* runtime.status, status);
    }).pipe(
      Effect.provide(
        P2pEndpointRuntime.layer.pipe(
          Layer.provide(
            ServerSecretStore.layer.pipe(
              Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-p2p-secrets-" })),
              Layer.provideMerge(
                Layer.effect(
                  FileSystem.FileSystem,
                  Effect.gen(function* () {
                    const fileSystem = yield* FileSystem.FileSystem;
                    return {
                      ...fileSystem,
                      readFile: (readPath) =>
                        Effect.fail(
                          PlatformError.systemError({
                            _tag: "PermissionDenied",
                            module: "FileSystem",
                            method: "readFile",
                            pathOrDescriptor: readPath,
                            description: "Permission denied while reading the seed.",
                          }),
                        ),
                    } satisfies FileSystem.FileSystem;
                  }),
                ).pipe(Layer.provide(NodeServices.layer)),
              ),
            ),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-p2p-secrets-" })),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
});
