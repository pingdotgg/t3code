// @effect-diagnostics nodeBuiltinImport:off - native-format fixtures exercise Chromium AES-GCM interoperability.
import * as NodeCrypto from "node:crypto";
import { beforeEach, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../settings/DesktopSavedEnvironments.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const { legacyKeys, keyReads } = vi.hoisted(() => ({
  legacyKeys: new Map<string, Buffer>(),
  keyReads: vi.fn<(path: string) => Effect.Effect<void>>(),
}));
vi.mock("../preview/BrowserImport/ChromiumKeys.ts", async (original) => {
  const actual = await original<typeof import("../preview/BrowserImport/ChromiumKeys.ts")>();
  return {
    ...actual,
    readWindowsKey: (path: string) =>
      Effect.gen(function* () {
        yield* keyReads(path);
        const key = legacyKeys.get(path);
        return yield* key
          ? Effect.succeed(key)
          : Effect.fail(new actual.ChromiumKeyError({ reason: "readFailed" }));
      }),
  };
});
beforeEach(() => {
  legacyKeys.clear();
  keyReads.mockReset().mockReturnValue(Effect.void);
});
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
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

const seal = (value: string, key: Buffer) => {
  const nonce = Buffer.alloc(12, 4);
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
  assert.equal(data.subarray(0, 3).toString("ascii"), "v10");
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, data.subarray(3, 15));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(15, -16)), decipher.final()]).toString(
    "utf8",
  );
};

const stableKey = Buffer.alloc(32, 1);
const alphaKey = Buffer.alloc(32, 2);
const currentKey = Buffer.alloc(32, 3);
const encryptedDocument = (encrypted: Uint8Array) =>
  JSON.stringify({ version: 1, encryptedCatalog: Base64.encode(encrypted) });

const cryptoStore = (platform: NodeJS.Platform = "win32") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-catalog-key-" });
    const profiles = [];
    for (const [name, key] of [
      ["t3code", stableKey],
      ["T3 Code (Alpha)", alphaKey],
      ["t3code-v2", currentKey],
    ] as const) {
      const statePath = path.join(root, "AppData", "Roaming", name, "Local State");
      const state = JSON.stringify({ os_crypt: { encrypted_key: `wrapped-${name}` } });
      const tokenPath = path.join(path.dirname(statePath), "clerk-tokens.json");
      const token = seal(`${name} token`, key);
      yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
      yield* fs.writeFileString(statePath, state);
      yield* fs.writeFile(tokenPath, token);
      legacyKeys.set(statePath, key);
      profiles.push({ name, key, statePath, state, tokenPath, token });
    }
    const nativeDecrypt = vi.fn((value: Uint8Array) =>
      value.length < 31
        ? Effect.die(new Error("Windows safeStorage aborts on truncated ciphertext"))
        : Effect.try({
            try: () => open(value, currentKey),
            catch: (cause) => new ElectronSafeStorage.ElectronSafeStorageDecryptError({ cause }),
          }),
    );
    const nativeEncrypt = vi.fn((value: string) => Effect.succeed(seal(value, currentKey)));
    const store = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore.pipe(
      Effect.provide(
        layerFor(
          root,
          true,
          null,
          NodeServices.layer,
          platform,
          Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
            isEncryptionAvailable: Effect.succeed(true),
            encryptString: nativeEncrypt,
            decryptString: nativeDecrypt,
            selectedStorageBackend: Effect.succeedNone,
          }),
        ),
      ),
    );
    const catalogPath = path.join(root, "userdata", "connection-catalog.json");
    yield* fs.makeDirectory(path.dirname(catalogPath), { recursive: true });
    const readCatalog = fs.readFileString(catalogPath);
    return {
      store,
      profiles,
      nativeDecrypt,
      nativeEncrypt,
      readCatalog,
      replaceCatalog: (document: string) => fs.writeFileString(catalogPath, document),
      readWithKey: (key: Buffer) =>
        readCatalog.pipe(
          Effect.map((document) =>
            open(Buffer.from(JSON.parse(document).encryptedCatalog, "base64"), key),
          ),
        ),
    };
  });

