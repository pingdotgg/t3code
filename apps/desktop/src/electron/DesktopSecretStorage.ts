import * as Context from "effect/Context";

import type { DesktopSecretStorage as ClientPersistenceSecretStorage } from "../clientPersistence.ts";

export interface DesktopSecretStorageShape extends ClientPersistenceSecretStorage {}

export class DesktopSecretStorage extends Context.Service<
  DesktopSecretStorage,
  DesktopSecretStorageShape
>()("@t3tools/desktop/DesktopSecretStorage") {}
