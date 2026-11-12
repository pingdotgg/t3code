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

// Linux keyring keys tag ciphertext "v11". Without a usable keyring the async encryptor
// silently falls back to Chromium's fixed "v10" key, which protects nothing. Empty
// plaintext encrypts to an empty buffer, so availability probes with a nonempty string.
const LINUX_KEYRING_CIPHERTEXT_PREFIX = Buffer.from("v11");

const isLinuxKeyringCiphertext = (ciphertext: Buffer) =>
  ciphertext
    .subarray(0, LINUX_KEYRING_CIPHERTEXT_PREFIX.length)
    .equals(LINUX_KEYRING_CIPHERTEXT_PREFIX);

// The sync API blocks the Linux main loop while a locked keyring waits to be unlocked.
const makeLinux = () => ({
  isEncryptionAvailable: Effect.tryPromise({
    try: async () =>
      isLinuxKeyringCiphertext(await Electron.safeStorage.encryptStringAsync("probe")),
    catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
  }),
  encryptString: Effect.fn("ElectronSafeStorage.encryptString")(function (value: string) {
    return Effect.tryPromise({
      try: async () => {
        const encrypted = await Electron.safeStorage.encryptStringAsync(value);
        if (!isLinuxKeyringCiphertext(encrypted)) {
          throw new Error("No keyring key is available to encrypt with.");
        }
        return encrypted;
      },
      catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
    });
  }),
  decryptString: Effect.fn("ElectronSafeStorage.decryptString")(function (value: Uint8Array) {
    return Effect.tryPromise({
      try: async () => (await Electron.safeStorage.decryptStringAsync(Buffer.from(value))).result,
      catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
    });
  }),
});

const makeSync = () => ({
  isEncryptionAvailable: Effect.try({
    try: () => Electron.safeStorage.isEncryptionAvailable(),
    catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
  }),
  encryptString: Effect.fn("ElectronSafeStorage.encryptString")(function (value: string) {
    return Effect.try({
      try: () => Electron.safeStorage.encryptString(value),
      catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
    });
  }),
  decryptString: Effect.fn("ElectronSafeStorage.decryptString")(function (value: Uint8Array) {
    return Effect.try({
      try: () => Electron.safeStorage.decryptString(Buffer.from(value)),
      catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
    });
  }),
});

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;

  return ElectronSafeStorage.of({
    ...(platform === "linux" ? makeLinux() : makeSync()),
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
