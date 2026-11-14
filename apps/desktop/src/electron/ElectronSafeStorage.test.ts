import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

const safeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  encryptStringAsync: vi.fn(),
  decryptStringAsync: vi.fn(),
}));

vi.mock("electron", () => ({ safeStorage }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

it.effect("waits for a locked Linux keyring without calling the blocking sync API", () =>
  Effect.gen(function* () {
    vi.resetAllMocks();
    const unlocked = Promise.withResolvers<void>();
    safeStorage.encryptStringAsync.mockImplementation(async (value: string) => {
      await unlocked.promise;
      // Chromium encrypts empty plaintext to an empty buffer, with no version prefix.
      return value === "" ? Buffer.alloc(0) : Buffer.from(`v11${value}`);
    });
    safeStorage.decryptStringAsync.mockImplementation(async (value: Buffer) => ({
      result: value.subarray(3).toString(),
      shouldReEncrypt: false,
    }));
    const storage = yield* ElectronSafeStorage.make;

    const availability = yield* Effect.forkChild(storage.isEncryptionAvailable, {
      startImmediately: true,
    });
    assert.isUndefined(availability.pollUnsafe());
    unlocked.resolve();
    assert.isTrue(yield* Fiber.join(availability));
    const encrypted = yield* storage.encryptString("secret");
    assert.equal(yield* storage.decryptString(encrypted), "secret");

    assert.equal(safeStorage.isEncryptionAvailable.mock.calls.length, 0);
    assert.equal(safeStorage.encryptString.mock.calls.length, 0);
    assert.equal(safeStorage.decryptString.mock.calls.length, 0);
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);

it.effect("refuses the fixed-key fallback when no Linux keyring key is available", () =>
  Effect.gen(function* () {
    vi.resetAllMocks();
    safeStorage.encryptStringAsync.mockImplementation(async (value: string) =>
      Buffer.from(`v10${value}`),
    );
    const storage = yield* ElectronSafeStorage.make;

    assert.isFalse(yield* storage.isEncryptionAvailable);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(storage.encryptString("secret"))));
  }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
);
