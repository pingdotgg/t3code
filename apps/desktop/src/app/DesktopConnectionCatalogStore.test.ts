import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
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
const decodeConnectionCatalog = Schema.decodeEffect(
  Schema.fromJsonString(ConnectionCatalogDocument),
);
const encodeLegacySavedEnvironments = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Literal(1), records: Schema.Array(Schema.Unknown) }),
  ),
);
function layerSafeStorageFor(available: boolean, failDecrypt: Ref.Ref<boolean> | null = null) {
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
    selectedStorageBackend: Effect.succeedNone,
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

function layerFor(
  baseDir: string,
  encryptionAvailable = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
) {
  const layerEnvironment = DesktopEnvironment.layer({
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
  const layerSafeStorage = layerSafeStorageFor(encryptionAvailable, failDecrypt);
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    NodeServices.layer,
    fileSystemLayer,
  );
  const layerSavedEnvironments = DesktopSavedEnvironments.layer.pipe(
    Layer.provideMerge(layerDependencies),
  );

  return DesktopConnectionCatalogStore.layer.pipe(
    Layer.provideMerge(layerSavedEnvironments),
    Layer.provideMerge(layerDependencies),
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
    return yield* effect.pipe(Effect.provide(layerFor(baseDir, encryptionAvailable)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopConnectionCatalogStore", () => {
  it.effect("persists and reads an encrypted connection catalog", () =>
    withStore(
      Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalog = '{"schemaVersion":1,"targets":[]}';

        assert.isTrue(yield* store.set(catalog));
        assert.deepStrictEqual(yield* store.get, Option.some(catalog));
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
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: records.map((record) =>
              record.environmentId === "bearer-environment"
                ? {
                    ...record,
                    encryptedBearerToken: Base64.encode(
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

  it.effect("preserves unparseable catalog bytes before recovering and saving", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });

        const damaged = [
          textEncoder.encode('{"version":'),
          new Uint8Array(1252),
          new Uint8Array([0xff, 0x7b, 0x22]),
          new Uint8Array(),
        ];
        for (const bytes of damaged) {
          yield* fileSystem.writeFile(catalogPath, bytes);
          assert.deepStrictEqual(
            yield* Effect.all([store.get, store.get], { concurrency: "unbounded" }),
            [Option.none(), Option.none()],
          );
          assert.deepStrictEqual(yield* fileSystem.readFile(catalogPath), bytes);
        }
        const backups = (yield* fileSystem.readDirectory(environment.stateDir)).filter((name) =>
          name.startsWith("connection-catalog.json.corrupt."),
        );
        assert.equal(backups.length, damaged.length);
        const preserved = yield* Effect.forEach(backups, (name) =>
          fileSystem.readFile(path.join(environment.stateDir, name)),
        );
        assert.sameDeepMembers(preserved, damaged);
        const emptyBackup = backups[preserved.findIndex((bytes) => bytes.length === 0)]!;
        yield* fileSystem.writeFileString(path.join(environment.stateDir, emptyBackup), "partial");
        assert.deepStrictEqual(yield* store.get, Option.none());
        assert.equal(
          (yield* fileSystem.readFile(path.join(environment.stateDir, emptyBackup))).length,
          0,
        );

        assert.isTrue(yield* store.set('{"schemaVersion":1,"targets":[]}'));
        assert.deepStrictEqual(yield* store.get, Option.some('{"schemaVersion":1,"targets":[]}'));
        assert.sameDeepMembers(
          yield* Effect.forEach(backups, (name) =>
            fileSystem.readFile(path.join(environment.stateDir, name)),
          ),
          damaged,
        );
      }),
    ),
  );

  it.effect("recovers readable legacy credentials without replacing the damaged catalog", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        const damaged = new Uint8Array(1252);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFile(catalogPath, damaged);
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          yield* encodeLegacySavedEnvironments({
            version: 1,
            records: [
              {
                environmentId: "legacy-remote",
                label: "Saved remote",
                httpBaseUrl: "https://example.com/",
                wsBaseUrl: "wss://example.com/",
                createdAt: "2026-06-01T00:00:00.000Z",
                lastConnectedAt: null,
                encryptedBearerToken: Base64.encode(textEncoder.encode("encrypted:legacy-token")),
              },
            ],
          }),
        );

        const catalog = yield* decodeConnectionCatalog(Option.getOrThrow(yield* store.get));
        assert.lengthOf(catalog.targets, 1);
        assert.deepInclude(catalog.credentials[0]?.credential, { token: "legacy-token" });
        assert.deepStrictEqual(yield* fileSystem.readFile(catalogPath), damaged);
      }),
    ),
  );

  it.effect("surfaces unsupported catalog envelopes without deleting them", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        const document = '{"version":2,"encryptedCatalog":"readable-by-a-newer-build"}';
        yield* fileSystem.writeFileString(catalogPath, document);
        assert.instanceOf(
          yield* store.get.pipe(Effect.flip),
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDocumentDecodeError,
        );
        assert.equal(yield* fileSystem.readFileString(catalogPath), document);
        assert.deepStrictEqual(yield* fileSystem.readDirectory(environment.stateDir), [
          "connection-catalog.json",
        ]);
      }),
    ),
  );

  it.effect("preserves catalogs after filesystem or base64 errors", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-catalog-errors-" });
      const stateDir = path.join(baseDir, "userdata");
      const catalogPath = path.join(stateDir, "connection-catalog.json");
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir)),
      );
      yield* store.set('{"schemaVersion":1,"targets":[]}');
      const original = yield* fileSystem.readFile(catalogPath);

      const denied = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFile",
        pathOrDescriptor: catalogPath,
      });
      const unreadableStore =
        yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(
            layerFor(
              baseDir,
              true,
              null,
              Layer.succeed(FileSystem.FileSystem, {
                ...fileSystem,
                readFile: () => Effect.fail(denied),
              }),
            ),
          ),
        );
      const error = yield* unreadableStore.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreReadError,
      );
      assert.deepStrictEqual(yield* fileSystem.readFile(catalogPath), original);

      const invalidBase64 = '{"version":1,"encryptedCatalog":"%%%"}';
      yield* fileSystem.writeFileString(catalogPath, invalidBase64);
      assert.instanceOf(
        yield* store.get.pipe(Effect.flip),
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreDecodeError,
      );
      assert.equal(yield* fileSystem.readFileString(catalogPath), invalidBase64);
      assert.deepStrictEqual(yield* fileSystem.readDirectory(stateDir), [
        "connection-catalog.json",
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads a concurrent replacement while preserving the failed snapshot", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-catalog-race-" });
      const stateDir = path.join(baseDir, "userdata");
      const catalogPath = path.join(stateDir, "connection-catalog.json");
      const otherStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir)),
      );
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      const damaged = new Uint8Array(1252);
      yield* fileSystem.writeFile(catalogPath, damaged);
      const catalog = '{"schemaVersion":1,"targets":[],"accountId":"saved-elsewhere"}';
      let replaced = false;
      const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
        ...fileSystem,
        readFile: (file) =>
          fileSystem.readFile(file).pipe(
            Effect.tap(() => {
              if (file !== catalogPath || replaced) return Effect.void;
              replaced = true;
              return otherStore.set(catalog).pipe(Effect.orDie);
            }),
          ),
      });
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true, null, fileSystemLayer)),
      );

      assert.deepStrictEqual(yield* store.get, Option.some(catalog));
      assert.deepStrictEqual(yield* otherStore.get, Option.some(catalog));
      const backups = (yield* fileSystem.readDirectory(stateDir)).filter((name) =>
        name.startsWith("connection-catalog.json.corrupt."),
      );
      assert.lengthOf(backups, 1);
      assert.deepStrictEqual(yield* fileSystem.readFile(path.join(stateDir, backups[0]!)), damaged);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses recovery when the backup cannot be replaced and permits retry", () =>
    withStore(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        const damaged = new Uint8Array(1252);
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFile(catalogPath, damaged);
        assert.deepStrictEqual(yield* store.get, Option.none());
        const backupName = (yield* fileSystem.readDirectory(environment.stateDir)).find((name) =>
          name.startsWith("connection-catalog.json.corrupt."),
        )!;
        const backupPath = path.join(environment.stateDir, backupName);
        yield* fileSystem.remove(backupPath);
        yield* fileSystem.makeDirectory(backupPath);

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreWriteError,
        );
        assert.equal(error.operation, "replace-catalog-file");
        assert.equal(error.path, backupPath);
        assert.include(error.message, backupPath);
        assert.deepStrictEqual(yield* fileSystem.readFile(catalogPath), damaged);
        assert.sameMembers(yield* fileSystem.readDirectory(environment.stateDir), [
          "connection-catalog.json",
          backupName,
        ]);
        yield* fileSystem.remove(backupPath, { recursive: true });
        assert.deepStrictEqual(yield* store.get, Option.none());
        assert.deepStrictEqual(yield* fileSystem.readFile(backupPath), damaged);
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
      const layer = layerFor(baseDir, true, failDecrypt);
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
