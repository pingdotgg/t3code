// @effect-diagnostics nodeBuiltinImport:off - native-format fixtures exercise Chromium AES-GCM interoperability.
import * as NodeCrypto from "node:crypto";
import { vi } from "vite-plus/test";
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
import { resolveUserDataPath } from "./DesktopUserData.ts";

const { legacyKeys } = vi.hoisted(() => ({ legacyKeys: new Map<string, Buffer>() }));
vi.mock("../preview/BrowserImport/ChromiumKeys.ts", async (original) => ({
  ...(await original<typeof import("../preview/BrowserImport/ChromiumKeys.ts")>()),
  readWindowsKey: (path: string) => {
    const key = legacyKeys.get(path);
    return key
      ? Effect.succeed(key)
      : Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("No legacy profile key"),
          }),
        );
  },
}));
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
  platform: NodeJS.Platform = "darwin",
  storage = layerSafeStorageFor(encryptionAvailable, failDecrypt),
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform,
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
  const layerSafeStorage = storage;
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
      const layerFileSystem = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(permissionError),
        }),
      );
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true, null, layerFileSystem)),
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
      const layerFileSystem = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          makeDirectory: () => Effect.fail(permissionError),
        }),
      );
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(layerFor(baseDir, true, null, layerFileSystem)),
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

const seal = (value: string, key: Buffer) => {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    Buffer.from("v10"),
    nonce,
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
};
const open = (bytes: Uint8Array, key: Buffer) => {
  const data = Buffer.from(bytes);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, data.subarray(3, 15));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(15, -16)), decipher.final()]).toString(
    "utf8",
  );
};

it.effect.each([
  { owner: "t3code", writeFirst: false, freshProfile: false },
  { owner: "t3code", writeFirst: false, freshProfile: true },
  { owner: "T3 Code (Alpha)", writeFirst: false, freshProfile: false },
  { owner: "T3 Code (Alpha)", writeFirst: false, freshProfile: true },
  { owner: "t3code", writeFirst: true, freshProfile: false },
  { owner: "T3 Code (Alpha)", writeFirst: true, freshProfile: false },
])(
  "recovers $owner catalog (write first: $writeFirst, new V2: $freshProfile) and preserves both profiles",
  ({ owner, writeFirst, freshProfile }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-catalog-key-" });
      const original = Buffer.alloc(32, 1);
      const other = Buffer.alloc(32, 2);
      const v2 = freshProfile
        ? owner === "T3 Code (Alpha)"
          ? original
          : other
        : Buffer.alloc(32, 3);
      for (const profile of ["t3code", "T3 Code (Alpha)"]) {
        const statePath = path.join(root, "AppData", "Roaming", profile, "Local State");
        yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
        yield* fs.writeFileString(statePath, JSON.stringify({ profile }));
        legacyKeys.set(statePath, profile === owner ? original : other);
      }
      const v2State = path.join(root, "AppData", "Roaming", "t3code-v2", "Local State");
      yield* fs.makeDirectory(path.dirname(v2State), { recursive: true });
      if (freshProfile) {
        yield* resolveUserDataPath({
          appDataDirectory: path.join(root, "AppData", "Roaming"),
          isDevelopment: false,
          platform: "win32",
        });
      } else {
        yield* fs.writeFileString(v2State, "existing V2 key and preferences");
      }
      const v2Preferences = yield* fs.readFileString(v2State);
      const tokenPath = path.join(path.dirname(v2State), "clerk-tokens.json");
      const token = seal("existing V2 token", v2);
      yield* fs.writeFile(tokenPath, token);
      const native = {
        isEncryptionAvailable: Effect.succeed(true),
        encryptString: (value: string) => Effect.succeed(seal(value, v2)),
        decryptString: (value: Uint8Array) =>
          value.length < 31
            ? Effect.die(new Error("Windows safeStorage aborts on truncated ciphertext"))
            : Effect.try({
                try: () => open(value, v2),
                catch: (cause) =>
                  new ElectronSafeStorage.ElectronSafeStorageDecryptError({ cause }),
              }),
        selectedStorageBackend: Effect.succeedNone,
      };
      yield* Effect.gen(function* () {
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
        yield* fs.makeDirectory(environment.stateDir, { recursive: true });
        const initial = JSON.stringify({
          version: 1,
          encryptedCatalog: seal("saved connections", original).toString("base64"),
        });
        yield* fs.writeFileString(catalogPath, initial);
        if (writeFirst) {
          assert.isTrue(yield* store.set("updated first"));
          assert.equal(
            open(
              Buffer.from(
                JSON.parse(yield* fs.readFileString(catalogPath)).encryptedCatalog,
                "base64",
              ),
              original,
            ),
            "updated first",
          );
          yield* fs.writeFileString(catalogPath, initial);
        }
        assert.deepStrictEqual(yield* store.get, Option.some("saved connections"));
        assert.equal(yield* fs.readFileString(catalogPath), initial);
        assert.isTrue(yield* store.set("updated connections"));
        const persisted = JSON.parse(yield* fs.readFileString(catalogPath));
        assert.equal(
          open(Buffer.from(persisted.encryptedCatalog, "base64"), original),
          "updated connections",
        );
        assert.deepStrictEqual(yield* store.get, Option.some("updated connections"));
        assert.equal(yield* fs.readFileString(v2State), v2Preferences);
        for (const profile of ["t3code", "T3 Code (Alpha)"]) {
          assert.equal(
            yield* fs.readFileString(path.join(root, "AppData", "Roaming", profile, "Local State")),
            JSON.stringify({ profile }),
          );
        }
        assert.deepStrictEqual(yield* fs.readFile(tokenPath), new Uint8Array(token));
        assert.equal(open(yield* fs.readFile(tokenPath), v2), "existing V2 token");
        // Even a write before the next read must authenticate the current catalog's key.
        yield* fs.writeFileString(
          catalogPath,
          JSON.stringify({
            version: 1,
            encryptedCatalog: seal("V1 update", original).toString("base64"),
          }),
        );
        assert.isTrue(yield* store.set("write before read"));
        assert.equal(
          open(
            Buffer.from(
              JSON.parse(yield* fs.readFileString(catalogPath)).encryptedCatalog,
              "base64",
            ),
            original,
          ),
          "write before read",
        );
        for (const encryptedCatalog of [
          "",
          Buffer.from("v10short").toString("base64"),
          seal("unrecoverable", Buffer.alloc(32, 9)).toString("base64"),
        ]) {
          const corrupt = JSON.stringify({ version: 1, encryptedCatalog });
          yield* fs.writeFileString(catalogPath, corrupt);
          assert.equal(
            (yield* store.get.pipe(Effect.flip))._tag,
            "DesktopConnectionCatalogStoreProtectionError",
          );
          assert.equal(
            (yield* store.set("must not overwrite").pipe(Effect.flip))._tag,
            "DesktopConnectionCatalogStoreProtectionError",
          );
          assert.equal(yield* fs.readFileString(catalogPath), corrupt);
        }
      }).pipe(
        Effect.provide(
          layerFor(
            root,
            true,
            null,
            NodeServices.layer,
            "win32",
            Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, native),
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
