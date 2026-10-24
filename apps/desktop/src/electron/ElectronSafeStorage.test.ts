import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { beforeEach, vi } from "vite-plus/test";

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  isAsyncEncryptionAvailable: vi.fn(),
  encryptStringAsync: vi.fn(),
  decryptStringAsync: vi.fn(),
  getSelectedStorageBackend: vi.fn(),
}));

vi.mock("electron", () => ({ safeStorage }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

describe("ElectronSafeStorage", () => {
  beforeEach(() => vi.resetAllMocks());

  it.effect("waits on the async keyring instead of blocking on a locked one", () =>
    Effect.gen(function* () {
      const ready = Promise.withResolvers<boolean>();
      // The sync API answers, but on Linux it blocks the main loop while a locked
      // keyring shows its unlock prompt, freezing the app at the splash screen.
      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      safeStorage.encryptString.mockImplementation((value: string) => Buffer.from(value));
      safeStorage.decryptString.mockImplementation((value: Buffer) => value.toString());
      safeStorage.isAsyncEncryptionAvailable.mockReturnValue(ready.promise);
      safeStorage.encryptStringAsync.mockImplementation(async (value: string) =>
        Buffer.from(`encrypted:${value}`),
      );
      safeStorage.decryptStringAsync.mockImplementation(async (value: Buffer) => {
        const encoded = value.toString();
        if (!encoded.startsWith("encrypted:")) throw new Error("invalid ciphertext");
        return { result: encoded.slice("encrypted:".length), shouldReEncrypt: false };
      });
      const storage = yield* ElectronSafeStorage.make;
      const availability = yield* storage.isEncryptionAvailable.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.isUndefined(availability.pollUnsafe(), "availability must wait for the keyring");
      ready.resolve(true);
      assert.isTrue(yield* Fiber.join(availability));

      const catalog = '{"schemaVersion":1,"targets":[]}';
      const encrypted = yield* storage.encryptString(catalog);
      assert.deepStrictEqual(encrypted, Buffer.from(`encrypted:${catalog}`));
      const padded = new Uint8Array(encrypted.length + 2);
      padded.set(encrypted, 1);
      assert.equal(yield* storage.decryptString(padded.subarray(1, -1)), catalog);

      assert.equal(safeStorage.isEncryptionAvailable.mock.calls.length, 0);
      assert.equal(safeStorage.encryptString.mock.calls.length, 0);
      assert.equal(safeStorage.decryptString.mock.calls.length, 0);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect(
    "does not store secrets through the async API on the plaintext basic_text backend",
    () =>
      Effect.gen(function* () {
        // Electron reports async encryption as available on basic_text even though
        // the sync API, which refuses that backend, reports it unavailable.
        safeStorage.getSelectedStorageBackend.mockReturnValue("basic_text");
        safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(true);
        safeStorage.isEncryptionAvailable.mockReturnValue(false);
        safeStorage.encryptString.mockImplementation(() => {
          throw new Error("Encryption is not available.");
        });
        safeStorage.decryptString.mockImplementation(() => {
          throw new Error("Decryption is not available.");
        });
        safeStorage.encryptStringAsync.mockResolvedValue(Buffer.from("ciphertext"));
        safeStorage.decryptStringAsync.mockResolvedValue({
          result: "secret",
          shouldReEncrypt: false,
        });
        const storage = yield* ElectronSafeStorage.make;
        assert.isFalse(yield* storage.isEncryptionAvailable);

        const encryptExit = yield* Effect.exit(storage.encryptString("secret"));
        const decryptExit = yield* Effect.exit(storage.decryptString(Buffer.from("ciphertext")));
        assert.isTrue(Exit.isFailure(encryptExit));
        assert.isTrue(Exit.isFailure(decryptExit));
        if (Exit.isFailure(encryptExit) && Exit.isFailure(decryptExit)) {
          assert.instanceOf(
            Option.getOrThrow(Cause.findErrorOption(encryptExit.cause)),
            ElectronSafeStorage.ElectronSafeStorageEncryptError,
          );
          assert.instanceOf(
            Option.getOrThrow(Cause.findErrorOption(decryptExit.cause)),
            ElectronSafeStorage.ElectronSafeStorageDecryptError,
          );
        }
        assert.equal(safeStorage.encryptStringAsync.mock.calls.length, 0);
        assert.equal(safeStorage.decryptStringAsync.mock.calls.length, 0);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect(
    "refuses v10 ciphertext the async API produces when the keyring provider falls back",
    () =>
      Effect.gen(function* () {
        // When the Freedesktop provider fails or is cancelled, Electron's async API
        // still reports gnome_libsecret but encrypts with the fixed "peanuts" POSIX key.
        safeStorage.getSelectedStorageBackend.mockReturnValue("gnome_libsecret");
        safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(true);
        safeStorage.isEncryptionAvailable.mockReturnValue(true);
        safeStorage.encryptStringAsync.mockResolvedValue(
          Buffer.concat([Buffer.from("v10"), Buffer.from("opaque")]),
        );
        const storage = yield* ElectronSafeStorage.make;

        const exit = yield* Effect.exit(storage.encryptString("secret"));
        assert.isTrue(
          Exit.isFailure(exit),
          "fallback ciphertext must not be returned as protected storage",
        );
        if (Exit.isFailure(exit)) {
          assert.instanceOf(
            Option.getOrThrow(Cause.findErrorOption(exit.cause)),
            ElectronSafeStorage.ElectronSafeStorageEncryptError,
          );
        }
        assert.equal(safeStorage.encryptString.mock.calls.length, 0);
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
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
      }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});
