// @effect-diagnostics nodeBuiltinImport:off - The recovery fixtures use Chromium OSCrypt ciphertext.
import * as NodeCrypto from "node:crypto";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
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
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { vi } from "vite-plus/test";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import { LinuxBrowserSecretPath } from "../preview/BrowserImport/LinuxBrowserSecret.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const { keychainPassword } = vi.hoisted(() => ({
  keychainPassword: vi.fn<(service: string, account: string) => string | null>(),
}));

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    readonly getPassword;
    constructor(service: string, account: string) {
      this.getPassword = async () => keychainPassword(service, account);
    }
  },
}));

const NIGHTLY_VERSION = "0.1.3-nightly.20261023.3553";
const OLD_SAFE_STORAGE_NAME = "T3 Code (Nightly)";
const OLD_SAFE_STORAGE_SECRET = "nightly-rename-secret";

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

// Electron safeStorage output: v10 on macOS (Keychain secret), v11 on Linux (libsecret secret).
const encryptWithOldSafeStorageName = (platform: "darwin" | "linux") => {
  const key = NodeCrypto.pbkdf2Sync(
    OLD_SAFE_STORAGE_SECRET,
    "saltysalt",
    platform === "darwin" ? 1003 : 1,
    16,
    "sha1",
  );
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([
    Buffer.from(platform === "darwin" ? "v10" : "v11"),
    cipher.update(savedCatalog, "utf8"),
    cipher.final(),
  ]);
};

