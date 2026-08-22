import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
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
const catalogPathFor = (path: Path.Path, stateDir: string) =>
  path.join(stateDir, "connection-catalog.json");
const stateDirFor = (path: Path.Path, baseDir: string) => path.join(baseDir, "userdata");
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
function makeSafeStorageLayer(
  available:
    | boolean
    | Effect.Effect<boolean, ElectronSafeStorage.ElectronSafeStorageAvailabilityError>,
  failDecrypt: Ref.Ref<boolean> | null = null,
) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: typeof available === "boolean" ? Effect.succeed(available) : available,
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
  encryptionAvailable:
    | boolean
    | Effect.Effect<boolean, ElectronSafeStorage.ElectronSafeStorageAvailabilityError> = true,
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

  it.effect("quarantines malformed catalog documents and treats them as missing", () =>
    withStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = catalogPathFor(path, environment.stateDir);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });

        const corruptDocuments = ["\0".repeat(64), '{"version":1}'] as const;
        yield* fileSystem.writeFileString(catalogPath, corruptDocuments[0]);
        assert.deepStrictEqual(yield* store.get, Option.none());
        yield* fileSystem.writeFileString(catalogPath, corruptDocuments[1]);
        assert.deepStrictEqual(yield* store.get, Option.none());

        const quarantineNames = (yield* fileSystem.readDirectory(environment.stateDir)).filter(
          (name) => name.startsWith("connection-catalog.json.corrupt."),
        );
        assert.lengthOf(quarantineNames, 2);
        assert.notEqual(quarantineNames[0], quarantineNames[1]);
        quarantineNames.forEach((name) =>
          assert.match(name, /^connection-catalog\.json\.corrupt\.\d+\.[a-f0-9]{32}$/),
        );
        const quarantinedContents = yield* Effect.all(
          quarantineNames.map((name) =>
            fileSystem.readFileString(path.join(environment.stateDir, name)),
          ),
        );
        assert.deepEqual(quarantinedContents.sort(), [...corruptDocuments].sort());
        assert.isFalse(yield* fileSystem.exists(catalogPath));
      }),
    ),
  );

  it.effect("continues when a malformed catalog cannot be quarantined", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const catalogPath = catalogPathFor(path, stateDirFor(path, baseDir));
      const quarantineError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "rename",
        pathOrDescriptor: catalogPath,
      });
      yield* baseFileSystem.makeDirectory(stateDirFor(path, baseDir), { recursive: true });
      yield* baseFileSystem.writeFileString(catalogPath, "{not-json");
      const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
        ...baseFileSystem,
        rename: (oldPath, newPath) =>
          String(oldPath) === catalogPath && String(newPath).startsWith(`${catalogPath}.corrupt.`)
            ? Effect.fail(quarantineError)
            : baseFileSystem.rename(oldPath, newPath),
      } satisfies FileSystem.FileSystem);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(makeLayer(baseDir, true, null, fileSystemLayer)),
      );
      const logMessages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        logMessages.push(message);
      });

      assert.deepStrictEqual(
        yield* store.get.pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
        Option.none(),
      );
      assert.equal(yield* baseFileSystem.readFileString(catalogPath), "{not-json");
      assert.lengthOf(logMessages, 1);
      const logMessage = logMessages[0];
      if (!Array.isArray(logMessage)) {
        return assert.fail("expected structured warning arguments");
      }
      assert.equal(
        logMessage[0],
        "Could not quarantine a corrupt desktop connection catalog; continuing without it.",
      );
      const logDetails = logMessage[1];
      if (logDetails === null || typeof logDetails !== "object") {
        return assert.fail("expected structured warning metadata");
      }
      assert.sameMembers(Object.keys(logDetails), [
        "catalogPath",
        "decodeError",
        "quarantineError",
      ]);
      assert.equal("catalogPath" in logDetails ? logDetails.catalogPath : undefined, catalogPath);
      const decodeError = "decodeError" in logDetails ? logDetails.decodeError : undefined;
      const loggedQuarantineError =
        "quarantineError" in logDetails ? logDetails.quarantineError : undefined;
      assert.isString(decodeError);
      assert.isString(loggedQuarantineError);
      assert.notInclude(decodeError, "{not-json");
      assert.notInclude(loggedQuarantineError, "{not-json");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("surfaces catalog filesystem failures instead of treating them as missing", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: catalogPathFor(path, stateDirFor(path, baseDir)),
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
      assert.equal(error.catalogPath, catalogPathFor(path, stateDirFor(path, baseDir)));
      assert.strictEqual(error.cause, permissionError);
      assert.equal(
        error.message,
        `Failed to read the desktop connection catalog at ${catalogPathFor(path, stateDirFor(path, baseDir))}.`,
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
        pathOrDescriptor: stateDirFor(path, baseDir),
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
      assert.equal(error.path, stateDirFor(path, baseDir));
      assert.strictEqual(error.cause, permissionError);
      assert.equal(
        error.message,
        `Desktop connection catalog write failed during create-directory at ${stateDirFor(path, baseDir)}.`,
      );
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the legacy migration stage", () =>
    withStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{not-json");

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreMigrationError,
        );
        assert.equal(error.operation, "read-legacy-registry");
        assert.equal(error.catalogPath, catalogPathFor(path, environment.stateDir));
        assert.instanceOf(
          error.cause,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
        const registryError =
          error.cause as DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError;
        assert.exists(registryError.cause);
        assert.equal(
          error.message,
          `Legacy desktop saved-environment migration failed during read-legacy-registry into ${catalogPathFor(path, environment.stateDir)}.`,
        );
        assert.notEqual(error.message, registryError.message);
      }),
    ),
  );

  it.effect("reports invalid encrypted catalog data without exposing it", () =>
    withStore(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = catalogPathFor(path, environment.stateDir);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        const document = '{"version":1,"encryptedCatalog":"%%%"}\n';
        yield* fileSystem.writeFileString(catalogPath, document);

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
        assert.equal(yield* fileSystem.readFileString(catalogPath), document);
        assert.lengthOf(
          (yield* fileSystem.readDirectory(environment.stateDir)).filter((name) =>
            name.startsWith("connection-catalog.json.corrupt."),
          ),
          0,
        );
      }),
    ),
  );

  it.effect("surfaces secure-storage availability failures without quarantining the catalog", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const availabilityError = new ElectronSafeStorage.ElectronSafeStorageAvailabilityError({
        cause: new Error("safe storage unavailable"),
      });
      const layer = makeLayer(baseDir, Effect.fail(availabilityError));
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layer),
      );
      const stateDir = stateDirFor(path, baseDir);
      const catalogPath = catalogPathFor(path, stateDir);
      const document = '{"version":1,"encryptedCatalog":"ZW5jcnlwdGVkOnt9"}\n';
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      yield* fileSystem.writeFileString(catalogPath, document);

      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "check-encryption-availability");
      assert.strictEqual(error.cause, availabilityError);
      assert.equal(yield* fileSystem.readFileString(catalogPath), document);
      assert.lengthOf(
        (yield* fileSystem.readDirectory(stateDir)).filter((name) =>
          name.startsWith("connection-catalog.json.corrupt."),
        ),
        0,
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("surfaces a catalog that can no longer be decrypted without deleting it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
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
      assert.equal(error.catalogPath, catalogPathFor(path, stateDirFor(path, baseDir)));
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      const decryptError = error.cause as ElectronSafeStorage.ElectronSafeStorageDecryptError;
      assert.instanceOf(decryptError.cause, Error);
      assert.equal(decryptError.cause.message, "invalid encrypted catalog");
      assert.equal(
        error.message,
        `Desktop connection catalog protection failed during decrypt-catalog at ${catalogPathFor(path, stateDirFor(path, baseDir))}.`,
      );
      assert.notEqual(error.message, decryptError.message);
      yield* Ref.set(failDecrypt, false);
      assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
