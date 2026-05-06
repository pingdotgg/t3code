import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

import type { DesktopSecretStorage as ClientPersistenceSecretStorage } from "../clientPersistence.ts";

export interface ElectronSafeStorageShape extends ClientPersistenceSecretStorage {}

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  ElectronSafeStorageShape
>()("@t3tools/desktop/ElectronSafeStorage") {}

const make = ElectronSafeStorage.of({
  isEncryptionAvailable: () => Electron.safeStorage.isEncryptionAvailable(),
  encryptString: (value) => Electron.safeStorage.encryptString(value),
  decryptString: (value) => Electron.safeStorage.decryptString(value),
});

export const layer = Layer.succeed(ElectronSafeStorage, make);
