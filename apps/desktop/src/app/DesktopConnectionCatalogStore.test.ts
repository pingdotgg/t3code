// @effect-diagnostics nodeBuiltinImport:off - The recovery fixtures use Chromium OSCrypt ciphertext.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { beforeEach, vi } from "vite-plus/test";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { LinuxBrowserSecretPath } from "../preview/BrowserImport/LinuxBrowserSecret.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopSafeStorageIdentity from "./DesktopSafeStorageIdentity.ts";

const { getBetaPassword } = vi.hoisted(() => ({
  getBetaPassword: vi.fn<() => string | null>(),
}));

vi.mock("@napi-rs/keyring", () => ({
  Entry: class {
    readonly getPassword;
    constructor(service: string, account: string) {
      this.getPassword = () =>
        service === "T3 Code (Beta) Safe Storage" && account === "T3 Code (Beta)"
          ? getBetaPassword()
          : null;
    }
  },
}));

beforeEach(() => {
  getBetaPassword.mockReset().mockReturnValue(null);
});

const savedCatalog = JSON.stringify({
  schemaVersion: 1,
  targets: [
    { _tag: "RelayConnectionTarget", environmentId: "relay-environment", label: "Saved relay" },
  ],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
});

const encryptBetaCatalog = (platform: NodeJS.Platform, catalog = savedCatalog) => {
  const key = NodeCrypto.pbkdf2Sync(
    "beta-secret",
    "saltysalt",
    platform === "darwin" ? 1003 : 1,
    16,
    "sha1",
  );
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([
    Buffer.from(platform === "darwin" ? "v10" : "v11"),
    cipher.update(catalog, "utf8"),
    cipher.final(),
  ]);
};

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
function layerSafeStorageFor(
  available: boolean,
  failDecrypt: Ref.Ref<boolean> | null = null,
  currentSecret?: string,
) {
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
          if (currentSecret !== undefined) {
            return yield* Effect.try({
              try: () => {
                const key = NodeCrypto.pbkdf2Sync(currentSecret, "saltysalt", 1003, 16, "sha1");
                const decipher = NodeCrypto.createDecipheriv(
                  "aes-128-cbc",
                  key,
                  Buffer.alloc(16, " "),
                );
                return Buffer.concat([
                  decipher.update(value.subarray(3)),
                  decipher.final(),
                ]).toString("utf8");
              },
              catch: (cause) => new ElectronSafeStorage.ElectronSafeStorageDecryptError({ cause }),
            });
          }
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

const layerLinuxKeyAccess = (lookup: Effect.Effect<string | null>) =>
  Layer.merge(
    Layer.succeed(LinuxBrowserSecretPath, "/bundled/browser-secret/t3-browser-secret"),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const secret =
            command._tag === "StandardCommand" && command.args[0] === "T3 Code (Beta)"
              ? yield* lookup
              : null;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(secret === null ? 2 : 0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.encodeText(Stream.make(secret ?? "")),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      ),
    ),
  );

interface RecoveryOptions {
  readonly platform?: NodeJS.Platform;
  readonly linuxKeyLookup?: Effect.Effect<string | null>;
  readonly currentSecret?: string | undefined;
}

