import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { assert, describe, it } from "@effect/vitest";
import { beforeEach, vi } from "vite-plus/test";

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const { storage } = vi.hoisted(() => ({
  storage: {
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    isAsyncEncryptionAvailable: vi.fn<() => Promise<boolean>>(),
    encryptStringAsync: vi.fn<(value: string) => Promise<Buffer>>(),
    decryptStringAsync:
      vi.fn<(value: Buffer) => Promise<{ result: string; shouldReEncrypt: boolean }>>(),
    getSelectedStorageBackend: vi.fn(),
  },
}));

vi.mock("electron", () => ({ safeStorage: storage }));

const withStorage = <A, E>(
  platform: NodeJS.Platform,
  use: (storage: ElectronSafeStorage.ElectronSafeStorage["Service"]) => Effect.Effect<A, E>,
) =>
  ElectronSafeStorage.make.pipe(
    Effect.flatMap(use),
    Effect.provideService(HostProcess.Platform, platform),
  );

beforeEach(() => vi.resetAllMocks());

describe("macOS safe storage", () => {
  it.effect("yields while native Keychain operations are pending", () =>
    withStorage("darwin", (safeStorage) =>
      Effect.gen(function* () {
        const encrypted = Buffer.from([0, 128, 255]);
        const availability = Promise.withResolvers<boolean>();
        const encryption = Promise.withResolvers<Buffer>();
        const decryption = Promise.withResolvers<{ result: string; shouldReEncrypt: boolean }>();
        const availabilityStarted = Promise.withResolvers<void>();
        const encryptionStarted = Promise.withResolvers<void>();
        const decryptionStarted = Promise.withResolvers<void>();
        storage.isAsyncEncryptionAvailable.mockImplementation(() => {
          availabilityStarted.resolve();
          return availability.promise;
        });
        storage.encryptStringAsync.mockImplementation(() => {
          encryptionStarted.resolve();
          return encryption.promise;
        });
        storage.decryptStringAsync.mockImplementation(() => {
          decryptionStarted.resolve();
          return decryption.promise;
        });
        let completed = false;
        const work = yield* Effect.forkChild(
          Effect.all(
            [
              safeStorage.isEncryptionAvailable,
              safeStorage.encryptString("secret"),
              safeStorage.decryptString(new Uint8Array(encrypted)),
            ],
            { concurrency: "unbounded" },
          ).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
        );

        yield* Effect.promise(() =>
          Promise.all([
            availabilityStarted.promise,
            encryptionStarted.promise,
            decryptionStarted.promise,
          ]),
        );
        assert.lengthOf(storage.isAsyncEncryptionAvailable.mock.calls, 1);
        assert.deepEqual(storage.encryptStringAsync.mock.calls, [["secret"]]);
        assert.deepEqual(storage.decryptStringAsync.mock.calls, [[encrypted]]);
        assert.isTrue(Buffer.isBuffer(storage.decryptStringAsync.mock.calls[0]?.[0]));
        assert.isFalse(completed);
        availability.resolve(true);
        encryption.resolve(encrypted);
        decryption.resolve({ result: "secret", shouldReEncrypt: true });
        assert.deepEqual(yield* Fiber.join(work), [true, encrypted, "secret"]);
        assert.isEmpty([
          ...storage.isEncryptionAvailable.mock.calls,
          ...storage.encryptString.mock.calls,
          ...storage.decryptString.mock.calls,
        ]);
      }),
    ),
  );

  it.effect("preserves typed errors and causes from native promise rejections", () =>
    withStorage("darwin", (safeStorage) =>
      Effect.gen(function* () {
        const cause = new Error("Keychain denied access");
        storage.isAsyncEncryptionAvailable.mockRejectedValue(cause);
        storage.encryptStringAsync.mockRejectedValue(cause);
        storage.decryptStringAsync.mockRejectedValue(cause);
        const errors = yield* Effect.all([
          Effect.flip(safeStorage.isEncryptionAvailable),
          Effect.flip(safeStorage.encryptString("secret")),
          Effect.flip(safeStorage.decryptString(new Uint8Array([1]))),
        ]);
        assert.instanceOf(errors[0], ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
        assert.instanceOf(errors[1], ElectronSafeStorage.ElectronSafeStorageEncryptError);
        assert.instanceOf(errors[2], ElectronSafeStorage.ElectronSafeStorageDecryptError);
        for (const error of errors) assert.strictEqual(error.cause, cause);
      }),
    ),
  );
});

describe.each(["linux", "win32"] as const)("%s safe storage", (platform) => {
  it.effect("keeps using the existing synchronous backend", () =>
    withStorage(platform, (safeStorage) =>
      Effect.gen(function* () {
        const encrypted = Buffer.from([0, 128, 255]);
        storage.isEncryptionAvailable.mockReturnValue(true);
        storage.encryptString.mockReturnValue(encrypted);
        storage.decryptString.mockReturnValue("secret");
        storage.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");

        assert.isTrue(yield* safeStorage.isEncryptionAvailable);
        assert.deepEqual(yield* safeStorage.encryptString("secret"), encrypted);
        assert.equal(yield* safeStorage.decryptString(new Uint8Array(encrypted)), "secret");
        assert.deepEqual(
          yield* safeStorage.selectedStorageBackend,
          platform === "linux" ? Option.some("gnome_libsecret") : Option.none(),
        );
        assert.lengthOf(storage.isAsyncEncryptionAvailable.mock.calls, 0);
        assert.lengthOf(storage.encryptStringAsync.mock.calls, 0);
        assert.lengthOf(storage.decryptStringAsync.mock.calls, 0);
      }),
    ),
  );
});
