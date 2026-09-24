import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { getConnectionCatalog, setConnectionCatalog } from "../ipc/methods/connectionCatalog.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
function makeSafeStorageLayer(available: boolean, failDecrypt: Ref.Ref<boolean> | null = null) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      return Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (
          !decoded.startsWith("encrypted:") ||
          (failDecrypt !== null && (yield* Ref.get(failDecrypt)))
        ) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted catalog"),
          });
        }
        return decoded.slice("encrypted:".length);
      });
    },
    selectedStorageBackend: Effect.succeed(Option.none()),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function makeLayer(
  baseDir: string,
  encryptionAvailable = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
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
  const safeStorageLayer = makeSafeStorageLayer(encryptionAvailable, failDecrypt);
  const dependencies = Layer.mergeAll(
    environmentLayer,
    safeStorageLayer,
    NodeServices.layer,
    fileSystemLayer,
  );
  const savedEnvironmentsLayer = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(dependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(savedEnvironmentsLayer),
    Layer.provideMerge(dependencies),
  );
}

const withStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopConnectionCatalogStore.DesktopConnectionCatalogStore>,
  encryptionAvailable = true,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("persists, reads, and clears an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.isTrue(yield* store.set(catalog));
        assert.deepStrictEqual(yield* store.get, Option.some(catalog));

        yield* store.clear;
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
    ),
  );

  it.effect("does not persist when secure storage is unavailable", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        assert.isFalse(yield* store.set("{}"));
        assert.deepStrictEqual(yield* store.get, Option.none());
      }),
      false,
    ),
  );

  for (const corruptCatalog of [false, true]) {
    it.effect(
      `migrates legacy relay, SSH, bearer profile, and credential data${corruptCatalog ? " after quarantining a malformed catalog" : ""}`,
      () =>
        withStore(
          Effect.gen(function* () {
            const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
            const environment = yield* DesktopEnvironment.DesktopEnvironment;
            const fileSystem = yield* FileSystem.FileSystem;
            const records: readonly PersistedSavedEnvironmentRecord[] = [
              {
                environmentId: EnvironmentId.make("relay-environment"),
                label: "Relay",
                httpBaseUrl: "https://relay.example.com/",
                wsBaseUrl: "wss://relay.example.com/",
                createdAt: "2026-06-01T00:00:00.000Z",
                lastConnectedAt: null,
                relayManaged: { relayUrl: "https://relay-control.example.com/" },
              },
              {
                environmentId: EnvironmentId.make("ssh-environment"),
                label: "SSH",
                httpBaseUrl: "http://127.0.0.1:41773/",
                wsBaseUrl: "ws://127.0.0.1:41773/",
                createdAt: "2026-06-02T00:00:00.000Z",
                lastConnectedAt: null,
                desktopSsh: {
                  alias: "devbox",
                  hostname: "devbox.example.com",
                  username: "julius",
                  port: 22,
                },
              },
              {
                environmentId: EnvironmentId.make("bearer-environment"),
                label: "Bearer",
                httpBaseUrl: "https://bearer.example.com/",
                wsBaseUrl: "wss://bearer.example.com/",
                createdAt: "2026-06-03T00:00:00.000Z",
                lastConnectedAt: null,
              },
            ];
            yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
            if (corruptCatalog) {
              const path = yield* Path.Path;
              yield* fileSystem.writeFileString(
                path.join(environment.stateDir, "connection-catalog.json"),
                "\0".repeat(1552),
              );
            }
            yield* fileSystem.writeFileString(
              environment.savedEnvironmentRegistryPath,
              yield* encodeLegacySavedEnvironments({
                version: 1,
                records: records.map((record) =>
                  record.environmentId === "bearer-environment"
                    ? {
                        ...record,
                        encryptedBearerToken: Encoding.encodeBase64(
                          textEncoder.encode("encrypted:legacy-token"),
                        ),
                      }
                    : record,
                ),
              }),
            );

            const migrated = yield* store.get;
            assert.isTrue(Option.isSome(migrated));
            if (Option.isNone(migrated)) {
              return;
            }
            const catalog = yield* decodeConnectionCatalog(migrated.value);

            assert.deepInclude(catalog.targets[0], {
              _tag: "RelayConnectionTarget",
              environmentId: EnvironmentId.make("relay-environment"),
              label: "Relay",
            });
            assert.deepInclude(catalog.targets[1], {
              _tag: "SshConnectionTarget",
              environmentId: EnvironmentId.make("ssh-environment"),
              label: "SSH",
              connectionId: "ssh:ssh-environment",
            });
            assert.deepInclude(catalog.targets[2], {
              _tag: "BearerConnectionTarget",
              environmentId: EnvironmentId.make("bearer-environment"),
              label: "Bearer",
              connectionId: "bearer:bearer-environment",
            });
            assert.deepInclude(catalog.profiles[0], {
              _tag: "SshConnectionProfile",
              connectionId: "ssh:ssh-environment",
              environmentId: EnvironmentId.make("ssh-environment"),
              label: "SSH",
              target: {
                alias: "devbox",
                hostname: "devbox.example.com",
                username: "julius",
                port: 22,
              },
            });
            assert.deepInclude(catalog.profiles[1], {
              _tag: "BearerConnectionProfile",
              connectionId: "bearer:bearer-environment",
              environmentId: EnvironmentId.make("bearer-environment"),
              label: "Bearer",
              httpBaseUrl: "https://bearer.example.com/",
              wsBaseUrl: "wss://bearer.example.com/",
            });
            assert.equal(catalog.credentials.length, 1);
            assert.equal(catalog.credentials[0]?.connectionId, "bearer:bearer-environment");
            assert.equal(catalog.credentials[0]?.credential._tag, "BearerConnectionCredential");
            if (catalog.credentials[0]?.credential._tag === "BearerConnectionCredential") {
              assert.equal(catalog.credentials[0].credential.token, "legacy-token");
            }

            yield* fileSystem.writeFileString(
              environment.savedEnvironmentRegistryPath,
              '{"version":1,"records":[]}',
            );
            assert.deepEqual(yield* store.get, migrated);
          }),
        ),
    );
  }

  for (const [name, contents] of [
    ["zero-filled", "\0".repeat(1552)],
    ["empty", ""],
    ["invalid JSON", "{not-json"],
    ["truncated", '{"version":1,"encryptedCatalog":"'],
    ["invalid envelope", '{"version":1}'],
  ] as const) {
    it.effect(`recovers from ${name} catalog contents through IPC and preserves their bytes`, () =>
      withStore(
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const fileSystem = yield* FileSystem.FileSystem;
          const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
          yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
          yield* fileSystem.writeFileString(catalogPath, contents);

          assert.isNull(yield* getConnectionCatalog.handler(undefined));
          assert.isNull(yield* getConnectionCatalog.handler(undefined));
          assert.isFalse(yield* fileSystem.exists(catalogPath));
          const quarantined = (yield* fileSystem.readDirectory(environment.stateDir)).filter(
            (name) => name.startsWith("connection-catalog.json.corrupt."),
          );
          assert.equal(quarantined.length, 1);
          assert.equal(
            yield* fileSystem.readFileString(path.join(environment.stateDir, quarantined[0]!)),
            contents,
          );

          const catalog = '{"schemaVersion":1,"targets":[]}';
          assert.isTrue(yield* setConnectionCatalog.handler(catalog));
          assert.equal(yield* getConnectionCatalog.handler(undefined), catalog);
          assert.equal(
            yield* fileSystem.readFileString(path.join(environment.stateDir, quarantined[0]!)),
            contents,
          );
        }),
      ),
    );
  }

  it.effect("does not recover until the malformed file can be quarantined", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const directory = path.join(baseDir, "userdata");
      const catalogPath = path.join(directory, "connection-catalog.json");
      const contents = "\0".repeat(1552);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(catalogPath, contents);
      const failRename = yield* Ref.make(true);
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: catalogPath,
      });
      const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        rename: (from, to) =>
          Effect.gen(function* () {
            if (yield* Ref.get(failRename)) {
              return yield* permissionError;
            }
            yield* fileSystem.rename(from, to);
          }),
      });
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(makeLayer(baseDir, true, null, fileSystemLayer)),
      );

      for (let attempt = 0; attempt < 2; attempt++) {
        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreRecoveryError,
        );
        assert.equal(error.operation, "quarantine-catalog-file");
        assert.equal(error.catalogPath, catalogPath);
        assert.strictEqual(error.cause, permissionError);
        assert.equal(yield* fileSystem.readFileString(catalogPath), contents);
        assert.deepEqual(yield* fileSystem.readDirectory(directory), ["connection-catalog.json"]);
      }

      yield* Ref.set(failRename, false);
      assert.deepEqual(yield* store.get, Option.none());
      const files = yield* fileSystem.readDirectory(directory);
      assert.equal(files.length, 1);
      assert.equal(yield* fileSystem.readFileString(path.join(directory, files[0]!)), contents);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("serializes recovery with concurrent reads and writes", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.deepEqual(
          yield* Effect.all([store.get, store.get, store.set(catalog)], {
            concurrency: "unbounded",
          }),
          [Option.none(), Option.none(), true],
        );
        assert.deepEqual(yield* store.get, Option.some(catalog));
        const quarantined = (yield* fileSystem.readDirectory(environment.stateDir)).filter((name) =>
          name.startsWith("connection-catalog.json.corrupt."),
        );
        assert.equal(quarantined.length, 1);
        assert.equal(
          yield* fileSystem.readFileString(path.join(environment.stateDir, quarantined[0]!)),
          "{not-json",
        );
      }),
    ),
  );

  for (const operation of [
    "write-temporary-file",
    "sync-temporary-file",
    "replace-catalog-file",
  ] as const) {
    it.effect(`preserves the previous catalog when ${operation} fails and permits retry`, () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-connection-catalog-test-",
        });
        const directory = path.join(baseDir, "userdata");
        const catalogPath = path.join(directory, "connection-catalog.json");
        const failWrite = yield* Ref.make(false);
        const synced = yield* Ref.make(false);
        const diskError = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method: operation,
          pathOrDescriptor: catalogPath,
        });
        const failAt = (stage: typeof operation) =>
          Effect.gen(function* () {
            if (stage === operation && (yield* Ref.get(failWrite))) {
              return yield* diskError;
            }
          });
        const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
          ...fileSystem,
          writeFileString: (file, contents, options) =>
            Effect.gen(function* () {
              yield* failAt("write-temporary-file");
              yield* fileSystem.writeFileString(file, contents, options);
            }),
          open: (file, options) =>
            fileSystem.open(file, options).pipe(
              Effect.map((handle) => ({
                ...handle,
                sync: Effect.gen(function* () {
                  yield* failAt("sync-temporary-file");
                  yield* handle.sync;
                  yield* Ref.set(synced, true);
                }),
              })),
            ),
          rename: (from, to) =>
            Effect.gen(function* () {
              assert.isTrue(yield* Ref.get(synced));
              yield* failAt("replace-catalog-file");
              yield* fileSystem.rename(from, to);
            }),
        });
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(makeLayer(baseDir, true, null, fileSystemLayer)),
        );
        const previous = '{"schemaVersion":1,"targets":[]}';
        assert.isTrue(yield* store.set(previous));
        const originalBytes = yield* fileSystem.readFile(catalogPath);
        yield* Ref.set(failWrite, true);
        yield* Ref.set(synced, false);

        const error = yield* store.set("replacement").pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreWriteError,
        );
        assert.equal(error.operation, operation);
        assert.strictEqual(error.cause, diskError);
        assert.deepEqual(yield* fileSystem.readFile(catalogPath), originalBytes);
        assert.deepEqual(yield* store.get, Option.some(previous));
        assert.deepEqual(yield* fileSystem.readDirectory(directory), ["connection-catalog.json"]);

        yield* Ref.set(failWrite, false);
        yield* Ref.set(synced, false);
        assert.isTrue(yield* store.set("replacement"));
        assert.deepEqual(yield* store.get, Option.some("replacement"));
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  }

  it.effect("surfaces catalog filesystem failures instead of treating them as missing", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseFileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: path.join(baseDir, "userdata", "connection-catalog.json"),
      });
      const fileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(permissionError),
        }),
      );
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(makeLayer(baseDir, true, null, fileSystemLayer)),
      );

      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreReadError,
      );
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.strictEqual(error.cause, permissionError);
      assert.equal(
        error.message,
        `Failed to read the desktop connection catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the failed catalog write operation and path", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeDirectory",
        pathOrDescriptor: path.join(baseDir, "userdata"),
      });
      const fileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          makeDirectory: () => Effect.fail(permissionError),
        }),
      );
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(makeLayer(baseDir, true, null, fileSystemLayer)),
      );

      const error = yield* store.set("{}").pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreWriteError,
      );
      assert.equal(error.operation, "create-directory");
      assert.equal(error.path, path.join(baseDir, "userdata"));
      assert.strictEqual(error.cause, permissionError);
      assert.equal(
        error.message,
        `Desktop connection catalog write failed during create-directory at ${path.join(baseDir, "userdata")}.`,
      );
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the legacy migration stage", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreMigrationError,
        );
        assert.equal(error.operation, "read-legacy-registry");
        assert.equal(error.catalogPath, path.join(environment.stateDir, "connection-catalog.json"));
        assert.instanceOf(
          error.cause,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
        const registryError =
          error.cause as DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError;
        assert.exists(registryError.cause);
        assert.equal(
          error.message,
          `Legacy desktop saved-environment migration failed during read-legacy-registry into ${path.join(environment.stateDir, "connection-catalog.json")}.`,
        );
        assert.notEqual(error.message, registryError.message);
      }),
    ),
  );

  it.effect("reports invalid encrypted catalog data without exposing it", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, '{"version":1,"encryptedCatalog":"%%%"}\n');

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDecodeError,
        );
        assert.equal(error.resource, "encryptedCatalog");
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(
          error.message,
          `Failed to decode encryptedCatalog for the desktop connection catalog at ${catalogPath}.`,
        );
        assert.notInclude(error.message, "%%%");
        assert.equal(
          yield* fileSystem.readFileString(catalogPath),
          '{"version":1,"encryptedCatalog":"%%%"}\n',
        );
        assert.deepEqual(yield* fileSystem.readDirectory(environment.stateDir), [
          "connection-catalog.json",
        ]);
      }),
    ),
  );

  it.effect("surfaces a catalog that can no longer be decrypted without deleting it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const failDecrypt = yield* Ref.make(false);
      const layer = makeLayer(baseDir, true, failDecrypt);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layer),
      );

      assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
      yield* Ref.set(failDecrypt, true);
      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "decrypt-catalog");
      assert.equal(error.catalogPath, path.join(baseDir, "userdata", "connection-catalog.json"));
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      const decryptError = error.cause as ElectronSafeStorage.ElectronSafeStorageDecryptError;
      assert.instanceOf(decryptError.cause, Error);
      assert.equal(decryptError.cause.message, "invalid encrypted catalog");
      assert.equal(
        error.message,
        `Desktop connection catalog protection failed during decrypt-catalog at ${path.join(baseDir, "userdata", "connection-catalog.json")}.`,
      );
      assert.notEqual(error.message, decryptError.message);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
