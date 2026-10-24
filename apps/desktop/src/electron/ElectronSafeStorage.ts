import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";

const electronSafeStorageErrorFields = {
  cause: Schema.Defect(),
};

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedError<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedError<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedError<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

// Chromium's v10 Linux prefix marks ciphertext under the fixed "peanuts" key. The async
// API falls back to it when the keyring provider fails or is cancelled, while still
// reporting the keyring backend, so it would store credentials effectively in plaintext.
const LINUX_FALLBACK_CIPHERTEXT_PREFIX = Buffer.from("v10");

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
    readonly encryptString: (
      value: string,
    ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
    readonly decryptString: (
      value: Uint8Array,
    ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
    readonly selectedStorageBackend: Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/electron/ElectronSafeStorage") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;

  // On Linux the sync API blocks the main loop while a locked keyring shows its
  // unlock prompt. Prefer the async API, falling back to sync where it is unavailable.
  const isAsyncEncryptionAvailable = async () => {
    try {
      const available = await Electron.safeStorage.isAsyncEncryptionAvailable();
      // The async API reports the plaintext basic_text backend as available, while
      // the sync API refuses it. Defer to the sync API there so credentials stay refused.
      return (
        available &&
        !(platform === "linux" && Electron.safeStorage.getSelectedStorageBackend() === "basic_text")
      );
    } catch (cause) {
      if (!Electron.safeStorage.isEncryptionAvailable()) {
        throw cause;
      }
      return false;
    }
  };

  return ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.tryPromise({
      try: async () =>
        (await isAsyncEncryptionAvailable()) || Electron.safeStorage.isEncryptionAvailable(),
      catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
    }),
    encryptString: (value) =>
      Effect.tryPromise({
        try: async () => {
          if (!(await isAsyncEncryptionAvailable())) {
            return Electron.safeStorage.encryptString(value);
          }
          const encrypted = await Electron.safeStorage.encryptStringAsync(value);
          if (
            platform === "linux" &&
            encrypted
              .subarray(0, LINUX_FALLBACK_CIPHERTEXT_PREFIX.length)
              .equals(LINUX_FALLBACK_CIPHERTEXT_PREFIX)
          ) {
            throw new Error("The keyring fell back to an insecure fixed encryption key.");
          }
          return encrypted;
        },
        catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
      }),
    decryptString: (value) =>
      Effect.tryPromise({
        try: async () =>
          (await isAsyncEncryptionAvailable())
            ? (await Electron.safeStorage.decryptStringAsync(Buffer.from(value))).result
            : Electron.safeStorage.decryptString(Buffer.from(value)),
        catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
      }),
    selectedStorageBackend: Effect.sync(() => {
      if (platform !== "linux") {
        return Option.none();
      }
      try {
        return Option.fromNullishOr(Electron.safeStorage.getSelectedStorageBackend());
      } catch {
        return Option.none();
      }
    }),
  });
});

export const layer = Layer.effect(ElectronSafeStorage, make);
