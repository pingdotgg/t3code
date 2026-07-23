import type { DesktopRendererStateKey, LocalApi } from "@t3tools/contracts";

import { ensureLocalApi } from "./localApi";
import { createMemoryStorage, resolveStorage, type StateStorage } from "./lib/storage";

type RendererStatePersistence = Pick<
  LocalApi["persistence"],
  "getRendererState" | "setRendererState"
>;

export interface HydrationGuardedRendererStateStorage {
  readonly storage: StateStorage;
  readonly requiresExplicitHydration: boolean;
  readonly enableWrites: () => void;
  readonly seedHydratedValue: (name: string, value: string) => unknown;
  readonly writesEnabled: () => boolean;
}

export function createHydrationGuardedRendererStateStorage(input: {
  readonly key: DesktopRendererStateKey;
  readonly browserStorage: StateStorage;
  readonly desktopPersistence?: RendererStatePersistence;
}): HydrationGuardedRendererStateStorage {
  const browserStorage = resolveStorage(input.browserStorage);
  const desktopPersistence = input.desktopPersistence;
  let writesEnabled = desktopPersistence === undefined;

  return {
    requiresExplicitHydration: desktopPersistence !== undefined,
    enableWrites: () => {
      writesEnabled = true;
    },
    seedHydratedValue: (name, value) =>
      desktopPersistence === undefined
        ? browserStorage.setItem(name, value)
        : desktopPersistence.setRendererState(input.key, value),
    writesEnabled: () => writesEnabled,
    storage:
      desktopPersistence === undefined
        ? browserStorage
        : {
            getItem: () => desktopPersistence.getRendererState(input.key),
            setItem: (_name, value) => {
              if (!writesEnabled) {
                return Promise.resolve();
              }
              return desktopPersistence.setRendererState(input.key, value).catch((error) => {
                console.error(`[RENDERER_STATE] ${input.key} persistence failed.`, error);
              });
            },
            removeItem: () => {
              if (!writesEnabled) {
                return Promise.resolve();
              }
              return desktopPersistence.setRendererState(input.key, null).catch((error) => {
                console.error(`[RENDERER_STATE] ${input.key} removal failed.`, error);
              });
            },
          },
  };
}

export function createAppRendererStateStorage(
  key: DesktopRendererStateKey,
): HydrationGuardedRendererStateStorage {
  const memoryStorage = createMemoryStorage();
  const browserStorage: StateStorage = {
    getItem: (name) =>
      typeof localStorage === "undefined"
        ? memoryStorage.getItem(name)
        : localStorage.getItem(name),
    setItem: (name, value) =>
      typeof localStorage === "undefined"
        ? memoryStorage.setItem(name, value)
        : localStorage.setItem(name, value),
    removeItem: (name) =>
      typeof localStorage === "undefined"
        ? memoryStorage.removeItem(name)
        : localStorage.removeItem(name),
  };
  const desktopPersistence =
    typeof window !== "undefined" && window.desktopBridge
      ? ensureLocalApi().persistence
      : undefined;

  return createHydrationGuardedRendererStateStorage({
    key,
    browserStorage,
    ...(desktopPersistence ? { desktopPersistence } : {}),
  });
}
