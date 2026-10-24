import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { beforeEach, vi } from "vite-plus/test";

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  isAsyncEncryptionAvailable: vi.fn(),
  encryptStringAsync: vi.fn(),
  decryptStringAsync: vi.fn(),
}));

vi.mock("electron", () => ({ safeStorage }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

describe("ElectronSafeStorage", () => {
  beforeEach(() => vi.resetAllMocks());

  it.effect("waits for provider readiness and round trips an encrypted catalog", () =>
    Effect.gen(function* () {
      const ready = Promise.withResolvers<boolean>();
      // Windows can report synchronous storage unavailable while the async provider starts.
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      safeStorage.isAsyncEncryptionAvailable.mockReturnValue(ready.promise);
      safeStorage.encryptStringAsync.mockImplementation(async (value: string) =>
        Buffer.from(`encrypted:${value}`),
      );
      safeStorage.decryptStringAsync.mockImplementation(async (value: Buffer) => {
        const encoded = value.toString();
        if (!encoded.startsWith("encrypted:")) throw new Error("invalid ciphertext");
        return { result: encoded.slice("encrypted:".length), shouldReEncrypt: true };
      });
      const storage = yield* ElectronSafeStorage.make;
      const availability = yield* storage.isEncryptionAvailable.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.isUndefined(availability.pollUnsafe());
      ready.resolve(true);
      assert.isTrue(yield* Fiber.join(availability));

      const catalog = '{"schemaVersion":1,"targets":[]}';
      const encrypted = yield* storage.encryptString(catalog);
      assert.deepStrictEqual(encrypted, Buffer.from(`encrypted:${catalog}`));
      const padded = new Uint8Array(encrypted.length + 2);
      padded.set(encrypted, 1);
      assert.equal(yield* storage.decryptString(padded.subarray(1, -1)), catalog);

      safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
      assert.isFalse(yield* storage.isEncryptionAvailable);
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.effect.each(["unavailable", "rejected"] as const)(
    "round trips an encrypted catalog with synchronous storage when async availability is %s",
    (availability) =>
      Effect.gen(function* () {
        safeStorage.isEncryptionAvailable.mockReturnValue(true);
        if (availability === "unavailable") {
          safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
        } else {
          safeStorage.isAsyncEncryptionAvailable.mockRejectedValue(
            new Error("provider unavailable"),
          );
        }
        safeStorage.encryptString.mockImplementation((value: string) =>
          Buffer.from(`encrypted:${value}`),
        );
        safeStorage.decryptString.mockImplementation((value: Buffer) => {
          const encoded = value.toString();
          if (!encoded.startsWith("encrypted:")) throw new Error("invalid ciphertext");
          return encoded.slice("encrypted:".length);
        });
        const storage = yield* ElectronSafeStorage.make;
        assert.isTrue(yield* storage.isEncryptionAvailable);

        const catalog = '{"schemaVersion":1,"targets":[]}';
        const encrypted = yield* storage.encryptString(catalog);
        assert.deepStrictEqual(encrypted, Buffer.from(`encrypted:${catalog}`));
        assert.equal(yield* storage.decryptString(encrypted), catalog);
      }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );

  it.effect("preserves rejected provider errors as typed failures", () =>
    Effect.gen(function* () {
      const cause = new Error("provider unavailable");
      safeStorage.isAsyncEncryptionAvailable.mockRejectedValue(cause);
      safeStorage.encryptStringAsync.mockRejectedValue(cause);
      safeStorage.decryptStringAsync.mockRejectedValue(cause);
      const storage = yield* ElectronSafeStorage.make;
      const availability = yield* storage.isEncryptionAvailable.pipe(Effect.flip);
      const encrypt = yield* storage.encryptString("catalog").pipe(Effect.flip);
      const decrypt = yield* storage.decryptString(new Uint8Array()).pipe(Effect.flip);
      assert.instanceOf(availability, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);
      assert.instanceOf(encrypt, ElectronSafeStorage.ElectronSafeStorageEncryptError);
      assert.instanceOf(decrypt, ElectronSafeStorage.ElectronSafeStorageDecryptError);
      assert.strictEqual(availability.cause, cause);
      assert.strictEqual(encrypt.cause, cause);
      assert.strictEqual(decrypt.cause, cause);
    }).pipe(Effect.provideService(HostProcess.Platform, "win32")),
  );
});
