import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "readFile",
                    pathOrDescriptor: String(path),
                    description: "Secret file does not exist yet.",
                  });
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

// Both callers read the empty secret before either repairs it, and the second removal of the
// secret file waits until the first caller has returned its key.
const layerConcurrentEmptyRepairFileSystem = (firstReturned: Deferred.Deferred<void>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const readCountRef = yield* Ref.make(0);
      const removeCountRef = yield* Ref.make(0);
      const readBarrier = yield* Deferred.make<void>();
      const isSecretPath = (path: string) => /[\\/]session-signing-key\.bin$/.test(path);

      return {
        ...fileSystem,
        readFile: (path) =>
          isSecretPath(path)
            ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count > 2
                    ? fileSystem.readFile(path)
                    : Effect.gen(function* () {
                        if (count === 2) {
                          yield* Deferred.succeed(readBarrier, void 0);
                        }
                        yield* Deferred.await(readBarrier);
                        return yield* fileSystem.readFile(path);
                      }),
                ),
              )
            : fileSystem.readFile(path),
        remove: (path, options) =>
          isSecretPath(path)
            ? Ref.updateAndGet(removeCountRef, (count) => count + 1).pipe(
                Effect.flatMap((count) =>
                  count > 1 ? Deferred.await(firstReturned) : Effect.void,
                ),
                Effect.flatMap(() => fileSystem.remove(path, options)),
              )
            : fileSystem.remove(path, options),
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerConcurrentEmptyRepairSecretStore = (firstReturned: Deferred.Deferred<void>) =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentEmptyRepairFileSystem(firstReturned)),
  );

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ServerSecretStore.layer", (it) => {
  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("refuses a name that would leave the secrets directory", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const value = new TextEncoder().encode("planted");
      for (const name of ["marker-x/../session-signing-key", "marker-x\\..\\session-signing-key"]) {
        for (const write of [secretStore.create, secretStore.set]) {
          assert.equal((yield* write(name, value).pipe(Effect.flip))._tag, "SecretStoreNameError");
        }
        assert.equal((yield* secretStore.get(name).pipe(Effect.flip))._tag, "SecretStoreNameError");
        assert.equal(
          (yield* secretStore.remove(name).pipe(Effect.flip))._tag,
          "SecretStoreNameError",
        );
      }
      assert.isTrue(Option.isNone(yield* secretStore.get("session-signing-key")));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("replaces an empty persisted secret with a fresh random one", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* secretStore.set("session-signing-key", new Uint8Array());

      const secret = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const persisted = yield* secretStore.get("session-signing-key");

      assert.equal(secret.byteLength, 32);
      assert.deepEqual(Array.from(Option.getOrThrow(persisted)), Array.from(secret));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("keeps the repaired secret when concurrent callers find it empty", () =>
    Effect.gen(function* () {
      const firstReturned = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        yield* secretStore.set("session-signing-key", new Uint8Array());
        const getOrCreate = secretStore
          .getOrCreateRandom("session-signing-key", 32)
          .pipe(Effect.tap(() => Deferred.succeed(firstReturned, void 0)));

        const [first, second] = yield* Effect.all([getOrCreate, getOrCreate], {
          concurrency: "unbounded",
        });
        const persisted = Option.getOrThrow(yield* secretStore.get("session-signing-key"));

        assert.deepEqual(Array.from(first), Array.from(persisted));
        assert.deepEqual(Array.from(second), Array.from(persisted));
      }).pipe(Effect.provide(layerConcurrentEmptyRepairSecretStore(firstReturned)));
    }),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

  it.effect("caches reads in memory and refreshes cached values on write and remove", () =>
    Effect.gen(function* () {
      let secretReads = 0;
      const encode = (value: string) => new TextEncoder().encode(value);
      const layerCountingFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return {
            ...fileSystem,
            readFile: (path) => {
              if (/[\\/]cached-secret\.bin$/.test(String(path))) {
                secretReads += 1;
              }
              return fileSystem.readFile(path);
            },
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      const layerCountingStore = ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig()),
        Layer.provideMerge(layerCountingFileSystem),
      );

      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;

        // First missing read hits disk once, then stays cached as None.
        assert.isTrue(Option.isNone(yield* secretStore.get("cached-secret")));
        assert.isTrue(Option.isNone(yield* secretStore.get("cached-secret")));
        assert.equal(secretReads, 1);

        // `create` and `set` populate the cache so reads never re-hit disk.
        yield* secretStore.create("cached-secret", encode("initial"));
        const firstRead = Option.getOrThrow(yield* secretStore.get("cached-secret"));
        assert.equal(new TextDecoder().decode(firstRead), "initial");
        // Mutating the caller's slice must not corrupt the cached secret.
        firstRead[0] = 0;
        const secondRead = Option.getOrThrow(yield* secretStore.get("cached-secret"));
        assert.equal(new TextDecoder().decode(secondRead), "initial");
        assert.equal(secretReads, 1);

        yield* secretStore.set("cached-secret", encode("updated"));
        const updatedRead = Option.getOrThrow(yield* secretStore.get("cached-secret"));
        assert.equal(new TextDecoder().decode(updatedRead), "updated");
        assert.equal(secretReads, 1);

        yield* secretStore.remove("cached-secret");
        assert.isTrue(Option.isNone(yield* secretStore.get("cached-secret")));
        assert.equal(secretReads, 1);
      }).pipe(Effect.provide(layerCountingStore));
    }),
  );

  it.effect("does not let an overlapping cache-miss read overwrite a newer set", () =>
    Effect.gen(function* () {
      const readStarted = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      const encode = (value: string) => new TextEncoder().encode(value);
      let firstReadPaused = false;
      const layerPausedReadFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return {
            ...fileSystem,
            readFile: (path) => {
              if (!firstReadPaused && /[\\/]race-secret\.bin$/.test(String(path))) {
                firstReadPaused = true;
                return Effect.gen(function* () {
                  const bytes = yield* fileSystem.readFile(path);
                  yield* Deferred.succeed(readStarted, void 0);
                  yield* Deferred.await(releaseRead);
                  return bytes;
                });
              }
              return fileSystem.readFile(path);
            },
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      const layerRaceStore = ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig()),
        Layer.provideMerge(layerPausedReadFileSystem),
      );

      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const fileSystem = yield* FileSystem.FileSystem;
        const secretPath = `${secretStore.directory}/race-secret.bin`;
        yield* fileSystem.writeFile(secretPath, encode("stale"));

        const pausedGet = yield* secretStore.get("race-secret").pipe(Effect.forkChild);
        yield* Deferred.await(readStarted);
        yield* secretStore.set("race-secret", encode("fresh"));
        yield* Deferred.succeed(releaseRead, void 0);

        const initialRead = Option.getOrThrow(yield* Fiber.join(pausedGet));
        assert.equal(new TextDecoder().decode(initialRead), "stale");

        const latest = Option.getOrThrow(yield* secretStore.get("race-secret"));
        assert.equal(new TextDecoder().decode(latest), "fresh");
      }).pipe(Effect.provide(layerRaceStore));
    }),
  );

  it.effect("invalidates the cache when set fails after renaming the secret file", () =>
    Effect.gen(function* () {
      const encode = (value: string) => new TextEncoder().encode(value);
      const layerPostRenameChmodFailureFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          return {
            ...fileSystem,
            chmod: (path, mode) =>
              /[\\/]chmod-fail-secret\.bin$/.test(String(path))
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "chmod",
                      pathOrDescriptor: String(path),
                      description: "chmod failed after rename.",
                    }),
                  )
                : fileSystem.chmod(path, mode),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      const layerChmodFailureStore = ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig()),
        Layer.provideMerge(layerPostRenameChmodFailureFileSystem),
      );

      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        yield* secretStore.create("chmod-fail-secret", encode("previous"));

        const error = yield* Effect.flip(
          secretStore.set("chmod-fail-secret", encode("persisted-before-chmod-error")),
        );
        assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);

        const readAfterFailure = Option.getOrThrow(yield* secretStore.get("chmod-fail-secret"));
        assert.equal(new TextDecoder().decode(readAfterFailure), "persisted-before-chmod-error");
      }).pipe(Effect.provide(layerChmodFailureStore));
    }),
  );
});
