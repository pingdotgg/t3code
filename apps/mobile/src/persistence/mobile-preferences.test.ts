import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import * as MobileDatabase from "./mobile-database";
import * as MobilePreferences from "./mobile-preferences";
import * as MobileSecureStorage from "./mobile-secure-storage";

function storageLayer(stored: { json: Option.Option<MobileDatabase.StoredPreferencesJson> }) {
  const database = {
    loadPreferencesJson: Effect.sync(() => stored.json),
    savePreferencesJson: (payload: string, updatedAt: number) =>
      Effect.sync(() => {
        stored.json = Option.some({ payload, updatedAt });
      }),
  } as unknown as MobileDatabase.MobileDatabase["Service"];
  const secureStorage = MobileSecureStorage.MobileSecureStorage.of({
    getItem: () => Effect.succeed(null),
    setItem: () => Effect.void,
    removeItem: () => Effect.void,
  });
  return MobilePreferences.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(MobileDatabase.MobileDatabase, database),
        Layer.succeed(MobileSecureStorage.MobileSecureStorage, secureStorage),
      ),
    ),
  );
}

describe("mobile preferences store", () => {
  it.effect("restores collapsed and expanded model picker sections after a restart", () =>
    Effect.gen(function* () {
      const stored = { json: Option.none<MobileDatabase.StoredPreferencesJson>() };
      const sections = { '["work","codex"]': true, '["work","opencode"]': false };

      yield* MobilePreferences.MobilePreferencesStore.pipe(
        Effect.flatMap((store) => store.savePatch({ modelProviderSectionsCollapsed: sections })),
        Effect.provide(storageLayer(stored)),
      );
      const restored = yield* MobilePreferences.MobilePreferencesStore.pipe(
        Effect.flatMap((store) => store.load),
        Effect.provide(storageLayer(stored)),
      );

      expect(restored.modelProviderSectionsCollapsed).toEqual(sections);
    }),
  );
});