const layerLinuxSecretHelper = (
  lookups: Ref.Ref<ReadonlyArray<string>>,
  beforeLookup: Effect.Effect<void> = Effect.void,
) =>
  Layer.merge(
    Layer.succeed(LinuxBrowserSecretPath, "/bundled/browser-secret/t3-browser-secret"),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const arg = command._tag === "StandardCommand" ? command.args[0] : undefined;
          const application = typeof arg === "string" ? arg : "";
          yield* Ref.update(lookups, (all) => [...all, application]);
          yield* beforeLookup;
          const secret = application === OLD_SAFE_STORAGE_NAME ? OLD_SAFE_STORAGE_SECRET : null;
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
  wrongKeyPlaintext?: string,
) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`encrypted:${value}`)),
    decryptString: (value) => {
      return Effect.gen(function* () {
        const decoded = textDecoder.decode(value);
        if (!decoded.startsWith("encrypted:") && wrongKeyPlaintext !== undefined) {
          return wrongKeyPlaintext;
        }
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
  host: {
    readonly platform: NodeJS.Platform;
    readonly appVersion: string;
    readonly linuxSecretLookups?: Ref.Ref<ReadonlyArray<string>>;
    readonly beforeLinuxSecretLookup?: Effect.Effect<void>;
    readonly wrongKeyPlaintext?: string;
  } = { platform: "darwin", appVersion: "1.2.3" },
) {
  const layerEnvironment = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: host.platform,
    processArch: "arm64",
    appVersion: host.appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: host.linuxSecretLookups ? `${baseDir}/resources` : "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );
  const layerSafeStorage = layerSafeStorageFor(
    encryptionAvailable,
    failDecrypt,
    host.wrongKeyPlaintext,
  );
  const layerDependencies = Layer.mergeAll(
    layerEnvironment,
    layerSafeStorage,
    NodeServices.layer,
    NodePlatformCrypto.layer,
    fileSystemLayer,
    host.linuxSecretLookups
      ? layerLinuxSecretHelper(host.linuxSecretLookups, host.beforeLinuxSecretLookup)
      : Layer.empty,
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
  }).pipe(Effect.provide(NodeServices.layer));

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
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  const writeOldNightlyCatalog = (
    baseDir: string,
    platform: "darwin" | "linux",
    encryptedCatalog = encryptWithOldSafeStorageName(platform),
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const stateDir = `${baseDir}/userdata`;
      const catalogPath = `${stateDir}/connection-catalog.json`;
      const contents = `${JSON.stringify({
        version: 1,
        encryptedCatalog: Base64.encode(encryptedCatalog),
      })}\n`;
      yield* fileSystem.makeDirectory(stateDir, { recursive: true });
      yield* fileSystem.writeFileString(catalogPath, contents);
      return { catalogPath, contents };
    });

  it.effect(
    "recovers a Linux catalog saved under the T3 Code (Nightly) safe storage name and re-encrypts it",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-connection-catalog-test-",
        });
        // The packaged libsecret helper; the spawner below answers for it.
        yield* fileSystem.makeDirectory(`${baseDir}/resources/browser-secret`, { recursive: true });
        yield* fileSystem.writeFileString(
          `${baseDir}/resources/browser-secret/t3-browser-secret`,
          "",
        );
        const { catalogPath, contents } = yield* writeOldNightlyCatalog(baseDir, "linux");
        const lookups = yield* Ref.make<ReadonlyArray<string>>([]);
        const host = {
          platform: "linux",
          appVersion: NIGHTLY_VERSION,
          linuxSecretLookups: lookups,
        } as const;

        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(layerFor(baseDir, true, null, NodeServices.layer, host)),
        );
        assert.deepStrictEqual(yield* store.get, Option.some(savedCatalog));
        assert.include(yield* Ref.get(lookups), OLD_SAFE_STORAGE_NAME);
        assert.notEqual(yield* fileSystem.readFileString(catalogPath), contents);

        yield* Ref.set(lookups, []);
        const reopened = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(layerFor(baseDir, true, null, NodeServices.layer, host)),
        );
        assert.deepStrictEqual(yield* reopened.get, Option.some(savedCatalog));
        assert.notInclude(yield* Ref.get(lookups), OLD_SAFE_STORAGE_NAME);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "recovers a macOS catalog saved under the T3 Code (Nightly) safe storage name and re-encrypts it",
    () =>
      Effect.gen(function* () {
        keychainPassword
          .mockReset()
          .mockImplementation((service, account) =>
            service === `${OLD_SAFE_STORAGE_NAME} Safe Storage` &&
            account === `${OLD_SAFE_STORAGE_NAME} Key`
              ? OLD_SAFE_STORAGE_SECRET
              : null,
          );
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-connection-catalog-test-",
        });
        const { catalogPath, contents } = yield* writeOldNightlyCatalog(baseDir, "darwin");
        const host = { platform: "darwin", appVersion: NIGHTLY_VERSION } as const;

        const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(layerFor(baseDir, true, null, NodeServices.layer, host)),
        );
        assert.deepStrictEqual(yield* store.get, Option.some(savedCatalog));
        assert.notEqual(yield* fileSystem.readFileString(catalogPath), contents);

        keychainPassword.mockClear();
        const reopened = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
          Effect.provide(layerFor(baseDir, true, null, NodeServices.layer, host)),
        );
        assert.deepStrictEqual(yield* reopened.get, Option.some(savedCatalog));
        assert.equal(keychainPassword.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("recovers when the current key decrypts the old Nightly catalog to garbage", () =>
    Effect.gen(function* () {
      keychainPassword
        .mockReset()
        .mockImplementation((service, account) =>
          service === `${OLD_SAFE_STORAGE_NAME} Safe Storage` &&
          account === `${OLD_SAFE_STORAGE_NAME} Key`
            ? OLD_SAFE_STORAGE_SECRET
            : null,
        );
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      yield* writeOldNightlyCatalog(baseDir, "darwin");
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(
          layerFor(baseDir, true, null, NodeServices.layer, {
            platform: "darwin",
            appVersion: NIGHTLY_VERSION,
            wrongKeyPlaintext: "\u0007\u00e9\u0001not a catalog",
          }),
        ),
      );

      assert.deepStrictEqual(yield* store.get, Option.some(savedCatalog));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect.each([
    { platform: "darwin" as const, label: "the old Keychain item is missing", plaintext: false },
    { platform: "linux" as const, label: "the file holds unencrypted JSON", plaintext: true },
  ])("keeps the decrypt failure and the file when $label", ({ platform, plaintext }) =>
    Effect.gen(function* () {
      keychainPassword.mockReset().mockReturnValue(null);
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      const { catalogPath, contents } = yield* writeOldNightlyCatalog(
        baseDir,
        platform,
        plaintext ? Buffer.from(savedCatalog) : undefined,
      );
      const lookups = yield* Ref.make<ReadonlyArray<string>>([]);
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(
          layerFor(baseDir, true, null, NodeServices.layer, {
            platform,
            appVersion: NIGHTLY_VERSION,
            linuxSecretLookups: lookups,
          }),
        ),
      );

      const error = yield* store.get.pipe(Effect.flip);
      assert.instanceOf(
        error,
        DesktopConnectionCatalogStore.DesktopConnectionCatalogStoreProtectionError,
      );
      assert.equal(error.operation, "decrypt-catalog");
      assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      assert.equal(yield* fileSystem.readFileString(catalogPath), contents);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps a catalog saved while the old Nightly key is being read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-connection-catalog-test-",
      });
      yield* writeOldNightlyCatalog(baseDir, "linux");
      const lookupStarted = yield* Deferred.make<void>();
      const lookupReleased = yield* Deferred.make<void>();
      const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
        Effect.provide(
          layerFor(baseDir, true, null, NodeServices.layer, {
            platform: "linux",
            appVersion: NIGHTLY_VERSION,
            linuxSecretLookups: yield* Ref.make<ReadonlyArray<string>>([]),
            beforeLinuxSecretLookup: Deferred.succeed(lookupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(lookupReleased)),
            ),
          }),
        ),
      );
      const newer = savedCatalog.replace("Saved relay", "Updated relay");

      const recovery = yield* store.get.pipe(Effect.forkChild);
      yield* Deferred.await(lookupStarted);
      assert.isTrue(yield* store.set(newer));
      yield* Deferred.succeed(lookupReleased, undefined);
      assert.deepStrictEqual(yield* Fiber.join(recovery), Option.some(savedCatalog));

      assert.deepStrictEqual(yield* store.get, Option.some(newer));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
