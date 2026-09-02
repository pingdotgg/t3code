import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach, vi } from "vite-plus/test";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

interface SafeStorageMock {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Uint8Array;
  decryptString: (value: Uint8Array) => string;
  getSelectedStorageBackend: () => string;
  encryptStringAsync?: (value: string) => Promise<Uint8Array>;
  decryptStringAsync?: (value: Uint8Array) => Promise<{ readonly result: string }>;
}

const { safeStorage } = vi.hoisted(() => ({
  safeStorage: {} as SafeStorageMock,
}));

vi.mock("electron", () => ({ safeStorage }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const ENCRYPTED_PREFIX = "encrypted:";

const blockingCalls = {
  isEncryptionAvailable: 0,
  encryptString: 0,
  decryptString: 0,
};

const makeLayer = (platform: "linux" | "darwin" = "linux") =>
  ElectronSafeStorage.layer.pipe(
    Layer.provide(Layer.succeed(HostProcessPlatform, platform)),
    Layer.provideMerge(TestClock.layer()),
  );

beforeEach(() => {
  blockingCalls.isEncryptionAvailable = 0;
  blockingCalls.encryptString = 0;
  blockingCalls.decryptString = 0;

  safeStorage.isEncryptionAvailable = () => {
    blockingCalls.isEncryptionAvailable += 1;
    return true;
  };
  safeStorage.encryptString = (value) => {
    blockingCalls.encryptString += 1;
    return textEncoder.encode(`${ENCRYPTED_PREFIX}${value}`);
  };
  safeStorage.decryptString = (value) => {
    blockingCalls.decryptString += 1;
    return textDecoder.decode(value).slice(ENCRYPTED_PREFIX.length);
  };
  safeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
  safeStorage.encryptStringAsync = (value) =>
    Promise.resolve(textEncoder.encode(`${ENCRYPTED_PREFIX}${value}`));
  safeStorage.decryptStringAsync = (value) =>
    Promise.resolve({ result: textDecoder.decode(value).slice(ENCRYPTED_PREFIX.length) });
});

describe("ElectronSafeStorage", () => {
  it.effect("encrypts and decrypts through the promise-based Electron calls", () =>
    Effect.gen(function* () {
      const safeStorageService = yield* ElectronSafeStorage.ElectronSafeStorage;

      const encrypted = yield* safeStorageService.encryptString("bearer-token");
      assert.equal(textDecoder.decode(encrypted), `${ENCRYPTED_PREFIX}bearer-token`);
      assert.equal(yield* safeStorageService.decryptString(encrypted), "bearer-token");
      assert.equal(blockingCalls.encryptString, 0);
      assert.equal(blockingCalls.decryptString, 0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("reports availability once the credential store hands over a key", () =>
    Effect.gen(function* () {
      const safeStorageService = yield* ElectronSafeStorage.ElectronSafeStorage;

      assert.isTrue(yield* safeStorageService.isEncryptionAvailable);
      assert.equal(blockingCalls.isEncryptionAvailable, 0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("gives up instead of waiting forever on a locked credential store", () =>
    Effect.gen(function* () {
      safeStorage.encryptStringAsync = () => new Promise<Uint8Array>(() => {});
      const safeStorageService = yield* ElectronSafeStorage.ElectronSafeStorage;

      const availability = yield* safeStorageService.isEncryptionAvailable.pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(30));

      assert.isFalse(yield* Fiber.join(availability));
    }).pipe(Effect.provide(makeLayer()), Effect.scoped),
  );

  it.effect("fails an encrypt that the credential store never answers", () =>
    Effect.gen(function* () {
      safeStorage.encryptStringAsync = () => new Promise<Uint8Array>(() => {});
      const safeStorageService = yield* ElectronSafeStorage.ElectronSafeStorage;

      const encrypting = yield* safeStorageService
        .encryptString("bearer-token")
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(30));

      const error = yield* Fiber.join(encrypting);
      assert.instanceOf(error, ElectronSafeStorage.ElectronSafeStorageEncryptError);
    }).pipe(Effect.provide(makeLayer()), Effect.scoped),
  );

  it.effect("treats the unprotected Linux backend as unavailable", () =>
    Effect.gen(function* () {
      safeStorage.getSelectedStorageBackend = () => "basic_text";
      let asyncEncryptCalls = 0;
      safeStorage.encryptStringAsync = (value) => {
        asyncEncryptCalls += 1;
        return Promise.resolve(textEncoder.encode(`${ENCRYPTED_PREFIX}${value}`));
      };
      const safeStorageService = yield* ElectronSafeStorage.ElectronSafeStorage;

      assert.isFalse(yield* safeStorageService.isEncryptionAvailable);
      assert.equal(asyncEncryptCalls, 0);
      assert.deepEqual(yield* safeStorageService.selectedStorageBackend, Option.some("basic_text"));
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("falls back to the blocking calls on runtimes without the async ones", () => {
    // Before the layer is built: the service picks its calls at construction.
    delete safeStorage.encryptStringAsync;
    delete safeStorage.decryptStringAsync;

    return Effect.gen(function* () {
      const safeStorageService = yield* ElectronSafeStorage.ElectronSafeStorage;

      assert.isTrue(yield* safeStorageService.isEncryptionAvailable);
      const encrypted = yield* safeStorageService.encryptString("bearer-token");
      assert.equal(yield* safeStorageService.decryptString(encrypted), "bearer-token");
      assert.equal(blockingCalls.isEncryptionAvailable, 1);
      assert.equal(blockingCalls.encryptString, 1);
      assert.equal(blockingCalls.decryptString, 1);
    }).pipe(Effect.provide(makeLayer()));
  });

  it.effect("reports no storage backend off Linux", () =>
    Effect.gen(function* () {
      const safeStorageService = yield* ElectronSafeStorage.ElectronSafeStorage;

      assert.deepEqual(yield* safeStorageService.selectedStorageBackend, Option.none());
    }).pipe(Effect.provide(makeLayer("darwin"))),
  );
});
