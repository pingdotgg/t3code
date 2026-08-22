import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopLocalEnvironmentAuthTokenStore from "./DesktopLocalEnvironmentAuthTokenStore.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface SafeStorageOptions {
  readonly encryptionAvailable?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly storageBackend?: string;
  readonly encryptions?: Ref.Ref<number>;
  readonly decryptions?: Ref.Ref<number>;
}

function makeLayer(baseDir: string, options: SafeStorageOptions = {}) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: options.platform ?? "darwin",
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
  const safeStorageLayer = Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(options.encryptionAvailable ?? true),
    encryptString: (value) =>
      Effect.gen(function* () {
        if (options.encryptions !== undefined) {
          yield* Ref.update(options.encryptions, (count) => count + 1);
        }
        return textEncoder.encode(`encrypted:${value}`);
      }),
    decryptString: (value) =>
      Effect.gen(function* () {
        if (options.decryptions !== undefined) {
          yield* Ref.update(options.decryptions, (count) => count + 1);
        }
        const decoded = textDecoder.decode(value);
        if (!decoded.startsWith("encrypted:")) {
          return yield* new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("token was not encrypted"),
          });
        }
        return decoded.slice("encrypted:".length);
      }),
    selectedStorageBackend: Effect.succeed(
      options.platform === "linux"
        ? Option.some(options.storageBackend ?? "unknown")
        : Option.none(),
    ),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);

  return DesktopLocalEnvironmentAuthTokenStore.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(safeStorageLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withStore = <A, E, R>(
  run: (
    baseDir: string,
  ) => Effect.Effect<
    A,
    E,
    R | DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore
  >,
  options: SafeStorageOptions = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-local-auth-test-",
    });
    return yield* run(baseDir).pipe(Effect.provide(makeLayer(baseDir, options)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopLocalEnvironmentAuthTokenStore", () => {
  it.effect("persists, reads, and clears an encrypted bearer token", () =>
    Effect.gen(function* () {
      const encryptions = yield* Ref.make(0);
      const decryptions = yield* Ref.make(0);

      yield* withStore(
        (baseDir) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const tokenPath = path.join(baseDir, "userdata", "desktop-local-auth.json");
            const store =
              yield* DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore;

            assert.deepStrictEqual(yield* store.get, Option.none());
            assert.isTrue(yield* store.set("desktop-bearer-token"));
            assert.isTrue(yield* fileSystem.exists(tokenPath));
            const persistedDocument = yield* fileSystem.readFileString(tokenPath);
            assert.notInclude(persistedDocument, "desktop-bearer-token");
            assert.deepStrictEqual(yield* store.get, Option.some("desktop-bearer-token"));
            assert.strictEqual(yield* Ref.get(encryptions), 1);
            assert.strictEqual(yield* Ref.get(decryptions), 1);
            yield* store.clear;
            assert.deepStrictEqual(yield* store.get, Option.none());
          }),
        { encryptions, decryptions },
      );
    }),
  );

  it.effect("does not write or encrypt a token when secure storage is unavailable", () =>
    Effect.gen(function* () {
      const encryptions = yield* Ref.make(0);

      yield* withStore(
        (baseDir) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const tokenPath = path.join(baseDir, "userdata", "desktop-local-auth.json");
            const store =
              yield* DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore;

            assert.isFalse(yield* store.set("desktop-bearer-token"));
            assert.isFalse(yield* fileSystem.exists(tokenPath));
            assert.strictEqual(yield* Ref.get(encryptions), 0);
          }),
        { encryptionAvailable: false, encryptions },
      );
    }),
  );

  it.effect("does not write or encrypt a token with Linux's basic_text storage backend", () =>
    Effect.gen(function* () {
      const encryptions = yield* Ref.make(0);

      yield* withStore(
        (baseDir) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const tokenPath = path.join(baseDir, "userdata", "desktop-local-auth.json");
            const store =
              yield* DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore;

            assert.isFalse(yield* store.set("desktop-bearer-token"));
            assert.isFalse(yield* fileSystem.exists(tokenPath));
            assert.strictEqual(yield* Ref.get(encryptions), 0);
          }),
        {
          platform: "linux",
          storageBackend: "basic_text",
          encryptions,
        },
      );
    }),
  );

  it.effect("does not decrypt an existing token with Linux's basic_text storage backend", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-local-auth-test-",
      });
      const decryptions = yield* Ref.make(0);
      const setToken =
        DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore.pipe(
          Effect.flatMap((store) => store.set("desktop-bearer-token")),
          Effect.provide(
            makeLayer(baseDir, {
              platform: "linux",
              storageBackend: "gnome_libsecret",
            }),
          ),
        );
      const getTokenWithBasicText =
        DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore.pipe(
          Effect.flatMap((store) => store.get),
          Effect.provide(
            makeLayer(baseDir, {
              platform: "linux",
              storageBackend: "basic_text",
              decryptions,
            }),
          ),
        );

      assert.isTrue(yield* setToken);
      assert.deepStrictEqual(yield* getTokenWithBasicText, Option.none());
      assert.strictEqual(yield* Ref.get(decryptions), 0);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("persists a token with a secure Linux storage backend", () =>
    withStore(
      () =>
        Effect.gen(function* () {
          const store =
            yield* DesktopLocalEnvironmentAuthTokenStore.DesktopLocalEnvironmentAuthTokenStore;

          assert.isTrue(yield* store.set("desktop-bearer-token"));
          assert.deepStrictEqual(yield* store.get, Option.some("desktop-bearer-token"));
        }),
      {
        platform: "linux",
        storageBackend: "gnome_libsecret",
      },
    ),
  );
});
