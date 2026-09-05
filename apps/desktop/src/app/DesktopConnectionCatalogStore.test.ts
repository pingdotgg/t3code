import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const encodeEncryptedCatalogFixture = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), encryptedCatalog: Schema.String }),
  ),
);
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
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
  appName?: string,
) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion: "1.2.3",
    ...(appName === undefined ? {} : { appName }),
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

  it.effect("isolates a downstream distribution from the official encrypted catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-connection-catalog-test-",
        });
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(
            makeLayer(baseDir, true, null, NodeServices.layer, "T3 Code (Fork Alpha)"),
          ),
        );
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments.pipe(
          Effect.provide(
            makeLayer(baseDir, true, null, NodeServices.layer, "T3 Code (Fork Alpha)"),
          ),
        );
        const officialCatalogPath = `${baseDir}/userdata/connection-catalog.json`;
        const downstreamCatalogPath = `${baseDir}/userdata/connection-catalog.fork-8e5b1a73152cf01c1ce614f31711fc4159e8ecc177cd4c02975ed0145b3d3d45.json`;

        yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
        yield* fileSystem.writeFileString(officialCatalogPath, "official-ciphertext");
        yield* savedEnvironments.setRegistry([
          {
            environmentId: EnvironmentId.make("legacy-bearer-environment"),
            label: "Legacy bearer",
            httpBaseUrl: "https://legacy.example.com/",
            wsBaseUrl: "wss://legacy.example.com/",
            createdAt: "2026-06-01T00:00:00.000Z",
            lastConnectedAt: null,
          },
        ]);
        assert.deepStrictEqual(yield* store.get, Option.none());
        assert.isFalse(yield* fileSystem.exists(downstreamCatalogPath));
        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
        assert.equal(yield* fileSystem.readFileString(officialCatalogPath), "official-ciphertext");
        assert.isTrue(yield* fileSystem.exists(downstreamCatalogPath));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("moves a readable stage-named downstream catalog to its stable identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-connection-catalog-test-",
        });
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(
            makeLayer(baseDir, true, null, NodeServices.layer, "T3 Code (Fork Nightly)"),
          ),
        );
        const catalog = '{"schemaVersion":1,"targets":[]}';
        const legacyPath = `${baseDir}/userdata/connection-catalog.0054003300200043006f00640065002000280046006f0072006b0020004e0069006700680074006c00790029.json`;
        const stablePath = `${baseDir}/userdata/connection-catalog.fork-8e5b1a73152cf01c1ce614f31711fc4159e8ecc177cd4c02975ed0145b3d3d45.json`;
        const encryptedCatalog = Buffer.from(`encrypted:${catalog}`, "utf8").toString("base64");

        yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
        yield* fileSystem.writeFileString(
          legacyPath,
          `{"version":1,"encryptedCatalog":"${encryptedCatalog}"}`,
        );

        assert.deepStrictEqual(yield* store.get, Option.some(catalog));
        assert.isTrue(yield* fileSystem.exists(stablePath));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );

  it.effect("serializes legacy migration with a concurrent catalog save", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-catalog-race-" });
      const decryptStarted = yield* Deferred.make<void>();
      const releaseDecrypt = yield* Deferred.make<void>();
      const saveStarted = yield* Deferred.make<void>();
      const operations: string[] = [];
      const oldCatalog = '{"schemaVersion":1,"targets":[]}';
      const newCatalog = '{"schemaVersion":1,"targets":[],"profiles":[]}';
      const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
        isEncryptionAvailable: Effect.succeed(true),
        selectedStorageBackend: Effect.succeed(Option.none()),
        encryptString: (value) =>
          Effect.sync(() => {
            operations.push(value === oldCatalog ? "migrate" : "save");
            return textEncoder.encode(`encrypted:${value}`);
          }),
        decryptString: (value) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(decryptStarted, undefined);
            yield* Deferred.await(releaseDecrypt);
            return textDecoder.decode(value).slice("encrypted:".length);
          }),
      });
      const environmentLayer = DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "darwin",
        processArch: "arm64",
        appVersion: "1.2.3",
        appName: "T3 Code (Fork Nightly)",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
        ),
      );
      const dependencies = Layer.mergeAll(environmentLayer, safeStorageLayer, NodeServices.layer);
      const saved = DesktopSavedEnvironments.layer.pipe(Layer.provideMerge(dependencies));
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(DesktopConnectionCatalogStore.layer.pipe(Layer.provide(saved))),
      );
      const environment = yield* DesktopEnvironment.DesktopEnvironment.pipe(
        Effect.provide(environmentLayer),
      );
      const legacyPath = environment.legacyConnectionCatalogPaths[0]!;
      yield* fileSystem.makeDirectory(`${baseDir}/userdata`, { recursive: true });
      yield* fileSystem.writeFileString(
        legacyPath,
        yield* encodeEncryptedCatalogFixture({
          version: 1,
          encryptedCatalog: Buffer.from(`encrypted:${oldCatalog}`).toString("base64"),
        }),
      );
      const reading = yield* Effect.forkChild(store.get);
      yield* Deferred.await(decryptStarted);
      const saving = yield* Effect.forkChild(
        Deferred.succeed(saveStarted, undefined).pipe(Effect.andThen(store.set(newCatalog))),
      );
      yield* Deferred.await(saveStarted);
      yield* Effect.yieldNow;
      assert.deepEqual(operations, []);
      yield* Deferred.succeed(releaseDecrypt, undefined);
      yield* Fiber.join(reading);
      yield* Fiber.join(saving);
      assert.deepEqual(operations, ["migrate", "save"]);
      assert.deepEqual(yield* store.get, Option.some(newCatalog));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("migrates legacy relay, SSH, bearer profile, and credential data", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
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
        yield* savedEnvironments.setRegistry(records);
        assert.isTrue(
          yield* savedEnvironments.setSecret({
            environmentId: EnvironmentId.make("bearer-environment"),
            secret: "legacy-token",
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

        yield* savedEnvironments.setRegistry([]);
        assert.deepEqual(yield* store.get, migrated);
      }),
    ),
  );

  it.effect("surfaces malformed catalog documents without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(catalogPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(error.catalogPath, catalogPath);
        assert.exists(error.cause);
        assert.equal(yield* fileSystem.readFileString(catalogPath), "{not-json");
      }),
    ),
  );

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
