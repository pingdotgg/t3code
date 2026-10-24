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

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;

  // Match Clerk's async preference without losing storage on sync-only installations.
  const isAsyncEncryptionAvailable = async () => {
    try {
      return await Electron.safeStorage.isAsyncEncryptionAvailable();
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
        try: async () =>
          (await isAsyncEncryptionAvailable())
            ? Electron.safeStorage.encryptStringAsync(value)
            : Electron.safeStorage.encryptString(value),
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