describe("Windows catalog key recovery", () => {
  it.effect.each([
    { owner: "t3code", key: stableKey },
    { owner: "T3 Code (Alpha)", key: alphaKey },
  ])(
    "recovers $owner after native decryption fails without changing profile keys or tokens",
    ({ owner, key }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* cryptoStore();
        // Alpha must remain usable when the stable profile key cannot be read.
        if (owner === "T3 Code (Alpha)") {
          const stable = fixture.profiles.find((profile) => profile.name === "t3code")!;
          legacyKeys.delete(stable.statePath);
        }
        keyReads.mockImplementation(() =>
          Effect.sync(() => assert.isAbove(fixture.nativeDecrypt.mock.calls.length, 0)),
        );
        const initial = encryptedDocument(seal("saved connections", key));
        yield* fixture.replaceCatalog(initial);
        assert.deepStrictEqual(yield* fixture.store.get, Option.some("saved connections"));
        assert.equal(yield* fixture.readCatalog, initial);
        assert.isTrue(yield* fixture.store.set("updated connections"));
        assert.equal(yield* fixture.readWithKey(key), "updated connections");
        for (const profile of fixture.profiles) {
          assert.equal(yield* fs.readFileString(profile.statePath), profile.state);
          assert.deepStrictEqual(
            yield* fs.readFile(profile.tokenPath),
            new Uint8Array(profile.token),
          );
          assert.equal(
            open(yield* fs.readFile(profile.tokenPath), profile.key),
            `${profile.name} token`,
          );
        }
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("bounds stalled key lookups, continues recovery, and caches timed-out candidates", () =>
    Effect.gen(function* () {
      const fixture = yield* cryptoStore();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      keyReads.mockImplementation((path) =>
        path.includes("T3 Code (Alpha)")
          ? Effect.void
          : Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
      );
      yield* fixture.replaceCatalog(encryptedDocument(seal("Alpha connections", alphaKey)));
      const recovery = yield* fixture.store.get.pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      // Assert before joining so a missing deadline fails without waiting on the stalled fiber.
      assert.isTrue(yield* Deferred.isDone(interrupted));
      assert.deepStrictEqual(yield* Fiber.join(recovery), Option.some("Alpha connections"));
      assert.isTrue(yield* fixture.store.set("updated Alpha connections"));
      assert.equal(yield* fixture.readWithKey(alphaKey), "updated Alpha connections");
      assert.equal(keyReads.mock.calls.length, 2);

      const allStalled = yield* cryptoStore();
      const candidates = yield* Effect.forEach(allStalled.profiles.slice(0, 2), ({ statePath }) =>
        Effect.gen(function* () {
          return {
            statePath,
            started: yield* Deferred.make<void>(),
            interrupted: yield* Deferred.make<void>(),
          };
        }),
      );
      keyReads.mockImplementation((path) => {
        const candidate = candidates.find(({ statePath }) => path === statePath)!;
        return Deferred.succeed(candidate.started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(candidate.interrupted, undefined)),
        );
      });
      const nativeError = new ElectronSafeStorage.ElectronSafeStorageDecryptError({
        cause: new Error("native catalog key does not match"),
      });
      allStalled.nativeDecrypt.mockReturnValue(Effect.fail(nativeError));
      const initial = encryptedDocument(seal("unavailable connections", stableKey));
      yield* allStalled.replaceCatalog(initial);
      const failed = yield* allStalled.store.get.pipe(Effect.flip, Effect.forkChild);
      for (const candidate of candidates) {
        yield* Deferred.await(candidate.started);
        yield* TestClock.adjust("10 seconds");
        assert.isTrue(yield* Deferred.isDone(candidate.interrupted));
      }
      assert.strictEqual((yield* Fiber.join(failed)).cause, nativeError);
      assert.strictEqual((yield* allStalled.store.get.pipe(Effect.flip)).cause, nativeError);
      assert.strictEqual(
        (yield* allStalled.store.set("must not overwrite").pipe(Effect.flip)).cause,
        nativeError,
      );
      assert.equal(yield* allStalled.readCatalog, initial);
      assert.equal(keyReads.mock.calls.length, 4);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("authenticates writes before any read and follows a replacement catalog key", () =>
    Effect.gen(function* () {
      const fixture = yield* cryptoStore();
      yield* fixture.replaceCatalog(encryptedDocument(seal("stable connections", stableKey)));
      assert.isTrue(yield* fixture.store.set("first write"));
      assert.equal(yield* fixture.readWithKey(stableKey), "first write");
      yield* fixture.replaceCatalog(encryptedDocument(seal("Alpha connections", alphaKey)));
      assert.isTrue(yield* fixture.store.set("after replacement"));
      assert.equal(yield* fixture.readWithKey(alphaKey), "after replacement");
      assert.deepStrictEqual(yield* fixture.store.get, Option.some("after replacement"));

      yield* fixture.replaceCatalog(encryptedDocument(seal("native connections", currentKey)));
      assert.isTrue(yield* fixture.store.set("native update"));
      assert.equal(yield* fixture.readWithKey(currentKey), "native update");
      assert.deepStrictEqual(yield* fixture.store.get, Option.some("native update"));
      assert.equal(fixture.nativeEncrypt.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "rejects unreadable catalogs and refuses to overwrite them after recovering a key",
    () =>
      Effect.gen(function* () {
        const fixture = yield* cryptoStore();
        yield* fixture.replaceCatalog(encryptedDocument(seal("saved connections", stableKey)));
        assert.deepStrictEqual(yield* fixture.store.get, Option.some("saved connections"));
        const tampered = seal("saved connections", stableKey);
        tampered.writeUInt8(tampered.readUInt8(tampered.length - 1) ^ 1, tampered.length - 1);
        const malformedHeader = seal("saved connections", stableKey);
        malformedHeader.writeUInt8(malformedHeader.readUInt8(0) | 0x80, 0);
        for (const [document, errorTag] of [
          ["{not-json", "DesktopConnectionCatalogStoreDocumentDecodeError"],
          [
            JSON.stringify({ version: 1, encryptedCatalog: "%%%" }),
            "DesktopConnectionCatalogStoreDecodeError",
          ],
          ...[
            Buffer.alloc(0),
            Buffer.from("v10short"),
            malformedHeader,
            seal("unknown key", Buffer.alloc(32, 9)),
            tampered,
          ].map(
            (encrypted) =>
              [
                encryptedDocument(encrypted),
                "DesktopConnectionCatalogStoreProtectionError",
              ] as const,
          ),
        ] as const) {
          yield* fixture.replaceCatalog(document);
          assert.equal((yield* fixture.store.get.pipe(Effect.flip))._tag, errorTag);
          assert.equal(
            (yield* fixture.store.set("must not overwrite").pipe(Effect.flip))._tag,
            errorTag,
          );
          assert.equal(yield* fixture.readCatalog, document);
        }
        assert.equal(fixture.nativeEncrypt.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("leaves native success and non-Windows failure handling unchanged", () =>
    Effect.gen(function* () {
      const windows = yield* cryptoStore();
      assert.isTrue(yield* windows.store.set("new native catalog"));
      assert.equal(yield* windows.readWithKey(currentKey), "new native catalog");
      assert.deepStrictEqual(yield* windows.store.get, Option.some("new native catalog"));
      assert.equal(keyReads.mock.calls.length, 0);

      const nonWindows = yield* cryptoStore("darwin");
      const initial = encryptedDocument(seal("legacy connections", stableKey));
      yield* nonWindows.replaceCatalog(initial);
      assert.equal(
        (yield* nonWindows.store.get.pipe(Effect.flip))._tag,
        "DesktopConnectionCatalogStoreProtectionError",
      );
      assert.equal(yield* nonWindows.readCatalog, initial);
      assert.isTrue(yield* nonWindows.store.set("native replacement"));
      assert.equal(yield* nonWindows.readWithKey(currentKey), "native replacement");
      assert.equal(keyReads.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
