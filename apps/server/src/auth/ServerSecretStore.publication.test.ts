import * as NodeServices from "@effect/platform-node/NodeServices";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const configLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-publication-test-" });

it.layer(NodeServices.layer)("secret publication", (it) => {
  it.effect("does not expose a secret until its complete contents are written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writing = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            fs.open(path, options).pipe(
              Effect.map((file) => ({
                ...file,
                sync: file.sync,
                writeAll: (bytes) =>
                  Deferred.succeed(writing, undefined).pipe(
                    Effect.andThen(Deferred.await(resume)),
                    Effect.andThen(file.writeAll(bytes)),
                  ),
              })),
            ),
        }),
      );
      const value = Uint8Array.from([1, 2, 3, 4]);
      const writer = yield* store.create("signing-key", value).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const duringWrite = yield* store.get("signing-key");
      yield* Deferred.succeed(resume, undefined);
      yield* Fiber.join(writer);
      assert.isTrue(Option.isNone(duringWrite));
      assert.deepEqual(Option.getOrThrow(yield* store.get("signing-key")), value);
    }).pipe(Effect.provide(configLayer())),
  );

  it.effect("concurrent generators both return the complete winning secret", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const writing = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let firstWrite = true;
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            fs.open(path, options).pipe(
              Effect.map((file) => ({
                ...file,
                sync: file.sync,
                writeAll: Effect.fn(function* (bytes) {
                  if (firstWrite) {
                    firstWrite = false;
                    yield* Deferred.succeed(writing, undefined);
                    yield* Deferred.await(resume);
                  }
                  yield* file.writeAll(bytes);
                }),
              })),
            ),
        }),
      );
      const first = yield* store.getOrCreateRandom("signing-key", 32).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const second = yield* store.getOrCreateRandom("signing-key", 32);
      yield* Deferred.succeed(resume, undefined);
      const firstValue = yield* Fiber.join(first);
      assert.lengthOf(second, 32);
      assert.deepEqual(firstValue, second);
      assert.deepEqual(Option.getOrThrow(yield* store.get("signing-key")), second);
    }).pipe(Effect.provide(configLayer())),
  );

  it.effect("failed partial writes leave no secret and allow a later create", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      let failWrite = true;
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            fs.open(path, options).pipe(
              Effect.map((file) => ({
                ...file,
                sync: file.sync,
                writeAll: Effect.fn(function* (bytes) {
                  if (failWrite) {
                    failWrite = false;
                    yield* file.writeAll(bytes.subarray(0, 2));
                    return yield* PlatformError.systemError({
                      _tag: "Unknown",
                      module: "FileSystem",
                      method: "writeAll",
                      pathOrDescriptor: path,
                      description: "Injected write failure",
                    });
                  }
                  yield* file.writeAll(bytes);
                }),
              })),
            ),
        }),
      );
      const value = Uint8Array.from([1, 2, 3, 4]);
      const error = yield* store.create("signing-key", value).pipe(Effect.flip);
      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.isTrue(Option.isNone(yield* store.get("signing-key")));
      assert.deepEqual(yield* fs.readDirectory(config.secretsDir), []);
      yield* store.create("signing-key", value);
      assert.deepEqual(Option.getOrThrow(yield* store.get("signing-key")), value);
    }).pipe(Effect.provide(configLayer())),
  );

  it.effect("interrupted writes do not leave a key or temporary files behind", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const writing = yield* Deferred.make<void>();
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            fs.open(path, options).pipe(
              Effect.map((file) => ({
                ...file,
                sync: file.sync,
                writeAll: () =>
                  Deferred.succeed(writing, undefined).pipe(Effect.andThen(Effect.never)),
              })),
            ),
        }),
      );
      const writer = yield* store
        .create("signing-key", Uint8Array.from([1, 2, 3]))
        .pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      yield* Fiber.interrupt(writer);
      assert.isTrue(Option.isNone(yield* store.get("signing-key")));
      assert.deepEqual(yield* fs.readDirectory(config.secretsDir), []);
    }).pipe(Effect.provide(configLayer())),
  );

  it.effect("a sync failure does not publish an unflushed secret", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const store = yield* ServerSecretStore.make.pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          open: (path, options) =>
            fs.open(path, options).pipe(
              Effect.map((file) => ({
                ...file,
                writeAll: (bytes) => file.writeAll(bytes),
                sync: Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "FileSystem",
                    method: "sync",
                    pathOrDescriptor: path,
                    description: "Injected sync failure",
                  }),
                ),
              })),
            ),
        }),
      );
      const error = yield* store.create("signing-key", new Uint8Array(32)).pipe(Effect.flip);
      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.isTrue(Option.isNone(yield* store.get("signing-key")));
      assert.deepEqual(yield* fs.readDirectory(config.secretsDir), []);
    }).pipe(Effect.provide(configLayer())),
  );

  it.effect("a losing creator leaves the existing key intact and removes its temporary data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const store = yield* ServerSecretStore.make;
      const winner = Uint8Array.from([1, 2, 3, 4]);
      yield* store.create("signing-key", winner);
      const loser = yield* store
        .create("signing-key", Uint8Array.from([5, 6, 7, 8]))
        .pipe(Effect.flip);
      assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(loser));
      assert.deepEqual(Option.getOrThrow(yield* store.get("signing-key")), winner);
      assert.deepEqual(yield* fs.readDirectory(config.secretsDir), ["signing-key.bin"]);
      const stat = yield* fs.stat(`${config.secretsDir}/signing-key.bin`);
      if ((yield* HostProcessPlatform) !== "win32") assert.equal(stat.mode & 0o777, 0o600);
    }).pipe(Effect.provide(configLayer())),
  );
});
