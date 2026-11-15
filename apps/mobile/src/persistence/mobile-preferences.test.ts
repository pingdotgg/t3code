import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({}));

import * as MobilePreferences from "./mobile-preferences";
import { MobileDatabase, type StoredPreferencesJson } from "./mobile-database";
import { MobileSecureStorage } from "./mobile-secure-storage";

describe("ignored command prefix persistence", () => {
  it.effect("keeps the list across reloads and resets without losing other preferences", () =>
    Effect.gen(function* () {
      let stored: Option.Option<StoredPreferencesJson> = Option.some({
        payload: JSON.stringify({ baseFontSize: 18 }),
        updatedAt: 1,
      });
      const unexpectedCacheAccess = () => Effect.die("Unexpected cache access");
      const database = MobileDatabase.of({
        loadCache: unexpectedCacheAccess,
        listCache: unexpectedCacheAccess,
        saveCache: unexpectedCacheAccess,
        removeCache: unexpectedCacheAccess,
        clearCacheKind: unexpectedCacheAccess,
        clearEnvironmentCache: unexpectedCacheAccess,
        clearAllCaches: unexpectedCacheAccess(),
        inspectCaches: unexpectedCacheAccess(),
        loadPreferencesJson: Effect.sync(() => stored),
        savePreferencesJson: (payload, updatedAt) =>
          Effect.sync(() => {
            stored = Option.some({ payload, updatedAt });
          }),
      });
      const makeStore = MobilePreferences.MobilePreferencesStore.pipe(
        Effect.provide(MobilePreferences.layer),
        Effect.provideService(MobileDatabase, database),
        Effect.provideService(MobileSecureStorage, {
          getItem: () => Effect.succeed(null),
          setItem: () => Effect.void,
          removeItem: () => Effect.void,
        }),
      );
      const store = yield* makeStore;
      expect(yield* store.load).toEqual({ baseFontSize: 18 });
      yield* store.savePatch({ ignoredCommandPrefixes: ["rtk", "rtk proxy"] });
      const restored = yield* makeStore;
      expect(yield* restored.load).toEqual({
        baseFontSize: 18,
        ignoredCommandPrefixes: ["rtk", "rtk proxy"],
      });
      yield* restored.savePatch({ ignoredCommandPrefixes: [] });
      const reset = yield* makeStore;
      expect(yield* reset.load).toEqual({ baseFontSize: 18, ignoredCommandPrefixes: [] });

      for (const ignoredCommandPrefixes of ["rtk", [42], [""], null]) {
        stored = Option.some({
          payload: JSON.stringify({ baseFontSize: 18, ignoredCommandPrefixes }),
          updatedAt: 2,
        });
        const invalid = yield* makeStore;
        expect(yield* invalid.load).toEqual({ baseFontSize: 18 });
      }
    }),
  );
});
