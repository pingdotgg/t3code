import { assert, describe, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const safeStorage = vi.hoisted(() => ({
  isAsyncEncryptionAvailable: vi.fn(),
  encryptStringAsync: vi.fn(),
  decryptStringAsync: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
}));

vi.mock("electron", () => ({ safeStorage }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

const withStorage = <A, E>(
  run: (storage: ElectronSafeStorage.ElectronSafeStorage["Service"]) => Effect.Effect<A, E>,
  platform: NodeJS.Platform = "win32",
) =>
  ElectronSafeStorage.make.pipe(
    Effect.flatMap(run),
    Effect.provideService(HostProcessPlatform, platform),
  );

describe("ElectronSafeStorage", () => {
  beforeEach(() => vi.resetAllMocks());

  it.effect("waits for the OS encryption provider to become available", () =>
    withStorage((storage) =>
      Effect.gen(function* () {
        const requested = Promise.withResolvers<void>();
        let resolveAvailability: (available: boolean) => void = () => {};
        let completed = false;
        safeStorage.isAsyncEncryptionAvailable.mockImplementation(
          () =>
            new Promise<boolean>((resolve) => {
              resolveAvailability = resolve;
              requested.resolve();
            }),
        );
        const pending = yield* storage.isEncryptionAvailable.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true;
            }),
          ),
          Effect.forkChild,
        );
        yield* Effect.promise(() => requested.promise);
        assert.isFalse(completed);
        resolveAvailability(true);
        assert.isTrue(yield* Fiber.join(pending));
        safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
        assert.isFalse(yield* storage.isEncryptionAvailable);
      }),
    ),
  );

  it.effect("round trips bytes through the asynchronous provider", () =>
    withStorage((storage) =>
      Effect.gen(function* () {
        const ciphertext = Buffer.from([0, 128, 255]);
        safeStorage.encryptStringAsync.mockResolvedValue(ciphertext);
        safeStorage.decryptStringAsync.mockResolvedValue({
          result: "catalog",
          shouldReEncrypt: false,
        });
        const encrypted = yield* storage.encryptString("catalog");
        assert.deepStrictEqual(encrypted, ciphertext);
        assert.equal(yield* storage.decryptString(encrypted), "catalog");
      }),
    ),
  );

  it.effect("decrypts only the supplied Uint8Array view", () =>
    withStorage((storage) =>
      Effect.gen(function* () {
        safeStorage.decryptStringAsync.mockImplementation(async (value: Buffer) => {
          assert.deepStrictEqual(value, Buffer.from([128, 255]));
          return { result: "catalog", shouldReEncrypt: true };
        });
        assert.equal(
          yield* storage.decryptString(new Uint8Array([1, 128, 255, 2]).subarray(1, 3)),
          "catalog",
        );
      }),
    ),
  );

  it.effect("preserves rejected provider errors as typed failures", () =>
    withStorage((storage) =>
      Effect.gen(function* () {
        const cause = new Error("provider unavailable");
        safeStorage.isAsyncEncryptionAvailable.mockRejectedValue(cause);
        safeStorage.encryptStringAsync.mockRejectedValue(cause);
        safeStorage.decryptStringAsync.mockRejectedValue(cause);
        const availability = yield* storage.isEncryptionAvailable.pipe(Effect.flip);
        const encrypt = yield* storage.encryptString("catalog").pipe(Effect.flip);
        const decrypt = yield* storage.decryptString(new Uint8Array()).pipe(Effect.flip);
        assert.instanceOf(availability, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
        assert.instanceOf(encrypt, ElectronSafeStorage.ElectronSafeStorageEncryptError);
        assert.instanceOf(decrypt, ElectronSafeStorage.ElectronSafeStorageDecryptError);
        assert.strictEqual(availability.cause, cause);
        assert.strictEqual(encrypt.cause, cause);
        assert.strictEqual(decrypt.cause, cause);
      }),
    ),
  );

  it.effect("keeps backend discovery limited to Linux", () =>
    Effect.gen(function* () {
      safeStorage.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
      assert.deepStrictEqual(
        yield* withStorage((storage) => storage.selectedStorageBackend),
        Option.none(),
      );
      assert.deepStrictEqual(
        yield* withStorage((storage) => storage.selectedStorageBackend, "linux"),
        Option.some("gnome_libsecret"),
      );
    }),
  );
});
