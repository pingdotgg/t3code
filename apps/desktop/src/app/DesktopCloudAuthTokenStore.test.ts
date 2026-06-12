import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopCloudAuthTokenStore from "./DesktopCloudAuthTokenStore.ts";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function makeSafeStorageLayer(input: { readonly available: boolean }) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable: Effect.succeed(input.available),
    encryptString: (value) => Effect.succeed(textEncoder.encode(`enc:${value}`)),
    decryptString: (value) => {
      const decoded = textDecoder.decode(value);
      if (!decoded.startsWith("enc:")) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid encrypted token"),
          }),
        );
      }
      return Effect.succeed(decoded.slice("enc:".length));
    },
  } satisfies ElectronSafeStorage.ElectronSafeStorageShape);
}

function makeLayer(baseDir: string, input?: { readonly encryptionAvailable?: boolean }) {
  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
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

  return DesktopCloudAuthTokenStore.layer.pipe(
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(makeSafeStorageLayer({ available: input?.encryptionAvailable ?? true })),
    Layer.provideMerge(NodeServices.layer),
  );
}

const withTokenStore = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopCloudAuthTokenStore.DesktopCloudAuthTokenStore>,
  input?: { readonly encryptionAvailable?: boolean },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-cloud-auth-token-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, input)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopCloudAuthTokenStore", () => {
  it.effect("persists, reads, and clears the encrypted Clerk client JWT", () =>
    withTokenStore(
      Effect.gen(function* () {
        const tokenStore = yield* DesktopCloudAuthTokenStore.DesktopCloudAuthTokenStore;

        assert.isTrue(yield* tokenStore.set("__client=test.jwt"));
        assert.deepStrictEqual(yield* tokenStore.get, Option.some("__client=test.jwt"));

        yield* tokenStore.clear;
        assert.deepStrictEqual(yield* tokenStore.get, Option.none());
      }),
    ),
  );

  it.effect("does not persist a token when Electron safe storage is unavailable", () =>
    withTokenStore(
      Effect.gen(function* () {
        const tokenStore = yield* DesktopCloudAuthTokenStore.DesktopCloudAuthTokenStore;

        assert.isFalse(yield* tokenStore.set("__client=test.jwt"));
        assert.deepStrictEqual(yield* tokenStore.get, Option.none());
      }),
      { encryptionAvailable: false },
    ),
  );
});
