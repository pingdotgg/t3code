import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
).pipe(Layer.provide(NodeServices.layer));

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
).pipe(Layer.provide(NodeServices.layer));

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
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(NodeServices.layer));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

it.layer(NodeServices.layer)("ServerSecretStore.layer", (it) => {
  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
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
});

const makeMemoryKeyring = (options: { readonly unavailable?: boolean } = {}) => {
  const entries = new Map<string, Uint8Array>();
  const unavailable = (account: string) =>
    Effect.fail(
      new ServerSecretStore.SecretStoreKeyringError({
        resource: `keyring entry ${account}`,
        cause: "No Secret Service on this session bus.",
      }),
    );
  const keyring = ServerSecretStore.SecretStoreKeyring.of({
    get: (account) =>
      options.unavailable
        ? unavailable(account)
        : Effect.sync(() => Option.fromUndefinedOr(entries.get(account))),
    set: (account, value) =>
      options.unavailable
        ? unavailable(account)
        : Effect.sync(() => void entries.set(account, Uint8Array.from(value))),
    remove: (account) => Effect.sync(() => void entries.delete(account)),
  });
  return { entries, keyring };
};

const openStore = (
  keyring: ServerSecretStore.SecretStoreKeyring["Service"],
  secretStore?: ServerConfig.SecretStoreBackend,
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* ServerSecretStore.make.pipe(
      Effect.provideService(ServerConfig.ServerConfig, { ...config, secretStore }),
      Effect.provideService(ServerSecretStore.SecretStoreKeyring, keyring),
    );
  });

const readRaw = (name: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const { secretsDir } = yield* ServerConfig.ServerConfig;
    return new TextDecoder().decode(yield* fileSystem.readFile(`${secretsDir}/${name}.bin`));
  });

const encode = (value: string) => new TextEncoder().encode(value);
const decode = (value: Option.Option<Uint8Array>) =>
  new TextDecoder().decode(Option.getOrThrow(value));

it.layer(NodeServices.layer)("ServerSecretStore keyring backend", (it) => {
  it.effect("moves secrets under a keyring key and back out again", () =>
    Effect.gen(function* () {
      const { entries, keyring } = makeMemoryKeyring();
      const plaintext = yield* openStore(keyring);
      yield* plaintext.set("relay-token", encode("before-keyring"));

      const encrypted = yield* openStore(keyring, "keyring");
      yield* encrypted.set("cli-token", encode("after-keyring"));
      assert.equal(entries.size, 1);
      assert.notInclude(yield* readRaw("relay-token"), "before-keyring");
      assert.notInclude(yield* readRaw("cli-token"), "after-keyring");

      // A CLI command sharing the home passes no backend and follows the existing key.
      const following = yield* openStore(keyring);
      assert.equal(decode(yield* following.get("relay-token")), "before-keyring");
      assert.equal(decode(yield* following.get("cli-token")), "after-keyring");

      yield* openStore(keyring, "file");
      assert.equal(entries.size, 0);
      assert.equal(yield* readRaw("relay-token"), "before-keyring");
      assert.equal(yield* readRaw("cli-token"), "after-keyring");
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("keeps plaintext files when the keyring is unavailable", () =>
    Effect.gen(function* () {
      const { keyring } = makeMemoryKeyring({ unavailable: true });
      const store = yield* openStore(keyring, "keyring");
      yield* store.set("relay-token", encode("plain"));

      assert.equal(yield* readRaw("relay-token"), "plain");
    }).pipe(Effect.provide(layerServerConfig())),
  );

  it.effect("refuses to start when the keyring lost the key", () =>
    Effect.gen(function* () {
      const { entries, keyring } = makeMemoryKeyring();
      const store = yield* openStore(keyring, "keyring");
      yield* store.set("relay-token", encode("sealed"));
      entries.clear();

      const error = yield* Effect.flip(openStore(keyring));

      assert.instanceOf(error, ServerSecretStore.SecretStoreKeyringError);
    }).pipe(Effect.provide(layerServerConfig())),
  );
});
