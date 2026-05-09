import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

export class ElectronSafeStorageAvailabilityError extends Data.TaggedError(
  "ElectronSafeStorageAvailabilityError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Data.TaggedError(
  "ElectronSafeStorageEncryptError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Data.TaggedError(
  "ElectronSafeStorageDecryptError",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export interface ElectronSafeStorageShape {
  readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
  readonly encryptString: (
    value: string,
  ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
  readonly decryptString: (
    value: Uint8Array,
  ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
}

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  ElectronSafeStorageShape
>()("@t3tools/desktop/ElectronSafeStorage") {}

const make = ElectronSafeStorage.of({
  isEncryptionAvailable: Effect.try({
    try: () => Electron.safeStorage.isEncryptionAvailable(),
    catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
  }),
  encryptString: (value) =>
    Effect.try({
      try: () => Electron.safeStorage.encryptString(value),
      catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
    }),
  decryptString: (value) =>
    Effect.try({
      try: () => Electron.safeStorage.decryptString(Buffer.from(value)),
      catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
    }),
});

export const layer = Layer.succeed(ElectronSafeStorage, make);