function layerFor(
  baseDir: string,
  encryptionAvailable = true,
  failDecrypt: Ref.Ref<boolean> | null = null,
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
  recovery: RecoveryOptions = {},
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: recovery.platform ?? "darwin",
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
  const layerSafeStorage = layerSafeStorageFor(
    encryptionAvailable,
    failDecrypt,
    recovery.currentSecret,
  );
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    DesktopSafeStorageIdentity.layer.pipe(
      Layer.provide(layerEnvironment),
      Layer.provide(layerLinuxKeyAccess(recovery.linuxKeyLookup ?? Effect.succeed(null))),
    ),
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
  recovery: RecoveryOptions = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-connection-catalog-test-",
    });
    return yield* effect.pipe(
      Effect.provide(layerFor(baseDir, encryptionAvailable, null, NodeServices.layer, recovery)),
    );
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

  const writeBetaCatalog = (
    platform: NodeJS.Platform,
    encryptedCatalog = encryptBetaCatalog(platform),
  ) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const environment = yield* DesktopEnvironment.DesktopEnvironment;
      const fileSystem = yield* FileSystem.FileSystem;
      const catalogPath = path.join(environment.stateDir, "connection-catalog.json");
      const contents = `${JSON.stringify({
        version: 1,
        encryptedCatalog: Base64.encode(encryptedCatalog),
      })}\n`;
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(catalogPath, contents);
      return { catalogPath, contents };
    });

  it.effect.each([
    { platform: "darwin" as const, currentSecret: undefined, label: "macOS" },
    { platform: "linux" as const, currentSecret: undefined, label: "Linux" },
    {
      platform: "darwin" as const,
      currentSecret: "wrong-key-494",
      label: "macOS with valid padding under the wrong current key",
    },
  ])(
    "recovers a Beta catalog on $label and reopens it without the Beta key",
    ({ platform, currentSecret }) =>
      withStore(
        Effect.gen(function* () {
          getBetaPassword.mockReturnValue("beta-secret");
          const fileSystem = yield* FileSystem.FileSystem;
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
          const { catalogPath, contents } = yield* writeBetaCatalog(platform);

          assert.deepStrictEqual(yield* store.get, Option.some(savedCatalog));
          assert.notEqual(yield* fileSystem.readFileString(catalogPath), contents);

          getBetaPassword.mockReturnValue(null);
          const reopened = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
            Effect.provide(
              layerFor(environment.homeDirectory, true, null, NodeServices.layer, { platform }),
            ),
          );
          assert.deepStrictEqual(yield* reopened.get, Option.some(savedCatalog));
        }),
        true,
        { platform, currentSecret, linuxKeyLookup: Effect.succeed("beta-secret") },
      ),
  );

  it.effect.each([
    // This wrong key has valid CBC padding, so decryption alone cannot validate recovery.
    { platform: "darwin" as const, secret: "wrong-key-494", label: "a wrong Beta key" },
    { platform: "linux" as const, secret: null, label: "a missing Beta key" },
    {
      platform: "darwin" as const,
      secret: "beta-secret",
      label: "unencrypted input",
      encryptedCatalog: Buffer.from(savedCatalog),
    },
    {
      platform: "linux" as const,
      secret: "beta-secret",
      label: "an invalid catalog",
      encryptedCatalog: encryptBetaCatalog("linux", '{"schemaVersion":1,"targets":null}'),
    },
  ])("leaves the catalog bytes intact for $label", ({ platform, secret, encryptedCatalog }) =>
    withStore(
      Effect.gen(function* () {
        getBetaPassword.mockReturnValue(secret);
        const fileSystem = yield* FileSystem.FileSystem;
        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
        const { catalogPath, contents } = yield* writeBetaCatalog(platform, encryptedCatalog);

        const error = yield* store.get.pipe(Effect.flip);
        assert.instanceOf(
          error,
          DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
        );
        assert.equal(error.operation, "decrypt-catalog");
        assert.equal(yield* fileSystem.readFileString(catalogPath), contents);
      }),
      true,
      { platform, linuxKeyLookup: Effect.succeed(secret) },
    ),
  );

  it.effect.each(["save", "clear"] as const)(
    "preserves a concurrent %s while Beta key recovery is waiting",
    (operation) =>
      Effect.gen(function* () {
        const lookupStarted = yield* Deferred.make<void>();
        const lookupReleased = yield* Deferred.make<void>();
        const linuxKeyLookup = Deferred.succeed(lookupStarted, undefined).pipe(
          Effect.andThen(Deferred.await(lookupReleased)),
          Effect.as("beta-secret"),
        );
        const newer = savedCatalog.replace("Saved relay", "Updated relay");

        yield* withStore(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
            const { catalogPath } = yield* writeBetaCatalog("linux");
            const recovery = yield* store.get.pipe(Effect.forkChild);
            yield* Deferred.await(lookupStarted);
            if (operation === "save") {
              assert.isTrue(yield* store.set(newer));
            } else {
              yield* store.clear;
            }
            yield* Deferred.succeed(lookupReleased, undefined);
            yield* Fiber.join(recovery);

            assert.deepStrictEqual(
              yield* store.get,
              operation === "save" ? Option.some(newer) : Option.none(),
            );
            assert.equal(yield* fileSystem.exists(catalogPath), operation === "save");
          }),
          true,
          { platform: "linux", linuxKeyLookup },
        );
      }),
  );
});
