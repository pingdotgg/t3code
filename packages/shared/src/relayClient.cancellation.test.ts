import { sha256 } from "@noble/hashes/sha2";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as HostProcess from "./HostProcess.ts";
import * as RelayClient from "./relayClient.ts";

const executable = `#!/bin/sh
echo 'cloudflared version ${RelayClient.CLOUDFLARED_VERSION}'
`;

const runtime = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(HostProcess.Architecture, "x64"),
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(executable))),
    ),
  ),
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "waits for a pending staging rename before cleaning up a cancelled install",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const scope = yield* Effect.scope;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cloudflared-test-" });
      const directory = `${baseDir}/tools/cloudflared/${RelayClient.CLOUDFLARED_VERSION}/linux-x64`;
      const renamePending = yield* Deferred.make<void>();
      const allowRename = yield* Deferred.make<void>();
      const renameFinished = yield* Deferred.make<void, PlatformError.PlatformError>();
      let renameWaitInterrupted = false;

      const manager = yield* RelayClient.makeCloudflaredRelayClient({
        baseDir,
        releaseAsset: {
          url: "https://example.test/cloudflared",
          sha256: Hex.encode(sha256(new TextEncoder().encode(executable))),
          archive: "binary",
        },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          rename: (from, to) =>
            to.endsWith(".tmp")
              ? Effect.gen(function* () {
                  // The filesystem operation outlives an interrupted caller, as with Node's rename.
                  yield* Effect.forkIn(
                    Deferred.complete(
                      renameFinished,
                      Deferred.await(allowRename).pipe(Effect.andThen(fileSystem.rename(from, to))),
                    ),
                    scope,
                    { uninterruptible: false },
                  );
                  yield* Deferred.succeed(renamePending, undefined);
                  yield* Deferred.await(renameFinished).pipe(
                    Effect.onInterrupt(() =>
                      Effect.sync(() => {
                        renameWaitInterrupted = true;
                      }),
                    ),
                  );
                })
              : fileSystem.rename(from, to),
          remove: (path, options) =>
            path.endsWith(".tmp")
              ? fileSystem.remove(path, options).pipe(
                  // Let a late rename land before the source directory is removed.
                  Effect.andThen(Deferred.succeed(allowRename, undefined)),
                  Effect.andThen(Deferred.await(renameFinished)),
                )
              : fileSystem.remove(path, options),
        }),
      );

      const installing = yield* manager.install.pipe(Effect.forkChild);
      yield* Deferred.await(renamePending);
      // Let the installer park on the filesystem result before interrupting it.
      yield* Effect.yieldNow;
      const cancelling = yield* Fiber.interrupt(installing).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      // If cancellation stopped the wait, let early cleanup release the rename instead.
      yield* Effect.yieldNow;
      if (!renameWaitInterrupted) {
        yield* Deferred.succeed(allowRename, undefined);
      }
      yield* Fiber.join(cancelling);
      yield* Deferred.await(renameFinished);

      expect(yield* fileSystem.readDirectory(directory)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(runtime)),
);
